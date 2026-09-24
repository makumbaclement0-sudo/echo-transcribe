"""Market selection: which markets are worth making a market in.

A market maker earns (spread captured + rebates + liquidity rewards) and pays
(adverse selection: getting filled right before the price moves against you).
Good markets have steady two-way flow, a price away from 0/1, a long time to
resolution and no scheduled "information events" (live games, data releases).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone

from pmbot.config import ScannerConfig
from pmbot.models import Market


@dataclass
class ScoredMarket:
    market: Market
    score: float
    reasons: list[str]


def filter_reasons(m: Market, cfg: ScannerConfig, now: datetime | None = None) -> list[str]:
    """Reasons to reject a market (empty list = tradable)."""
    now = now or datetime.now(timezone.utc)
    out = []
    if not m.accepting_orders:
        out.append("not accepting orders")
    if m.volume_24h < cfg.min_volume_24h:
        out.append(f"volume24h {m.volume_24h:,.0f} < {cfg.min_volume_24h:,.0f}")
    if m.liquidity < cfg.min_liquidity:
        out.append(f"liquidity {m.liquidity:,.0f} < {cfg.min_liquidity:,.0f}")
    if m.best_bid is None or m.best_ask is None:
        out.append("no two-sided book")
    else:
        mid = (m.best_bid + m.best_ask) / 2
        if not cfg.min_mid <= mid <= cfg.max_mid:
            out.append(f"mid {mid:.3f} outside [{cfg.min_mid}, {cfg.max_mid}]")
        if m.best_ask - m.best_bid > cfg.max_spread + 1e-9:
            out.append(f"spread {m.best_ask - m.best_bid:.3f} too wide")
    if m.hours_to_end(now) < cfg.min_hours_to_end:
        out.append(f"ends in {m.hours_to_end(now):.1f}h")
    if cfg.avoid_live_games and m.game_start is not None:
        hours_to_start = (m.game_start - now).total_seconds() / 3600
        if hours_to_start < 1:
            out.append("game live or starting within 1h")
    text = (m.question + " " + (m.event_title or "")).lower()
    for kw in cfg.exclude_keywords:
        if kw.lower() in text:
            out.append(f"excluded keyword {kw!r}")
    if cfg.avoid_crypto_price and any(kw in text for kw in cfg.crypto_keywords):
        out.append("crypto price market (latency-sensitive)")
    return out


def score_market(m: Market, cfg: ScannerConfig) -> float:
    """Higher is better. Heuristic: flow * room-to-earn * incentives."""
    mid = (m.best_bid + m.best_ask) / 2 if m.best_bid is not None and m.best_ask is not None else 0.5
    spread = (m.best_ask - m.best_bid) if m.best_bid is not None and m.best_ask is not None else 0.0
    flow = math.log10(1 + m.volume_24h)
    # spreads > 1 tick leave room to quote inside the book
    room = 1.0 + min(spread / max(m.tick, 1e-6), 5) * 0.2
    # p(1-p) peaks at 0.5: more two-way uncertainty, larger fee-curve rebates
    centrality = 0.5 + 2 * mid * (1 - mid)
    incentives = 1.0
    if cfg.prefer_rewards and m.rewards_max_spread_cents > 0:
        incentives += 0.5
    if m.fees_enabled and m.fees.rebate_rate > 0:
        incentives += 0.25
    return flow * room * centrality * incentives


def select_markets(markets: list[Market], cfg: ScannerConfig, now: datetime | None = None) -> list[ScoredMarket]:
    scored = []
    for m in markets:
        if filter_reasons(m, cfg, now):
            continue
        scored.append(ScoredMarket(m, score_market(m, cfg), []))
    scored.sort(key=lambda s: s.score, reverse=True)
    # one market per event: sibling markets (e.g. "25bps cut" / "no change")
    # are highly correlated, so spreading across events diversifies risk
    seen_events: set[str] = set()
    picked = []
    for s in scored:
        key = s.market.event_id or s.market.id
        if key in seen_events:
            continue
        seen_events.add(key)
        picked.append(s)
        if len(picked) >= cfg.max_markets:
            break
    return picked
