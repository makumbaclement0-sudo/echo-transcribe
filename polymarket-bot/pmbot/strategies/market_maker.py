"""Inventory-aware two-sided quoting (a simplified Avellaneda-Stoikov maker).

Each cycle, for each market:

1. fair value  = microprice of the YES book (or mid)
2. reservation = fair - skew * (inventory / max_inventory)
      long YES -> quote lower so we're more likely to sell than buy more
3. half spread = max(min_half_spread, vol_multiplier * sigma)
      wider when the market is moving, i.e. when fills are more toxic
4. stay post-only: never cross the book (we must be the maker)
5. optionally tighten into the liquidity-reward band (rewardsMaxSpread)
   when that doesn't mean quoting inside our minimum edge
6. shrink / drop the side that would push inventory past its limit

The "ask" is expressed as a YES price. The engine turns it into either
SELL YES (if we hold YES) or BUY NO at (1 - ask), which is economically
identical because YES + NO = $1.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from pmbot.config import MarketMakerConfig
from pmbot.models import Market, OrderBook


@dataclass
class Quote:
    bid_price: float | None
    bid_size: float
    ask_price: float | None  # in YES terms
    ask_size: float
    fair: float
    reservation: float
    half_spread: float
    note: str = ""


class VolEstimator:
    """EWMA of squared mid changes, in price units per sqrt(second)."""

    def __init__(self, halflife_s: float):
        self.halflife_s = halflife_s
        self.var_per_s = 0.0
        self.last_mid: float | None = None
        self.last_t: float | None = None

    def update(self, mid: float, t: float) -> None:
        if self.last_mid is not None and self.last_t is not None and t > self.last_t:
            dt = t - self.last_t
            alpha = 1 - math.exp(-dt * math.log(2) / self.halflife_s)
            inst = (mid - self.last_mid) ** 2 / dt
            self.var_per_s = (1 - alpha) * self.var_per_s + alpha * inst
        self.last_mid, self.last_t = mid, t

    def sigma(self, horizon_s: float = 10.0) -> float:
        return math.sqrt(self.var_per_s * horizon_s)


class MarketMaker:
    def __init__(self, cfg: MarketMakerConfig):
        self.cfg = cfg
        self.vols: dict[str, VolEstimator] = {}

    def observe(self, market: Market, book: OrderBook, t: float) -> None:
        mid = book.mid
        if mid is not None:
            self.vols.setdefault(market.id, VolEstimator(self.cfg.vol_halflife_s)).update(mid, t)

    def quote(self, market: Market, book: OrderBook, inventory: float) -> Quote | None:
        cfg = self.cfg
        bb, ba = book.best_bid, book.best_ask
        if bb is None or ba is None or ba <= bb:
            return None
        fair = (book.microprice() if cfg.use_microprice else None) or book.mid
        vol = self.vols.get(market.id)
        sigma = vol.sigma() if vol else 0.0
        if sigma > cfg.pull_on_vol_spike:
            return Quote(None, 0, None, 0, fair, fair, 0, note=f"pulled: vol {sigma:.3f}")

        inv_ratio = max(-1.0, min(1.0, inventory / cfg.max_inventory)) if cfg.max_inventory > 0 else 0.0
        reservation = fair - cfg.inventory_skew * inv_ratio
        half = max(cfg.min_half_spread, cfg.vol_multiplier * sigma, market.tick / 2)

        # Liquidity rewards only score orders within max_spread of the mid.
        # Tighten into the band only if that still respects our minimum edge.
        if cfg.target_rewards and market.rewards_max_spread_cents > 0:
            band = market.rewards_max_spread_cents / 100.0 - market.tick
            if cfg.min_half_spread <= band < half:
                half = band

        bid = market.round_down(reservation - half)
        ask = market.round_up(reservation + half)

        # post-only: never cross. Join the best level at most.
        bid = min(bid, market.round_down(ba - market.tick))
        ask = max(ask, market.round_up(bb + market.tick))
        bid = market.clamp_price(bid)
        ask = market.clamp_price(ask)
        if ask - bid < market.tick - 1e-9:
            return None

        size = max(cfg.order_size, market.min_size)
        if cfg.target_rewards and market.rewards_min_size > 0:
            size = max(size, market.rewards_min_size)

        # inventory limits: taper the side that adds to the position
        bid_size = size * min(1.0, max(0.0, 1.0 - inv_ratio)) if inv_ratio > 0 else size
        ask_size = size * min(1.0, max(0.0, 1.0 + inv_ratio)) if inv_ratio < 0 else size
        room_long = cfg.max_inventory - inventory
        room_short = cfg.max_inventory + inventory
        bid_size = min(bid_size, max(room_long, 0.0))
        ask_size = min(ask_size, max(room_short, 0.0))
        bid_size = math.floor(bid_size) if bid_size >= market.min_size else 0.0
        ask_size = math.floor(ask_size) if ask_size >= market.min_size else 0.0

        return Quote(
            bid_price=bid if bid_size > 0 else None,
            bid_size=bid_size,
            ask_price=ask if ask_size > 0 else None,
            ask_size=ask_size,
            fair=fair,
            reservation=reservation,
            half_spread=half,
        )
