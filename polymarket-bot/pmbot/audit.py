"""Audit any public Polymarket wallet: trade count, win rate, P&L.

Every Polymarket account is an on-chain wallet and its full activity is
public, so claims like "$120k in 48 days, 37,000 trades, 60% win rate" can be
checked rather than taken on faith. Paste the wallet (proxy) address from the
trader's profile URL and run:

    python -m pmbot audit 0xabc... --days 48

P&L is estimated from cash flows: sells + redeems + merges + rewards/rebates
- buys - splits, plus the current value of open positions. "Win rate" here
is per market (conditionId): the share of markets where the wallet ended up
ahead, which is how most leaderboard screenshots count it.
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field

from pmbot.data import DataClient

INFLOW_TYPES = {"REDEEM", "MERGE", "REWARD", "TAKER_REBATE", "MAKER_REBATE", "REFERRAL_REWARD", "YIELD"}
OUTFLOW_TYPES = {"SPLIT"}


@dataclass
class AuditReport:
    wallet: str
    records: int = 0
    trades: int = 0
    buys: int = 0
    sells: int = 0
    volume: float = 0.0
    first_ts: int | None = None
    last_ts: int | None = None
    cash_flow: float = 0.0
    incentives: float = 0.0
    open_value: float = 0.0
    markets: int = 0
    winning_markets: int = 0
    by_type: dict[str, int] = field(default_factory=dict)
    truncated: bool = False

    @property
    def days(self) -> float:
        if self.first_ts is None or self.last_ts is None:
            return 0.0
        return max((self.last_ts - self.first_ts) / 86_400, 1 / 24)

    @property
    def pnl(self) -> float:
        return self.cash_flow + self.open_value

    def render(self) -> str:
        wr = self.winning_markets / self.markets if self.markets else 0.0
        lines = [
            f"wallet            {self.wallet}",
            f"window            {self.days:.1f} days ({self.records:,} activity records"
            f"{', TRUNCATED' if self.truncated else ''})",
            f"trades            {self.trades:,} ({self.buys:,} buys / {self.sells:,} sells), "
            f"{self.trades / self.days if self.days else 0:,.0f}/day",
            f"volume            ${self.volume:,.0f}",
            f"incentives        ${self.incentives:,.2f} (rewards + rebates)",
            f"open positions    ${self.open_value:,.2f} (current value)",
            f"est. P&L          ${self.pnl:,.2f}",
            f"markets traded    {self.markets:,}; ahead in {self.winning_markets:,} -> market win rate {100 * wr:.1f}%",
            f"activity types    {dict(sorted(self.by_type.items()))}",
        ]
        return "\n".join(lines)


def fetch_activity(client: DataClient, wallet: str, since_ts: int | None, max_records: int) -> tuple[list[dict], bool]:
    """Page backwards in time (the API caps offset-based paging at 5,000)."""
    out: list[dict] = []
    seen: set[tuple] = set()
    end: int | None = None
    while len(out) < max_records:
        page = client.http.get("/activity", user=wallet, limit=500, end=end) or []
        new = 0
        for rec in page:
            key = (rec.get("transactionHash"), rec.get("asset"), rec.get("type"), rec.get("size"), rec.get("timestamp"))
            if key in seen:
                continue
            seen.add(key)
            if since_ts is not None and int(rec.get("timestamp", 0)) < since_ts:
                return out, False
            out.append(rec)
            new += 1
        if len(page) < 500:
            return out, False
        oldest = min(int(r.get("timestamp", 0)) for r in page)
        end = oldest if new else oldest - 1
    return out, True


def audit_wallet(wallet: str, days: float | None = None, max_records: int = 100_000,
                 client: DataClient | None = None) -> AuditReport:
    client = client or DataClient()
    since = int(time.time() - days * 86_400) if days else None
    records, truncated = fetch_activity(client, wallet, since, max_records)
    rep = AuditReport(wallet=wallet, records=len(records), truncated=truncated)
    per_market: dict[str, float] = defaultdict(float)
    by_type: dict[str, int] = defaultdict(int)
    for r in records:
        typ = str(r.get("type", "")).upper()
        by_type[typ] += 1
        ts = int(r.get("timestamp", 0))
        rep.first_ts = ts if rep.first_ts is None else min(rep.first_ts, ts)
        rep.last_ts = ts if rep.last_ts is None else max(rep.last_ts, ts)
        usd = float(r.get("usdcSize") or 0.0)
        cid = r.get("conditionId") or ""
        if typ == "TRADE":
            rep.trades += 1
            rep.volume += usd
            if str(r.get("side")).upper() == "BUY":
                rep.buys += 1
                flow = -usd
            else:
                rep.sells += 1
                flow = usd
        elif typ in INFLOW_TYPES:
            flow = usd
            if typ not in {"REDEEM", "MERGE"}:
                rep.incentives += usd
        elif typ in OUTFLOW_TYPES:
            flow = -usd
        else:
            flow = 0.0
        rep.cash_flow += flow
        if cid:
            per_market[cid] += flow
    rep.by_type = dict(by_type)

    offset = 0
    while True:
        page = client.http.get("/positions", user=wallet, limit=500, offset=offset, sizeThreshold=0) or []
        for p in page:
            value = float(p.get("currentValue") or 0.0)
            rep.open_value += value
            cid = p.get("conditionId") or ""
            if cid in per_market:
                per_market[cid] += value
        if len(page) < 500 or offset >= 10_000:
            break
        offset += 500

    rep.markets = len(per_market)
    rep.winning_markets = sum(1 for v in per_market.values() if v > 0)
    return rep
