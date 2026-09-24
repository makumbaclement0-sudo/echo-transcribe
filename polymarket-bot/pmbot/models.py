"""Core data types: markets, order books, orders and fills."""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


@dataclass(frozen=True)
class Level:
    price: float
    size: float


@dataclass
class OrderBook:
    """One outcome token's book. Bids sorted high->low, asks low->high."""

    token_id: str
    bids: list[Level]
    asks: list[Level]
    timestamp: float = field(default_factory=time.time)

    @classmethod
    def from_api(cls, raw: dict) -> "OrderBook":
        bids = sorted(
            (Level(float(l["price"]), float(l["size"])) for l in raw.get("bids", [])),
            key=lambda l: -l.price,
        )
        asks = sorted(
            (Level(float(l["price"]), float(l["size"])) for l in raw.get("asks", [])),
            key=lambda l: l.price,
        )
        ts = raw.get("timestamp")
        ts = float(ts) / 1000.0 if ts else time.time()
        return cls(token_id=str(raw.get("asset_id", "")), bids=bids, asks=asks, timestamp=ts)

    @property
    def best_bid(self) -> float | None:
        return self.bids[0].price if self.bids else None

    @property
    def best_ask(self) -> float | None:
        return self.asks[0].price if self.asks else None

    @property
    def mid(self) -> float | None:
        if self.best_bid is None or self.best_ask is None:
            return None
        return (self.best_bid + self.best_ask) / 2.0

    @property
    def spread(self) -> float | None:
        if self.best_bid is None or self.best_ask is None:
            return None
        return self.best_ask - self.best_bid

    def microprice(self) -> float | None:
        """Size-weighted mid: leans toward the side with less resting size,
        which is where the price is more likely to move next."""
        if not self.bids or not self.asks:
            return None
        b, a = self.bids[0], self.asks[0]
        total = b.size + a.size
        if total <= 0:
            return self.mid
        return (b.price * a.size + a.price * b.size) / total

    def size_at(self, side: Side, price: float, eps: float = 1e-9) -> float:
        levels = self.bids if side is Side.BUY else self.asks
        for lvl in levels:
            if abs(lvl.price - price) < eps:
                return lvl.size
        return 0.0

    def sweep(self, side: Side, max_shares: float, limit_price: float | None = None) -> tuple[float, float]:
        """Simulate a taker order walking the book.

        side=BUY consumes asks, side=SELL consumes bids. Returns
        (shares_filled, average_price). Stops at `limit_price` if given.
        """
        levels = self.asks if side is Side.BUY else self.bids
        filled = 0.0
        cost = 0.0
        for lvl in levels:
            if limit_price is not None:
                if side is Side.BUY and lvl.price > limit_price + 1e-12:
                    break
                if side is Side.SELL and lvl.price < limit_price - 1e-12:
                    break
            take = min(lvl.size, max_shares - filled)
            if take <= 0:
                break
            filled += take
            cost += take * lvl.price
        if filled <= 0:
            return 0.0, 0.0
        return filled, cost / filled


@dataclass
class FeeSchedule:
    rate: float = 0.0
    exponent: float = 1.0
    taker_only: bool = True
    rebate_rate: float = 0.0


