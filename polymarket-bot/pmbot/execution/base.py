"""Executor interface shared by paper and live trading."""

from __future__ import annotations

from abc import ABC, abstractmethod

from pmbot.models import Fill, Order, OrderBook, Side


class Executor(ABC):
    @abstractmethod
    def place_limit(self, token_id: str, side: Side, price: float, size: float, tag: str = "",
                    post_only: bool = True, book: OrderBook | None = None) -> Order | None:
        """Place a resting (maker) limit order."""

    @abstractmethod
    def place_taker(self, token_id: str, side: Side, limit_price: float, size: float, tag: str = "",
                    book: OrderBook | None = None) -> Fill | None:
        """Fill-and-kill order that takes liquidity up to `limit_price`."""

    @abstractmethod
    def cancel(self, order_id: str) -> None: ...

    @abstractmethod
    def cancel_all(self) -> None: ...

    @abstractmethod
    def open_orders(self) -> list[Order]: ...

    @abstractmethod
    def poll_fills(self, books: dict[str, OrderBook]) -> list[Fill]:
        """Return new fills since the last call."""
