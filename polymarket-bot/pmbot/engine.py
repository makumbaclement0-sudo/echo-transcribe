"""The trading loop: data -> fills -> risk -> quotes -> order reconciliation."""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from pmbot.config import BotConfig
from pmbot.data import ApiError, ClobPublicClient, GammaClient
from pmbot.execution.base import Executor
from pmbot.fees import expected_maker_rebate
from pmbot.models import FeeSchedule, Fill, Market, OrderBook, Side
from pmbot.portfolio import Portfolio
from pmbot.risk import RiskManager
from pmbot.scanner import select_markets
from pmbot.strategies.complete_set import ArbOpportunity, binary_arbs
from pmbot.strategies.market_maker import MarketMaker, Quote

log = logging.getLogger(__name__)


class Engine:
    def __init__(self, cfg: BotConfig, executor: Executor, portfolio: Portfolio,
                 gamma: GammaClient | None = None, clob: ClobPublicClient | None = None,
                 fee_lookup: dict[str, FeeSchedule] | None = None, live: bool = False):
        self.cfg = cfg
        self.executor = executor
        self.portfolio = portfolio
        self.gamma = gamma or GammaClient()
        self.clob = clob or ClobPublicClient()
        self.fee_lookup = fee_lookup if fee_lookup is not None else {}
        self.live = live
        self.mm = MarketMaker(cfg.mm)
        self.risk = RiskManager(cfg.risk)
        self.universe: list[Market] = []
        self.markets: list[Market] = []
        self.by_token: dict[str, Market] = {}
        self.marks: dict[str, float] = {}
        self.arbs_seen: list[ArbOpportunity] = []
        self._last_scan = 0.0
        self._last_report = 0.0
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.run_dir = Path(cfg.engine.run_dir) / f"{'live' if live else 'paper'}-{stamp}"

    # -- universe ------------------------------------------------------------
    def refresh_universe(self) -> None:
        self.universe = self.gamma.active_markets(self.cfg.scanner.universe)
        picked = select_markets(self.universe, self.cfg.scanner)
        keep = {m.id for m in self.markets if self._has_exposure(m)}  # never orphan a position
        new = [s.market for s in picked]
        for m in self.markets:
            if m.id in keep and m.id not in {x.id for x in new}:
                new.append(m)
        dropped = {m.id for m in self.markets} - {m.id for m in new}
        for order in self.executor.open_orders():
            mk = self.by_token.get(order.token_id)
            if mk and mk.id in dropped:
                self.executor.cancel(order.id)
        self.markets = new
        for m in self.universe + self.markets:
            self.fee_lookup[m.yes_token] = m.fees
            self.fee_lookup[m.no_token] = m.fees
        for m in self.markets:
            self.by_token[m.yes_token] = m
            self.by_token[m.no_token] = m
            self.portfolio.register_market(m.yes_token, m.no_token)
        self._last_scan = time.time()
        log.info("quoting %d markets: %s", len(self.markets), "; ".join(m.label[:60] for m in self.markets))

    def _has_exposure(self, m: Market) -> bool:
        return abs(self.portfolio.position(m.yes_token)) > 1e-9 or abs(self.portfolio.position(m.no_token)) > 1e-9

    # -- one cycle -----------------------------------------------------------
    def step(self) -> None:
        now = time.time()
        if now - self._last_scan > self.cfg.engine.rescan_interval_s or not self.markets:
            self.refresh_universe()
        tokens = [t for m in self.markets for t in (m.yes_token, m.no_token)]
        books = self.clob.books(tokens) if tokens else {}

        for fill in self.executor.poll_fills(books):
            self._record_fill(fill)

        for tok, book in books.items():
            if book.mid is not None:
                self.marks[tok] = book.mid

        if self.risk.check_kill_switch(self.portfolio.equity(self.marks)):
            if self.executor.open_orders():
                self.executor.cancel_all()
            return

        for m in self.markets:
            yes, no = books.get(m.yes_token), books.get(m.no_token)
            if yes is None or no is None or not self.risk.book_fresh(yes, now):
                self._cancel_market(m)
                continue
            self.mm.observe(m, yes, now)
            self._quote_market(m, yes, no)

        if self.cfg.arb.enabled:
            self._arb_scan(books)

        if now - self._last_report > self.cfg.engine.report_interval_s:
            self.report()
            self._last_report = now

    # -- market making -------------------------------------------------------
    def _quote_market(self, m: Market, yes: OrderBook, no: OrderBook) -> None:
        inventory = self.portfolio.net_yes(m.yes_token, m.no_token)
        quote = self.mm.quote(m, yes, inventory)
        desired = self._desired_orders(m, quote)
        existing = [o for o in self.executor.open_orders() if o.token_id in (m.yes_token, m.no_token)
                    and o.tag.startswith("mm")]
        tol = self.cfg.mm.requote_threshold_ticks * m.tick - 1e-9
        for o in existing:
            match = next((d for d in desired if d[4] == o.tag and d[0] == o.token_id and d[1] is o.side
                          and abs(d[2] - o.price) < tol and o.remaining >= 0.5 * d[3]), None)
            if match:
                desired.remove(match)
            else:
                self.executor.cancel(o.id)
        for token, side, price, size, tag in desired:
            book = yes if token == m.yes_token else no
            decision = self.risk.check_order(
                price=price, size=size,
                market_exposure=self._market_exposure(m),
                total_exposure=sum(self._market_exposure(x) for x in self.markets),
                open_orders=len(self.executor.open_orders()),
                increases_exposure=side is Side.BUY,
            )
            if not decision.allowed:
                log.debug("skip %s %s: %s", m.label[:40], tag, decision.reason)
                continue
            self.executor.place_limit(token, side, price, size, tag=tag, post_only=True, book=book)

    def _desired_orders(self, m: Market, q: Quote | None) -> list[tuple[str, Side, float, float, str]]:
        if q is None:
            return []
        out = []
        if q.bid_price is not None and q.bid_size > 0:
            out.append((m.yes_token, Side.BUY, q.bid_price, q.bid_size, "mm-bid"))
        if q.ask_price is not None and q.ask_size > 0:
            held_yes = self.portfolio.position(m.yes_token)
            if held_yes >= q.ask_size:
                out.append((m.yes_token, Side.SELL, q.ask_price, q.ask_size, "mm-ask"))
            else:  # selling YES at a == buying NO at 1 - a
                out.append((m.no_token, Side.BUY, round(1.0 - q.ask_price, 6), q.ask_size, "mm-ask"))
        return out

    def _market_exposure(self, m: Market) -> float:
        pos = self.portfolio.positions
        cost = sum(pos[t].cost for t in (m.yes_token, m.no_token) if t in pos)
        resting = sum(o.price * o.remaining for o in self.executor.open_orders()
                      if o.side is Side.BUY and o.token_id in (m.yes_token, m.no_token))
        return cost + resting

    def _cancel_market(self, m: Market) -> None:
        for o in self.executor.open_orders():
            if o.token_id in (m.yes_token, m.no_token):
                self.executor.cancel(o.id)

    # -- arbitrage -----------------------------------------------------------
    def _arb_scan(self, books: dict[str, OrderBook]) -> None:
        opps: list[ArbOpportunity] = []
        for m in self.markets:
            yes, no = books.get(m.yes_token), books.get(m.no_token)
            if yes and no:
                opps += binary_arbs(m, yes, no, self.cfg.arb.min_edge, self.cfg.arb.max_set_size)
        for opp in opps:
            self.arbs_seen.append(opp)
            log.warning("ARB %s %s: %.1f sets x $%.4f = $%.2f", opp.kind, opp.title[:50], opp.sets,
                        opp.edge_per_set, opp.profit)
            if opp.kind == "binary-buy":
                self._execute_buy_arb(opp, books)

    def _execute_buy_arb(self, opp: ArbOpportunity, books: dict[str, OrderBook]) -> None:
        budget = self.cfg.risk.max_total_notional - sum(self._market_exposure(x) for x in self.markets)
        cost_per_set = 1.0 - opp.edge_per_set
        sets = min(opp.sets, max(budget, 0) / max(cost_per_set, 1e-6), self.portfolio.cash / max(cost_per_set, 1e-6))
        sets = float(int(sets))
        if sets <= 0 or self.risk.killed:
            return
        for leg in opp.legs:
            fill = self.executor.place_taker(leg.token_id, Side.BUY, leg.price, sets, tag="arb",
                                             book=books.get(leg.token_id))
            if fill is None:
                log.error("ARB LEGGED: leg %s did not fill; holding the other leg as inventory", leg.label)
                return
            self._record_fill(fill)

    # -- bookkeeping ---------------------------------------------------------
    def _record_fill(self, fill: Fill) -> None:
        rebate = 0.0
        if fill.maker:
            rebate = expected_maker_rebate(fill.size, fill.price, self.fee_lookup.get(fill.token_id, FeeSchedule()))
        self.portfolio.apply_fill(fill, rebate=rebate, auto_merge=not self.live)
        m = self.by_token.get(fill.token_id)
        log.info("FILL %s %s %.0f @ %.3f (%s) %s", fill.side.value, fill.tag, fill.size, fill.price,
                 "maker" if fill.maker else "taker", m.label[:60] if m else fill.token_id[:10])
        self._append("fills.jsonl", {**asdict(fill), "side": fill.side.value, "rebate": rebate,
                                     "market": m.label if m else None})

    def _append(self, name: str, record: dict) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        with open(self.run_dir / name, "a") as fh:
            fh.write(json.dumps(record, default=str) + "\n")

    def report(self) -> dict:
        s = self.portfolio.stats(self.marks)
        s["open_orders"] = len(self.executor.open_orders())
        s["markets"] = len(self.markets)
        s["arbs_seen"] = len(self.arbs_seen)
        s["killed"] = self.risk.kill_reason or False
        s["time"] = datetime.now(timezone.utc).isoformat()
        log.info("equity $%.2f | pnl $%+.2f | fills %d | round trips %d | win %.0f%% | rebates $%.2f | orders %d",
                 s["equity"], s["total_pnl"], s["fills"], s["round_trips"], 100 * s["win_rate"],
                 s["rebates_earned"], s["open_orders"])
        self._append("snapshots.jsonl", s)
        return s

    def run(self, duration_s: float | None = None) -> dict:
        start = time.time()
        try:
            while duration_s is None or time.time() - start < duration_s:
                t0 = time.time()
                try:
                    self.step()
                except ApiError as exc:
                    log.warning("API error, skipping cycle: %s", exc)
                time.sleep(max(0.0, self.cfg.engine.poll_interval_s - (time.time() - t0)))
        except KeyboardInterrupt:
            log.info("interrupted")
        finally:
            try:
                self.executor.cancel_all()
            except Exception as exc:  # make sure we still report
                log.error("cancel_all failed: %s -- CHECK OPEN ORDERS MANUALLY", exc)
        return self.report()

