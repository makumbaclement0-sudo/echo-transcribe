"""Complete-set ("sum-to-one") arbitrage detection.

Exactly one outcome of a market pays $1, so:

* Binary BUY arb:   ask(YES) + ask(NO) + taker fees < 1
      -> buy both, merge (or hold to resolution) for a locked $1.
* Binary SELL arb:  bid(YES) + bid(NO) - taker fees > 1
      -> split $1 into YES+NO and sell both.
* Neg-risk event:   a multi-outcome event (e.g. "Fed decision": cut / hold /
      hike) where exactly one market resolves YES.
      sum(ask YES_i) + fees < 1  -> buy every YES.
      (Buying every NO costs sum(ask NO_i) and pays N-1.)

These are the only truly risk-free trades on Polymarket, and professional
bots close them within milliseconds, so expect them to be rare, small and
contested. Risks that remain: legging (one leg fills, the other doesn't) and,
for neg-risk events, an outcome that isn't listed ("Other") resolving YES.
"""

from __future__ import annotations

from dataclasses import dataclass

from pmbot.fees import taker_fee_per_share
from pmbot.models import Market, OrderBook, Side


@dataclass
class ArbLeg:
    token_id: str
    side: Side
    price: float   # worst price walked to
    avg_price: float
    label: str


@dataclass
class ArbOpportunity:
    kind: str  # "binary-buy", "binary-sell", "negrisk-buy-yes", "negrisk-buy-no"
    title: str
    sets: float
    edge_per_set: float  # $ profit per complete set after fees
    legs: list[ArbLeg]

    @property
    def profit(self) -> float:
        return self.sets * self.edge_per_set


def _best_depth_trade(books: list[OrderBook], side: Side, max_sets: float, fee_fn, payout: float,
                      min_edge: float) -> tuple[float, float, list[tuple[float, float]]]:
    """Grow the set size level by level and keep the most profitable size.

    Returns (sets, edge_per_set, [(worst_price, avg_price) per book]).
    """
    # candidate sizes: cumulative sizes at every level boundary in any book
    levels = [(b.asks if side is Side.BUY else b.bids) for b in books]
    if any(not lv for lv in levels):
        return 0.0, 0.0, []
    cuts = sorted({round(sum(l.size for l in lv[:i + 1]), 6) for lv in levels for i in range(len(lv))})
    cuts = [c for c in cuts if c <= max_sets] + [max_sets]
    best = (0.0, 0.0, [])
    for size in cuts:
        if size <= 0:
            continue
        legs = []
        total = 0.0
        ok = True
        for book in books:
            filled, avg = book.sweep(side, size)
            if filled + 1e-9 < size:
                ok = False
                break
            worst = _worst_price(book, side, size)
            legs.append((worst, avg))
            total += avg + fee_fn(book.token_id, avg) * (1 if side is Side.BUY else -1)
        if not ok:
            break
        edge = (payout - total) if side is Side.BUY else (total - payout)
        if edge < min_edge:
            break  # the average only gets worse deeper in the book
        # keep the size with the largest *total* profit: past that point the
        # marginal sets lose money even while the average edge is positive
        if size * edge > best[0] * best[1] + 1e-12:
            best = (size, edge, legs)
    return best


def _worst_price(book: OrderBook, side: Side, size: float) -> float:
    levels = book.asks if side is Side.BUY else book.bids
    acc = 0.0
    for lvl in levels:
        acc += lvl.size
        if acc + 1e-9 >= size:
            return lvl.price
    return levels[-1].price


def binary_arbs(market: Market, yes: OrderBook, no: OrderBook, min_edge: float, max_sets: float) -> list[ArbOpportunity]:
    fee = lambda _tok, p: taker_fee_per_share(p, market.fees)  # noqa: E731
    out = []
    for side, kind, payout in ((Side.BUY, "binary-buy", 1.0), (Side.SELL, "binary-sell", 1.0)):
        sets, edge, legs = _best_depth_trade([yes, no], side, max_sets, fee, payout, min_edge)
        if sets >= market.min_size and legs:
            out.append(ArbOpportunity(
                kind=kind, title=market.question, sets=sets, edge_per_set=edge,
                legs=[ArbLeg(market.yes_token, side, legs[0][0], legs[0][1], market.outcomes[0]),
                      ArbLeg(market.no_token, side, legs[1][0], legs[1][1], market.outcomes[1])],
            ))
    return out


def negrisk_arbs(title: str, markets: list[Market], books: dict[str, OrderBook], min_edge: float,
                 max_sets: float) -> list[ArbOpportunity]:
    """Buy-all-YES / buy-all-NO across a complete neg-risk event."""
    if len(markets) < 2 or any(not m.accepting_orders for m in markets):
        return []
    fee_by_token = {}
    for m in markets:
        fee_by_token[m.yes_token] = m.fees
        fee_by_token[m.no_token] = m.fees
    fee = lambda tok, p: taker_fee_per_share(p, fee_by_token[tok])  # noqa: E731
    out = []
    n = len(markets)
    for kind, tokens, payout in (
        ("negrisk-buy-yes", [m.yes_token for m in markets], 1.0),
        ("negrisk-buy-no", [m.no_token for m in markets], float(n - 1)),
    ):
        bks = [books.get(t) for t in tokens]
        if any(b is None for b in bks):
            continue
        sets, edge, legs = _best_depth_trade(bks, Side.BUY, max_sets, fee, payout, min_edge)
        min_size = max(m.min_size for m in markets)
        if sets >= min_size and legs:
            out.append(ArbOpportunity(
                kind=kind, title=title, sets=sets, edge_per_set=edge,
                legs=[ArbLeg(t, Side.BUY, w, a, m.question) for t, (w, a), m in zip(tokens, legs, markets)],
            ))
    return out
