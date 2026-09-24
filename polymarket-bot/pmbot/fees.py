"""Polymarket fee, maker-rebate and liquidity-reward math.

Source: docs.polymarket.com (Trading > Fees, Programs > Maker Rebates,
Programs > Liquidity Rewards), checked September 2026.

* Taker fee:          fee = C * rate * (p * (1 - p)) ** exponent
                      (C = shares, p = price). Makers pay nothing.
* Maker rebate:       each maker fill earns a "fee equivalent" computed with
                      the same formula; the market's daily pool
                      (rebate_rate * taker fees) is split pro-rata. Since every
                      trade has exactly one maker side, a maker's expected
                      rebate ~= rebate_rate * fee_equivalent of its own fills.
* Liquidity rewards:  resting orders within `max_spread` cents of the
                      adjusted midpoint score S = ((v - s) / v) ** 2 * size.
"""

from __future__ import annotations

from pmbot.models import FeeSchedule


def taker_fee(shares: float, price: float, fees: FeeSchedule) -> float:
    if fees.rate <= 0 or shares <= 0:
        return 0.0
    p = min(max(price, 0.0), 1.0)
    return round(shares * fees.rate * (p * (1.0 - p)) ** fees.exponent, 5)


def taker_fee_per_share(price: float, fees: FeeSchedule) -> float:
    if fees.rate <= 0:
        return 0.0
    p = min(max(price, 0.0), 1.0)
    return fees.rate * (p * (1.0 - p)) ** fees.exponent


def expected_maker_rebate(shares: float, price: float, fees: FeeSchedule) -> float:
    """Expected rebate for a filled maker order (see module docstring)."""
    if fees.rebate_rate <= 0:
        return 0.0
    p = min(max(price, 0.0), 1.0)
    fee_equivalent = shares * fees.rate * (p * (1.0 - p)) ** fees.exponent
    return fee_equivalent * fees.rebate_rate


def reward_order_score(max_spread_cents: float, spread_cents: float, size: float, multiplier: float = 1.0) -> float:
    """Quadratic liquidity-reward score of one resting order."""
    if max_spread_cents <= 0 or spread_cents >= max_spread_cents or size <= 0:
        return 0.0
    return ((max_spread_cents - spread_cents) / max_spread_cents) ** 2 * size * multiplier


def two_sided_reward_score(q_one: float, q_two: float, mid: float, c: float = 3.0) -> float:
    """Combine the two book sides the way Polymarket does (Q_min)."""
    if 0.10 <= mid <= 0.90:
        return max(min(q_one, q_two), max(q_one / c, q_two / c))
    return min(q_one, q_two)
