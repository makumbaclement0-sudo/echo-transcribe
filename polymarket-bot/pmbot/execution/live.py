"""Live executor on top of the official Polymarket Python SDK
(`pip install polymarket-client`, imported as `polymarket`).

Written against polymarket-client 0.11. Real money: keep limits tiny until
paper trading has shown an edge over weeks, not hours.

Fill detection polls `get_order` for every order we placed and turns
increases in `size_matched` into Fill events. Polling is simple and robust;
the SDK's authenticated user WebSocket is the upgrade path for lower latency.
"""

from __future__ import annotations

import logging
import os
from decimal import Decimal

from pmbot.execution.base import Executor
from pmbot.fees import taker_fee
from pmbot.models import FeeSchedule, Fill, Order, Side

log = logging.getLogger(__name__)

RISK_ACK_ENV = "PMBOT_I_UNDERSTAND_THE_RISKS"
RISK_ACK_VALUE = "yes-real-money"


class LiveTradingNotAcknowledged(RuntimeError):
    pass


class LiveExecutor(Executor):
    def __init__(self, fee_lookup: dict[str, FeeSchedule] | None = None, client=None):
        if os.environ.get(RISK_ACK_ENV) != RISK_ACK_VALUE:
            raise LiveTradingNotAcknowledged(
                f"Set {RISK_ACK_ENV}={RISK_ACK_VALUE} to enable live trading. "
                "Paper trade first; you can lose your entire balance."
            )
        if client is None:
            try:
                from polymarket import SecureClient
            except ImportError as exc:  # pragma: no cover - depends on optional dep
                raise RuntimeError("Live trading needs the SDK: pip install polymarket-client") from exc
            client = SecureClient.create(
                private_key=os.environ["POLYMARKET_PRIVATE_KEY"],
                wallet=os.environ.get("POLYMARKET_WALLET_ADDRESS") or None,
            )
        self.client = client
        self.fee_lookup = fee_lookup if fee_lookup is not None else {}
        self.orders: dict[str, Order] = {}

    def place_limit(self, token_id, side, price, size, tag="", post_only=True, book=None):
        resp = self.client.place_limit_order(
            token_id=token_id, side=side.value, price=_dec(price), size=_dec(size), post_only=post_only,
        )
        if not getattr(resp, "ok", False):
            log.warning("limit order rejected (%s %s @ %s x %s): %s %s", tag, side.value, price, size,
                        getattr(resp, "code", "?"), getattr(resp, "message", ""))
            return None
        order = Order(id=str(resp.order_id), token_id=token_id, side=side, price=price, size=size, tag=tag)
        self.orders[order.id] = order
        return order

    def place_taker(self, token_id, side, limit_price, size, tag="", book=None):
        if side is Side.BUY:
            resp = self.client.place_market_order(
                token_id=token_id, side="BUY", amount=_dec(size * limit_price), max_price=_dec(limit_price),
                order_type="FAK",
            )
        else:
            resp = self.client.place_market_order(
                token_id=token_id, side="SELL", shares=_dec(size), min_price=_dec(limit_price), order_type="FAK",
            )
        if not getattr(resp, "ok", False):
            log.warning("taker order not filled (%s): %s %s", tag, getattr(resp, "code", "?"),
                        getattr(resp, "message", ""))
            return None
        making, taking = float(resp.making_amount), float(resp.taking_amount)
        # BUY: we give pUSD (making) and get shares (taking); SELL is the reverse
        shares, usd = (taking, making) if side is Side.BUY else (making, taking)
        if shares <= 0:
            return None
        avg = usd / shares
        fee = taker_fee(shares, avg, self.fee_lookup.get(token_id, FeeSchedule()))
        return Fill(order_id=str(resp.order_id), token_id=token_id, side=side, price=avg, size=shares,
                    fee=fee, maker=False, tag=tag)

    def cancel(self, order_id):
        try:
            self.client.cancel_order(order_id=order_id)
        finally:
            self.orders.pop(order_id, None)

    def cancel_all(self):
        self.client.cancel_all()
        self.orders.clear()

    def open_orders(self):
        return list(self.orders.values())

    def poll_fills(self, books):
        fills = []
        for oid, order in list(self.orders.items()):
            try:
                remote = self.client.get_order(order_id=oid)
            except Exception as exc:  # network hiccup: try again next cycle
                log.warning("get_order %s failed: %s", oid, exc)
                continue
            matched = float(remote.size_matched)
            delta = matched - order.filled
            if delta > 1e-9:
                order.filled = matched
                fills.append(Fill(order_id=oid, token_id=order.token_id, side=order.side, price=order.price,
                                  size=delta, fee=0.0, maker=True, tag=order.tag))
            status = str(getattr(remote, "status", "")).lower()
            if order.remaining <= 1e-9 or status in {"matched", "canceled", "cancelled", "expired"}:
                self.orders.pop(oid, None)
        return fills

    def merge(self, condition_id: str, shares: int) -> None:
        """Merge YES+NO pairs back into pUSD (frees capital before resolution)."""
        self.client.merge_positions(condition_id=condition_id, amount=int(shares))


def _dec(x: float) -> Decimal:
    return Decimal(str(round(x, 6)))
