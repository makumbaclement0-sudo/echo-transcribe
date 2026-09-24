import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pmbot.models import FeeSchedule, Level, Market, OrderBook  # noqa: E402


def make_book(token: str, bids: list[tuple[float, float]], asks: list[tuple[float, float]], ts: float | None = None):
    book = OrderBook(token_id=token, bids=[Level(p, s) for p, s in bids], asks=[Level(p, s) for p, s in asks])
    if ts is not None:
        book.timestamp = ts
    return book


def make_market(**kw) -> Market:
    defaults = dict(id="1", condition_id="0xc", question="Will it happen?", slug="will-it", yes_token="Y",
                    no_token="N", tick=0.01, min_size=5, fees_enabled=True,
                    fees=FeeSchedule(rate=0.04, exponent=1, rebate_rate=0.25), rewards_min_size=0,
                    rewards_max_spread_cents=0, volume_24h=50_000, liquidity=20_000, best_bid=0.49, best_ask=0.51)
    defaults.update(kw)
    return Market(**defaults)


@pytest.fixture
def gamma_raw() -> dict:
    return {
        "id": "4883243", "question": "Will X win?", "conditionId": "0xabc", "slug": "will-x-win",
        "endDate": "2030-01-01T00:00:00Z", "outcomes": json.dumps(["Yes", "No"]),
        "clobTokenIds": json.dumps(["111", "222"]), "enableOrderBook": True, "orderPriceMinTickSize": 0.01,
        "orderMinSize": 5, "negRisk": False, "feesEnabled": True,
        "feeSchedule": {"exponent": 1, "rate": 0.05, "takerOnly": True, "rebateRate": 0.15},
        "rewardsMinSize": 50, "rewardsMaxSpread": 4.5, "volume24hrClob": 12345.6, "liquidityClob": 7000,
        "bestBid": 0.15, "bestAsk": 0.16, "acceptingOrders": True, "gameStartTime": "2029-12-31 09:20:00+00",
        "events": [{"id": "606422", "title": "Some event"}],
    }
