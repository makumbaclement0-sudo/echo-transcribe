"""Command line interface.

    python -m pmbot scan                 rank markets worth quoting
    python -m pmbot arb                  look for complete-set arbitrage right now
    python -m pmbot paper --minutes 60   paper-trade against live order books
    python -m pmbot backtest             Monte Carlo: when does market making pay?
    python -m pmbot audit 0xWALLET       verify someone's claimed bot performance
    python -m pmbot live                 real money (requires explicit opt-in)
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections import defaultdict

from pmbot.config import BotConfig
from pmbot.data import ClobPublicClient, GammaClient
from pmbot.models import Market


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")


def cmd_scan(args, cfg: BotConfig) -> int:
    from pmbot.scanner import filter_reasons, select_markets

    markets = GammaClient().active_markets(cfg.scanner.universe)
    picked = select_markets(markets, cfg.scanner)
    print(f"{len(markets)} active binary markets fetched; {len(picked)} selected for quoting\n")
    print(f"{'score':>6}  {'bid':>5} {'ask':>5}  {'vol24h':>10}  {'rew':>4}  {'fee':>5}  question")
    for s in picked:
        m = s.market
        rew = f"{m.rewards_max_spread_cents:.1f}" if m.rewards_max_spread_cents else "-"
        print(f"{s.score:6.2f}  {m.best_bid or 0:5.3f} {m.best_ask or 0:5.3f}  {m.volume_24h:10,.0f}  {rew:>4}  "
              f"{m.fees.rate:5.2f}  {m.label[:70]}")
    if args.why:
        print("\nTop rejected markets by volume and why:")
        rejected = sorted((m for m in markets if filter_reasons(m, cfg.scanner)), key=lambda m: -m.volume_24h)
        for m in rejected[: args.why]:
            print(f"  - {m.label[:60]:60s} {'; '.join(filter_reasons(m, cfg.scanner))}")
    return 0


def cmd_arb(args, cfg: BotConfig) -> int:
    from pmbot.strategies.complete_set import binary_arbs, negrisk_arbs

    gamma, clob = GammaClient(), ClobPublicClient()
    markets = gamma.active_markets(args.universe)
    tokens = [t for m in markets for t in (m.yes_token, m.no_token)]
    print(f"fetching {len(tokens)} order books for {len(markets)} markets...")
    books = clob.books(tokens)
    opps = []
    near_misses = []
    for m in markets:
        yes, no = books.get(m.yes_token), books.get(m.no_token)
        if yes and no:
            opps += binary_arbs(m, yes, no, cfg.arb.min_edge, cfg.arb.max_set_size)
            if yes.best_ask and no.best_ask:
                near_misses.append((yes.best_ask + no.best_ask, m.label))

    if cfg.arb.include_neg_risk_events:
        events: dict[str, list[Market]] = defaultdict(list)
        titles: dict[str, str] = {}
        for raw_event in gamma.events(limit=args.events):
            if not raw_event.get("negRisk"):
                continue
            ms = [Market.from_gamma(r) for r in raw_event.get("markets", [])]
            ms = [m for m in ms if m and m.accepting_orders]
            if len(ms) >= 2:
                events[str(raw_event["id"])] = ms
                titles[str(raw_event["id"])] = raw_event.get("title", "")
        need = [t for ms in events.values() for m in ms for t in (m.yes_token, m.no_token) if t not in books]
        books.update(clob.books(need))
        for eid, ms in events.items():
            opps += negrisk_arbs(titles[eid], ms, books, cfg.arb.min_edge, cfg.arb.max_set_size)
            asks = [books[m.yes_token].best_ask for m in ms if m.yes_token in books]
            if len(asks) == len(ms) and all(a is not None for a in asks):
                near_misses.append((sum(asks), f"[{len(ms)} outcomes] {titles[eid]}"))

    if opps:
        print(f"\n{len(opps)} opportunities (after taker fees, min edge ${cfg.arb.min_edge}):")
        for o in sorted(opps, key=lambda o: -o.profit):
            print(f"  {o.kind:16s} {o.sets:8.1f} sets x ${o.edge_per_set:.4f} = ${o.profit:8.2f}  {o.title[:60]}")
    else:
        print("\nNo complete-set arbitrage right now (normal: other bots close these in milliseconds).")
    print("\nClosest to arbitrage (sum of best asks; < 1.00 before fees = arb):")
    for total, title in sorted(near_misses)[:10]:
        print(f"  {total:6.3f}  {title[:80]}")
    return 0


def cmd_backtest(args, cfg: BotConfig) -> int:
    from pmbot.backtest import SCENARIOS, SimParams, run_scenarios

    base = SimParams(days=args.days, markets=args.markets, seed=args.seed, start_cash=args.cash,
                     order_size=args.size, dt=args.dt)
    names = list(SCENARIOS) if args.scenario == "all" else [args.scenario]
    print(f"Simulating {args.days} days, {args.markets} markets, {args.seeds} seeds per scenario...\n")
    results = run_scenarios(names, base, seeds=args.seeds)
    for name, runs in results.items():
        print(f"== {name}")
        for r in runs:
            print("   " + r.summary())
        avg = sum(r.pnl for r in runs) / len(runs)
        print(f"   average P&L ${avg:,.0f}\n")
    print("Read this as: the same bot is profitable or not depending almost entirely on how much of")
    print("its flow is informed (adverse selection) and how stale its quotes are (latency).")
    return 0


def cmd_audit(args, cfg: BotConfig) -> int:
    from pmbot.audit import audit_wallet

    print(f"Pulling public activity for {args.wallet} ...")
    print(audit_wallet(args.wallet, days=args.days, max_records=args.max_records).render())
    if args.days:
        print("\nnote: with --days, positions opened before the window skew P&L; omit it for the full history.")
    return 0


def _run_engine(args, cfg: BotConfig, live: bool) -> int:
    from pmbot.engine import Engine
    from pmbot.portfolio import Portfolio

    fee_lookup: dict = {}
    if live:
        from pmbot.execution.live import LiveExecutor, LiveTradingNotAcknowledged

        try:
            executor = LiveExecutor(fee_lookup=fee_lookup)
        except LiveTradingNotAcknowledged as exc:
            print(exc, file=sys.stderr)
            return 2
        if not args.yes:
            print("LIVE TRADING with real funds. Limits:", cfg.risk)
            if input("Type 'trade' to continue: ").strip() != "trade":
                return 1
    else:
        from pmbot.execution.paper import PaperExecutor

        executor = PaperExecutor(cfg.paper, fee_lookup=fee_lookup)
    engine = Engine(cfg, executor, Portfolio(cfg.risk.starting_cash), fee_lookup=fee_lookup, live=live)
    duration = args.minutes * 60 if args.minutes else None
    stats = engine.run(duration)
    print("\nfinal:", {k: (round(v, 4) if isinstance(v, float) else v) for k, v in stats.items()})
    print(f"fills and snapshots written to {engine.run_dir}/")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="pmbot", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", help="TOML file overriding defaults (see config.example.toml)")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="rank markets for market making")
    s.add_argument("--why", type=int, default=0, metavar="N", help="also explain N rejected markets")
    s.set_defaults(fn=cmd_scan)

    a = sub.add_parser("arb", help="scan for complete-set arbitrage")
    a.add_argument("--universe", type=int, default=300, help="binary markets to check")
    a.add_argument("--events", type=int, default=60, help="multi-outcome events to check")
    a.set_defaults(fn=cmd_arb)

    for name, live in (("paper", False), ("live", True)):
        e = sub.add_parser(name, help=f"run the bot ({'REAL MONEY' if live else 'simulated fills, live data'})")
        e.add_argument("--minutes", type=float, default=0, help="stop after N minutes (default: until Ctrl-C)")
        if live:
            e.add_argument("--yes", action="store_true", help="skip the interactive confirmation")
        e.set_defaults(fn=lambda args, cfg, _live=live: _run_engine(args, cfg, _live))

    b = sub.add_parser("backtest", help="Monte Carlo market-making simulation")
    b.add_argument("--scenario", default="all", choices=["all", "benign", "typical", "toxic"])
    b.add_argument("--days", type=int, default=48)
    b.add_argument("--markets", type=int, default=6)
    b.add_argument("--seeds", type=int, default=2)
    b.add_argument("--seed", type=int, default=7)
    b.add_argument("--cash", type=float, default=25_000)
    b.add_argument("--size", type=float, default=100)
    b.add_argument("--dt", type=float, default=15, help="seconds per simulation step")
    b.set_defaults(fn=cmd_backtest)

    w = sub.add_parser("audit", help="audit a public wallet's performance")
    w.add_argument("wallet")
    w.add_argument("--days", type=float, default=None)
    w.add_argument("--max-records", type=int, default=100_000)
    w.set_defaults(fn=cmd_audit)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _setup_logging(args.verbose)
    cfg = BotConfig.load(args.config)
    return args.fn(args, cfg)


if __name__ == "__main__":
    raise SystemExit(main())