@dataclass
class Market:
    """A binary Polymarket market (one condition, a YES and a NO token)."""

    id: str
    condition_id: str
    question: str
    slug: str
    yes_token: str
    no_token: str
    outcomes: tuple[str, str] = ("Yes", "No")
    tick: float = 0.01
    min_size: float = 5.0
    neg_risk: bool = False
    fees_enabled: bool = False
    fees: FeeSchedule = field(default_factory=FeeSchedule)
    rewards_min_size: float = 0.0
    rewards_max_spread_cents: float = 0.0
    end_date: datetime | None = None
    game_start: datetime | None = None
    volume_24h: float = 0.0
    liquidity: float = 0.0
    best_bid: float | None = None
    best_ask: float | None = None
    accepting_orders: bool = True
    event_id: str | None = None
    event_title: str | None = None
    seconds_delay: float = 0.0

    @classmethod
    def from_gamma(cls, raw: dict) -> "Market | None":
        """Parse a Gamma API market. Returns None for anything that isn't a
        tradable binary CLOB market."""
        try:
            tokens = _json_list(raw.get("clobTokenIds"))
            outcomes = _json_list(raw.get("outcomes")) or ["Yes", "No"]
        except ValueError:
            return None
        if len(tokens) != 2 or not raw.get("enableOrderBook", True):
            return None
        fs = raw.get("feeSchedule") or {}
        fees_enabled = bool(raw.get("feesEnabled"))
        events = raw.get("events") or []
        return cls(
            id=str(raw.get("id")),
            condition_id=str(raw.get("conditionId", "")),
            question=str(raw.get("question", "")),
            slug=str(raw.get("slug", "")),
            yes_token=str(tokens[0]),
            no_token=str(tokens[1]),
            outcomes=(str(outcomes[0]), str(outcomes[1])),
            tick=float(raw.get("orderPriceMinTickSize") or 0.01),
            min_size=float(raw.get("orderMinSize") or 5),
            neg_risk=bool(raw.get("negRisk")),
            fees_enabled=fees_enabled,
            fees=FeeSchedule(
                rate=float(fs.get("rate") or 0.0) if fees_enabled else 0.0,
                exponent=float(fs.get("exponent") or 1.0),
                taker_only=bool(fs.get("takerOnly", True)),
                rebate_rate=float(fs.get("rebateRate") or 0.0) if fees_enabled else 0.0,
            ),
            rewards_min_size=float(raw.get("rewardsMinSize") or 0.0),
            rewards_max_spread_cents=float(raw.get("rewardsMaxSpread") or 0.0),
            end_date=_parse_dt(raw.get("endDate")),
            game_start=_parse_dt(raw.get("gameStartTime")),
            volume_24h=float(raw.get("volume24hrClob") or raw.get("volume24hr") or 0.0),
            liquidity=float(raw.get("liquidityClob") or raw.get("liquidityNum") or 0.0),
            best_bid=_opt_float(raw.get("bestBid")),
            best_ask=_opt_float(raw.get("bestAsk")),
            accepting_orders=bool(raw.get("acceptingOrders", True)),
            event_id=str(events[0].get("id")) if events else None,
            event_title=str(events[0].get("title")) if events else None,
            seconds_delay=float(raw.get("secondsDelay") or 0.0),
        )

    @property
    def label(self) -> str:
        """Human-readable name; sub-markets like "O/U 1.5" need their event title."""
        if self.event_title and self.event_title.lower() not in self.question.lower() and len(self.question) < 40:
            return f"{self.event_title} - {self.question}"
        return self.question

    def hours_to_end(self, now: datetime | None = None) -> float:
        if self.end_date is None:
            return math.inf
        now = now or datetime.now(timezone.utc)
        return (self.end_date - now).total_seconds() / 3600.0

    def is_live_game(self, now: datetime | None = None) -> bool:
        if self.game_start is None:
            return False
        now = now or datetime.now(timezone.utc)
        return now >= self.game_start

    def round_down(self, price: float) -> float:
        return round(math.floor(price / self.tick + 1e-9) * self.tick, 6)

    def round_up(self, price: float) -> float:
        return round(math.ceil(price / self.tick - 1e-9) * self.tick, 6)

    def clamp_price(self, price: float) -> float:
        return min(max(price, self.tick), 1.0 - self.tick)


@dataclass
class Order:
    id: str
    token_id: str
    side: Side
    price: float
    size: float
    filled: float = 0.0
    created: float = field(default_factory=time.time)
    tag: str = ""  # e.g. "mm-bid", "mm-ask", "arb"
    # paper-trading queue model: shares resting ahead of us at our price
    queue_ahead: float = 0.0

    @property
    def remaining(self) -> float:
        return max(self.size - self.filled, 0.0)


@dataclass
class Fill:
    order_id: str
    token_id: str
    side: Side
    price: float
    size: float
    fee: float = 0.0
    maker: bool = True
    timestamp: float = field(default_factory=time.time)
    tag: str = ""


def _json_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    parsed = json.loads(value)
    if not isinstance(parsed, list):
        raise ValueError("expected list")
    return parsed


def _opt_float(value) -> float | None:
    try:
        return None if value is None or value == "" else float(value)
    except (TypeError, ValueError):
        return None


def _parse_dt(value) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    # Gamma sometimes returns "2026-09-24 09:20:00+00"
    if text.endswith("+00") and not text.endswith("+00:00"):
        text += ":00"
    try:
        dt = datetime.fromisoformat(text.replace(" ", "T", 1))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
