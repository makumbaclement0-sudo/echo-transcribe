"""Pre-trade risk checks and the kill switch."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from pmbot.config import RiskConfig
from pmbot.models import OrderBook

log = logging.getLogger(__name__)


@dataclass
class RiskDecision:
    allowed: bool
    reason: str = ""


class RiskManager:
    def __init__(self, cfg: RiskConfig):
        self.cfg = cfg
        self.killed = False
        self.kill_reason = ""
        self.day_start_equity: float | None = None
        self._day = time.gmtime().tm_yday

    def check_kill_switch(self, equity: float) -> bool:
        """Trips (and stays tripped) once the daily loss limit is hit."""
        today = time.gmtime().tm_yday
        if self.day_start_equity is None or today != self._day:
            self.day_start_equity = equity
            self._day = today
        loss = self.day_start_equity - equity
        if not self.killed and loss >= self.cfg.max_daily_loss:
            self.killed = True
            self.kill_reason = f"daily loss {loss:.2f} >= limit {self.cfg.max_daily_loss:.2f}"
            log.error("KILL SWITCH: %s", self.kill_reason)
        return self.killed

    def book_fresh(self, book: OrderBook, now: float | None = None) -> bool:
        now = now or time.time()
        return (now - book.timestamp) <= self.cfg.stale_book_s

    def check_order(self, *, price: float, size: float, market_exposure: float, total_exposure: float,
                    open_orders: int, increases_exposure: bool) -> RiskDecision:
        if self.killed:
            return RiskDecision(False, "kill switch")
        if open_orders >= self.cfg.max_open_orders:
            return RiskDecision(False, "max open orders")
        if not increases_exposure:
            return RiskDecision(True)
        notional = price * size
        if market_exposure + notional > self.cfg.max_market_notional:
            return RiskDecision(False, f"market notional {market_exposure + notional:.0f} > {self.cfg.max_market_notional:.0f}")
        if total_exposure + notional > self.cfg.max_total_notional:
            return RiskDecision(False, f"total notional {total_exposure + notional:.0f} > {self.cfg.max_total_notional:.0f}")
        return RiskDecision(True)
