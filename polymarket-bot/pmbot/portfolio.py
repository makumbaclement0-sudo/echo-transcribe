"""Position, cash and P&L accounting, including round-trip win-rate stats.

Every binary market has a YES and a NO token and 1 YES + 1 NO is always
worth exactly $1 (they can be merged back into pUSD). So:

* net exposure of a market = YES shares - NO shares ("YES-equivalent")
* holding a matched YES+NO pair is risk-free: we book it as $1 immediately
  (the paper engine merges pairs; live, pairs redeem for $1 at resolution).

A "round trip" is closed whenever a lot is sold or merged; it counts as a win
if it realised a positive P&L (fees and rebates included). That's the same
definition the viral "60% win rate" claims generally use.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from pmbot.models import Fill, Side


@dataclass
class Lot:
    size: float
    price: float  # cost per share incl. fees


@dataclass
class TokenPosition:
    lots: deque[Lot] = field(default_factory=deque)

    @property
    def size(self) -> float:
        return sum(l.size for l in self.lots)

    @property
    def cost(self) -> float:
        return sum(l.size * l.price for l in self.lots)

    @property
    def avg_price(self) -> float:
        s = self.size
        return self.cost / s if s > 0 else 0.0

    def add(self, size: float, price: float) -> None:
        self.lots.append(Lot(size, price))

    def remove(self, size: float) -> list[Lot]:
        """FIFO-remove `size` shares, returning the consumed lots."""
        taken: list[Lot] = []
        remaining = size
        while remaining > 1e-9 and self.lots:
            lot = self.lots[0]
            take = min(lot.size, remaining)
            taken.append(Lot(take, lot.price))
            lot.size -= take
            remaining -= take
            if lot.size <= 1e-9:
                self.lots.popleft()
        if remaining > 1e-6:
            raise ValueError(f"cannot remove {size} shares; only {size - remaining} held")
        return taken


@dataclass
class RoundTrip:
    token_id: str
    size: float
    pnl: float
    kind: str  # "sell", "merge", "resolve"


class Portfolio:
    def __init__(self, cash: float):
        self.starting_cash = cash
        self.cash = cash
        self.positions: dict[str, TokenPosition] = {}
        self.pairs: dict[str, str] = {}  # token -> complementary token
        self.realized_pnl = 0.0
        self.fees_paid = 0.0
        self.rebates_earned = 0.0
        self.round_trips: list[RoundTrip] = []
        self.fills: list[Fill] = []

    # -- bookkeeping -----------------------------------------------------
    def register_market(self, yes_token: str, no_token: str) -> None:
        self.pairs[yes_token] = no_token
        self.pairs[no_token] = yes_token

    def position(self, token_id: str) -> float:
        pos = self.positions.get(token_id)
        return pos.size if pos else 0.0

    def net_yes(self, yes_token: str, no_token: str) -> float:
        return self.position(yes_token) - self.position(no_token)

    def apply_fill(self, fill: Fill, rebate: float = 0.0, auto_merge: bool = True) -> None:
        self.fills.append(fill)
        self.fees_paid += fill.fee
        self.rebates_earned += rebate
        self.cash += rebate
        pos = self.positions.setdefault(fill.token_id, TokenPosition())
        if fill.side is Side.BUY:
            self.cash -= fill.size * fill.price + fill.fee
            pos.add(fill.size, fill.price + fill.fee / fill.size)
            if auto_merge:
                self._merge_pairs(fill.token_id)
        else:
            proceeds = fill.size * fill.price - fill.fee
            self.cash += proceeds
            lots = pos.remove(fill.size)
            cost = sum(l.size * l.price for l in lots)
            self._close(fill.token_id, fill.size, proceeds - cost, "sell")

    def split(self, yes_token: str, no_token: str, sets: float) -> None:
        """Convert `sets` pUSD into `sets` YES + `sets` NO (cost basis 0.5 each)."""
        self.cash -= sets
        self.positions.setdefault(yes_token, TokenPosition()).add(sets, 0.5)
        self.positions.setdefault(no_token, TokenPosition()).add(sets, 0.5)

    def _merge_pairs(self, token_id: str) -> None:
        other = self.pairs.get(token_id)
        if other is None:
            return
        a, b = self.positions.get(token_id), self.positions.get(other)
        if not a or not b:
            return
        n = min(a.size, b.size)
        if n <= 1e-9:
            return
        cost = sum(l.size * l.price for l in a.remove(n)) + sum(l.size * l.price for l in b.remove(n))
        self.cash += n
        self._close(token_id, n, n - cost, "merge")

    def resolve(self, yes_token: str, no_token: str, yes_won: bool) -> None:
        for token, payout in ((yes_token, 1.0 if yes_won else 0.0), (no_token, 0.0 if yes_won else 1.0)):
            pos = self.positions.pop(token, None)
            if pos and pos.size > 0:
                self.cash += pos.size * payout
                self._close(token, pos.size, pos.size * payout - pos.cost, "resolve")

    def _close(self, token_id: str, size: float, pnl: float, kind: str) -> None:
        self.realized_pnl += pnl
        self.round_trips.append(RoundTrip(token_id, size, pnl, kind))

    # -- valuation -------------------------------------------------------
    def inventory_value(self, marks: dict[str, float]) -> float:
        total = 0.0
        for token, pos in self.positions.items():
            mark = marks.get(token)
            total += pos.size * (mark if mark is not None else pos.avg_price)
        return total

    def equity(self, marks: dict[str, float]) -> float:
        return self.cash + self.inventory_value(marks)

    def total_pnl(self, marks: dict[str, float]) -> float:
        return self.equity(marks) - self.starting_cash

    def stats(self, marks: dict[str, float] | None = None) -> dict:
        trips = self.round_trips
        wins = [t for t in trips if t.pnl > 1e-9]
        losses = [t for t in trips if t.pnl < -1e-9]
        marks = marks or {}
        return {
            "fills": len(self.fills),
            "round_trips": len(trips),
            "win_rate": (len(wins) / len(trips)) if trips else 0.0,
            "avg_win": sum(t.pnl for t in wins) / len(wins) if wins else 0.0,
            "avg_loss": sum(t.pnl for t in losses) / len(losses) if losses else 0.0,
            "realized_pnl": self.realized_pnl,
            "fees_paid": self.fees_paid,
            "rebates_earned": self.rebates_earned,
            "cash": self.cash,
            "equity": self.equity(marks),
            "total_pnl": self.total_pnl(marks),
        }
