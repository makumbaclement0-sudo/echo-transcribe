"""Paper-trading executor: simulates fills against live order books.

Fill model for resting orders (deliberately pessimistic):

* When we join a price level we're placed at the back of its queue
  (`queue_ahead` = size already resting there).
* Each new book snapshot, if the size at our level shrank, a fraction
  (`queue_trade_share`) of the shrink is assumed to be trades that ate the
  queue ahead of us; once the queue is gone further trades fill us.
* If the market trades *through* our price (for a bid: best ask <= our
  price, or the best bid dropped below our price), we assume we were fully
  filled. That is the adverse-selection case: we got filled precisely because
  the price moved against us, and it's the main reason paper results
  flatter less than naive "filled at touch" simulators.

Taker (FAK) orders fill immediately against the current book.
"""

from __future__ import annotations

import itertools

from pmbot.config import PaperConfig
from pmbot.execution.base import Executor
from pmbot.fees import taker_fee
from pmbot.models import FeeSchedule, Fill, Order, OrderBook, Side


class PaperExecutor(Executor):
    def __init__(self, cfg: PaperConfig, fee_lookup: dict[str, FeeSchedule] | None = None):
        self.cfg = cfg
        self.orders: dict[str, Order] = {}
        self.fee_lookup = fee_lookup if fee_lookup is not None else {}
        self._ids = itertools.count(1)
        self._pending: list[Fill] = []
        self._last_level: dict[str, float] = {}  # order_id -> size at our level last snapshot

    def place_limit(self, token_id, side, price, size, tag="", post_only=True, book=None):
        if book is not None and post_only:
            if side is Side.BUY and book.best_ask is not None and price >= book.best_ask - 1e-9:
                return None  # would cross: rejected like a real post-only order
            if side is Side.SELL and book.best_bid is not None and price <= book.best_bid + 1e-9:
                return None
        oid = f"paper-{next(self._ids)}"
        ahead = book.size_at(side, price) if book is not None else 0.0
        order = Order(id=oid, token_id=token_id, side=side, price=price, size=size, tag=tag, queue_ahead=ahead)
        self.orders[oid] = order
        self._last_level[oid] = ahead
        return order

    def place_taker(self, token_id, side, limit_price, size, tag="", book=None):
        if book is None:
            return None
        filled, avg = book.sweep(side, size, limit_price)
        if filled <= 0:
            return None
        fee = taker_fee(filled, avg, self.fee_lookup.get(token_id, FeeSchedule()))
        return Fill(order_id=f"paper-{next(self._ids)}", token_id=token_id, side=side, price=avg,
                    size=filled, fee=fee, maker=False, tag=tag)

    def cancel(self, order_id):
        self.orders.pop(order_id, None)
        self._last_level.pop(order_id, None)

    def cancel_all(self):
        self.orders.clear()
        self._last_level.clear()

    def open_orders(self):
        return list(self.orders.values())

    def poll_fills(self, books):
        fills: list[Fill] = []
        for oid, order in list(self.orders.items()):
            book = books.get(order.token_id)
            if book is None:
                continue
            qty = self._simulate(order, book)
            if qty > 1e-9:
                order.filled += qty
                fills.append(Fill(order_id=oid, token_id=order.token_id, side=order.side, price=order.price,
                                  size=qty, fee=0.0, maker=True, tag=order.tag))
                if order.remaining <= 1e-9:
                    self.cancel(oid)
        return fills

    def _simulate(self, order: Order, book: OrderBook) -> float:
        p = order.price
        level_now = book.size_at(order.side, p)
        level_before = self._last_level.get(order.id, level_now)
        self._last_level[order.id] = level_now
        # Our own paper order is never in the real book, so "the book moved
        # past our price" only means a fill if the opposite side reached us,
        # or the level we were queued in was consumed and the price moved on.
        if order.side is Side.BUY:
            crossed = book.best_ask is not None and book.best_ask <= p + 1e-9
            moved_past = book.best_bid is None or book.best_bid < p - 1e-9
        else:
            crossed = book.best_bid is not None and book.best_bid >= p - 1e-9
            moved_past = book.best_ask is None or book.best_ask > p + 1e-9
        level_consumed = level_before > 0 and level_now <= 0 and moved_past
        if self.cfg.assume_fill_on_trade_through and (crossed or level_consumed):
            return order.remaining

        shrink = max(level_before - level_now, 0.0)
        if shrink <= 0:
            return 0.0
        traded = shrink * self.cfg.queue_trade_share
        eat_queue = min(order.queue_ahead, traded)
        order.queue_ahead -= eat_queue
        return min(traded - eat_queue, order.remaining)
