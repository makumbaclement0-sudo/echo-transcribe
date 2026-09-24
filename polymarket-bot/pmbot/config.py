"""Bot configuration. Defaults are deliberately conservative.

Override any field with a TOML file (`--config my.toml`), using the section
names below, e.g.:

    [mm]
    order_size = 50
    [risk]
    max_daily_loss = 25
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path


@dataclass
class ScannerConfig:
    max_markets: int = 8               # markets quoted simultaneously
    universe: int = 400                # markets pulled from Gamma to rank
    min_volume_24h: float = 5_000.0    # need flow to earn the spread
    min_liquidity: float = 2_000.0
    min_mid: float = 0.08              # avoid tails: tiny edge, lottery risk
    max_mid: float = 0.92
    min_hours_to_end: float = 24.0     # resolution/news risk spikes near the end
    max_spread: float = 0.10           # wider than this = illiquid / stale
    avoid_live_games: bool = True      # in-play sports = heavily informed flow
    prefer_rewards: bool = True        # rank liquidity-reward markets higher
    exclude_keywords: tuple[str, ...] = ()
    # Crypto price markets are priced off exchange feeds that fast bots watch
    # tick by tick; a polling bot quoting there is mostly the one being picked off.
    avoid_crypto_price: bool = True
    crypto_keywords: tuple[str, ...] = ("bitcoin", "btc", "ethereum", "eth ", "solana", "xrp", "dogecoin",
                                        "up or down", "fdv")


@dataclass
class MarketMakerConfig:
    order_size: float = 25.0            # shares per quote
    min_half_spread: float = 0.005      # never quote tighter than this; 0.005 = join a 1c book
    vol_multiplier: float = 2.0         # half spread >= vol_multiplier * short-term vol
    inventory_skew: float = 0.02        # price shift at max inventory
    max_inventory: float = 200.0        # net YES-equivalent shares per market
    target_rewards: bool = True         # keep quotes inside rewardsMaxSpread if cheap to do so
    use_microprice: bool = True
    requote_threshold_ticks: int = 1    # only replace an order if price moved >= this
    vol_halflife_s: float = 60.0
    pull_on_vol_spike: float = 0.03     # stop quoting a market if 1-tick vol exceeds this


@dataclass
class ArbConfig:
    enabled: bool = True
    min_edge: float = 0.005             # profit per $1 set after fees
    max_set_size: float = 200.0         # max sets per opportunity
    include_neg_risk_events: bool = True


@dataclass
class RiskConfig:
    starting_cash: float = 1_000.0      # paper bankroll
    max_market_notional: float = 150.0  # $ at risk per market
    max_total_notional: float = 600.0   # $ at risk across all markets
    max_daily_loss: float = 50.0        # kill switch (realised + unrealised)
    max_open_orders: int = 40
    stale_book_s: float = 30.0          # don't quote on data older than this


@dataclass
class PaperConfig:
    queue_trade_share: float = 0.5      # share of size drop at our level assumed to be trades
    assume_fill_on_trade_through: bool = True


@dataclass
class EngineConfig:
    poll_interval_s: float = 2.0
    rescan_interval_s: float = 900.0
    report_interval_s: float = 30.0
    run_dir: str = "runs"


@dataclass
class BotConfig:
    scanner: ScannerConfig = field(default_factory=ScannerConfig)
    mm: MarketMakerConfig = field(default_factory=MarketMakerConfig)
    arb: ArbConfig = field(default_factory=ArbConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
    paper: PaperConfig = field(default_factory=PaperConfig)
    engine: EngineConfig = field(default_factory=EngineConfig)

    @classmethod
    def load(cls, path: str | Path | None) -> "BotConfig":
        cfg = cls()
        if path:
            with open(path, "rb") as fh:
                _apply(cfg, tomllib.load(fh))
        return cfg


def _apply(obj, values: dict) -> None:
    known = {f.name: f for f in fields(obj)}
    for key, value in values.items():
        if key not in known:
            raise ValueError(f"unknown config key {key!r} in [{type(obj).__name__}]")
        current = getattr(obj, key)
        if is_dataclass(current):
            _apply(current, value)
        elif isinstance(current, tuple):
            setattr(obj, key, tuple(value))
        else:
            setattr(obj, key, type(current)(value) if current is not None else value)
