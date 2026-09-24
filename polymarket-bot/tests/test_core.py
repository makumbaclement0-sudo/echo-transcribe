from datetime import datetime, timezone

import pytest

from conftest import make_book, make_market
from pmbot.config import BotConfig, MarketMakerConfig, PaperConfig, RiskConfig, ScannerConfig
from pmbot.execution.paper import PaperExecutor
from pmbot.fees import expected_maker_rebate, reward_order_score, taker_fee, two_sided_reward_score
from pmbot.models import FeeSchedule, Fill, Market, Side
from pmbot.portfolio import Portfolio
from pmbot.risk import RiskManager
from pmbot.scanner import filter_reasons, select_markets
from pmbot.strategies.complete_set import binary_arbs, negrisk_arbs
from pmbot.strategies.market_maker import MarketMaker, VolEstimator


# -- fees: values straight from the fee tables in Polymarket's docs ---------------
@pytest.mark.parametrize("rate,price,expected", [
    (0.07, 0.50, 1.75), (0.07, 0.10, 0.63), (0.05, 0.30, 1.05), (0.05, 0.99, 0.05), (0.04, 0.45, 0.99),
])
def test_taker_fee_matches_docs(rate, price, expected):
    assert taker_fee(100, price, FeeSchedule(rate=rate)) == pytest.approx(expected, abs=0.006)


def test_fee_free_market_and_rebate():
    assert taker_fee(100, 0.5, FeeSchedule()) == 0.0
    fees = FeeSchedule(rate=0.04, rebate_rate=0.25)
    assert expected_maker_rebate(100, 0.5, fees) == pytest.approx(100 * 0.04 * 0.25 * 0.25)


def test_reward_scores():
    assert reward_order_score(3.0, 0.0, 100) == 100
    assert reward_order_score(3.0, 1.5, 100) == pytest.approx(25)
    assert reward_order_score(3.0, 3.0, 100) == 0
    # single-sided liquidity is scored at 1/3 in the middle of the range, not at all at the tails
    assert two_sided_reward_score(90, 0, mid=0.5) == pytest.approx(30)
    assert two_sided_reward_score(90, 0, mid=0.05) == 0


# -- models ---------------------------------------------------------------------
def test_market_from_gamma(gamma_raw):
    m = Market.from_gamma(gamma_raw)
    assert (m.yes_token, m.no_token) == ("111", "222")
    assert m.fees.rate == 0.05 and m.fees.rebate_rate == 0.15
    assert m.rewards_max_spread_cents == 4.5 and m.rewards_min_size == 50
    assert m.game_start == datetime(2029, 12, 31, 9, 20, tzinfo=timezone.utc)
    assert m.event_id == "606422"


def test_market_from_gamma_rejects_non_binary(gamma_raw):
    gamma_raw["clobTokenIds"] = '["1","2","3"]'
    assert Market.from_gamma(gamma_raw) is None


def test_book_sweep_and_microprice():
    b = make_book("Y", [(0.48, 100), (0.47, 200)], [(0.50, 50), (0.51, 100)])
    filled, avg = b.sweep(Side.BUY, 100)
    assert filled == 100 and avg == pytest.approx(0.505)
    assert b.sweep(Side.BUY, 100, limit_price=0.50) == (50, 0.50)
    # more size on the bid -> microprice leans up toward the ask
    assert b.microprice() > b.mid


# -- arbitrage ------------------------------------------------------------------
def test_binary_buy_arb_found_after_fees():
    m = make_market(fees=FeeSchedule())
    yes = make_book("Y", [(0.45, 100)], [(0.47, 100), (0.50, 100)])
    no = make_book("N", [(0.49, 100)], [(0.50, 60), (0.52, 100)])
    opps = binary_arbs(m, yes, no, min_edge=0.005, max_sets=500)
    buy = [o for o in opps if o.kind == "binary-buy"]
    assert len(buy) == 1
    # 60 sets at 0.97, 40 more at 0.99 (still profitable), then 1.02 (not)
    assert buy[0].sets == 100
    assert buy[0].profit == pytest.approx(60 * 0.03 + 40 * 0.01)


def test_fees_can_kill_an_arb():
    yes = make_book("Y", [], [(0.49, 100)])
    no = make_book("N", [], [(0.50, 100)])
    assert binary_arbs(make_market(fees=FeeSchedule()), yes, no, 0.005, 500)  # 1c edge, no fees
    assert not binary_arbs(make_market(fees=FeeSchedule(rate=0.07)), yes, no, 0.005, 500)


def test_binary_sell_arb():
    yes = make_book("Y", [(0.52, 100)], [])
    no = make_book("N", [(0.50, 100)], [])
    opps = binary_arbs(make_market(fees=FeeSchedule()), yes, no, 0.005, 500)
    assert [o.kind for o in opps] == ["binary-sell"]


def test_negrisk_arb():
    ms = [make_market(id=str(i), yes_token=f"Y{i}", no_token=f"N{i}", fees=FeeSchedule()) for i in range(3)]
    books = {}
    for i, ask in enumerate([0.30, 0.30, 0.35]):
        books[f"Y{i}"] = make_book(f"Y{i}", [], [(ask, 100)])
        books[f"N{i}"] = make_book(f"N{i}", [], [(0.99, 100)])
    opps = negrisk_arbs("event", ms, books, 0.005, 500)
    assert [o.kind for o in opps] == ["negrisk-buy-yes"]
    assert opps[0].edge_per_set == pytest.approx(0.05)


# -- market maker ---------------------------------------------------------------
def test_quotes_never_cross_and_skew_with_inventory():
    mm = MarketMaker(MarketMakerConfig(order_size=20, min_half_spread=0.01, max_inventory=100, inventory_skew=0.02,
                                       use_microprice=False))
    m = make_market()
    book = make_book("Y", [(0.45, 100)], [(0.55, 100)])
    flat = mm.quote(m, book, inventory=0)
    assert flat.bid_price < 0.55 and flat.ask_price > 0.45 and flat.bid_price < flat.ask_price
    long = mm.quote(m, book, inventory=50)
    assert long.bid_price < flat.bid_price and long.bid_size < flat.bid_size
    maxed = mm.quote(m, book, inventory=100)
    assert maxed.bid_price is None and maxed.ask_size > 0


def test_post_only_joins_tight_book():
    mm = MarketMaker(MarketMakerConfig(min_half_spread=0.005, use_microprice=False))
    q = mm.quote(make_market(), make_book("Y", [(0.50, 100)], [(0.51, 100)]), 0)
    assert (q.bid_price, q.ask_price) == (0.50, 0.51)


def test_reward_band_tightening():
    cfg = MarketMakerConfig(min_half_spread=0.01, vol_multiplier=2.0, use_microprice=False)
    m = make_market(rewards_max_spread_cents=3.0)
    mm = MarketMaker(cfg)
    mm.vols[m.id] = VolEstimator(60)
    mm.vols[m.id].var_per_s = 0.02 ** 2 / 10  # sigma(10s) = 0.02 -> vol-based half spread 0.04
    q = mm.quote(m, make_book("Y", [(0.40, 100)], [(0.60, 100)]), 0)
    assert q.half_spread == pytest.approx(0.02)  # pulled inside the 3c reward band
    cfg.min_half_spread = 0.025  # ...but never tighter than our minimum edge
    assert mm.quote(m, make_book("Y", [(0.40, 100)], [(0.60, 100)]), 0).half_spread == pytest.approx(0.04)


# -- portfolio ------------------------------------------------------------------
def test_round_trip_and_merge_accounting():
    pf = Portfolio(100)
    pf.register_market("Y", "N")
    pf.apply_fill(Fill("1", "Y", Side.BUY, 0.40, 10))
    pf.apply_fill(Fill("2", "Y", Side.SELL, 0.45, 10))
    assert pf.realized_pnl == pytest.approx(0.5)
    pf.apply_fill(Fill("3", "Y", Side.BUY, 0.40, 10))
    pf.apply_fill(Fill("4", "N", Side.BUY, 0.58, 10))  # auto-merges into $10
    assert pf.position("Y") == 0 and pf.position("N") == 0
    assert pf.realized_pnl == pytest.approx(0.5 + 0.2)
    assert pf.cash == pytest.approx(100.7)
    assert pf.stats()["win_rate"] == 1.0


def test_resolution_loss_counts_as_losing_trip():
    pf = Portfolio(100)
    pf.register_market("Y", "N")
    pf.apply_fill(Fill("1", "Y", Side.BUY, 0.60, 10))
    pf.resolve("Y", "N", yes_won=False)
    assert pf.realized_pnl == pytest.approx(-6.0)
    assert pf.stats()["win_rate"] == 0.0


def test_selling_more_than_held_raises():
    pf = Portfolio(100)
    with pytest.raises(ValueError):
        pf.apply_fill(Fill("1", "Y", Side.SELL, 0.5, 5))


# -- paper execution ------------------------------------------------------------
def test_paper_post_only_rejects_crossing_orders():
    ex = PaperExecutor(PaperConfig())
    book = make_book("Y", [(0.49, 100)], [(0.51, 100)])
    assert ex.place_limit("Y", Side.BUY, 0.51, 10, book=book) is None
    assert ex.place_limit("Y", Side.BUY, 0.49, 10, book=book) is not None


def test_paper_queue_model():
    ex = PaperExecutor(PaperConfig(queue_trade_share=1.0))
    ex.place_limit("Y", Side.BUY, 0.49, 10, book=make_book("Y", [(0.49, 100)], [(0.51, 100)]))
    # 60 shares traded at our level: all queue ahead of us
    assert ex.poll_fills({"Y": make_book("Y", [(0.49, 40)], [(0.51, 100)])}) == []
    # new orders join behind us; no trades yet
    assert ex.poll_fills({"Y": make_book("Y", [(0.49, 80)], [(0.51, 100)])}) == []
    # 45 more traded: the last 40 ahead of us, then 5 of ours
    fills = ex.poll_fills({"Y": make_book("Y", [(0.49, 35)], [(0.51, 100)])})
    assert [f.size for f in fills] == [pytest.approx(5)]
    # the level is wiped out and the price moves below us: we're fully filled
    fills = ex.poll_fills({"Y": make_book("Y", [(0.48, 100)], [(0.50, 100)])})
    assert [f.size for f in fills] == [pytest.approx(5)]
    assert ex.open_orders() == []


def test_paper_inside_spread_order_fills_only_when_crossed():
    ex = PaperExecutor(PaperConfig())
    book = make_book("Y", [(0.48, 100)], [(0.52, 100)])
    ex.place_limit("Y", Side.BUY, 0.50, 10, book=book)
    assert ex.poll_fills({"Y": make_book("Y", [(0.47, 100)], [(0.52, 100)])}) == []
    fills = ex.poll_fills({"Y": make_book("Y", [(0.47, 100)], [(0.50, 100)])})
    assert len(fills) == 1 and fills[0].size == 10 and fills[0].maker


def test_paper_taker_fill_pays_fee():
    ex = PaperExecutor(PaperConfig(), fee_lookup={"Y": FeeSchedule(rate=0.07)})
    fill = ex.place_taker("Y", Side.BUY, 0.50, 100, book=make_book("Y", [], [(0.50, 100)]))
    assert fill.size == 100 and fill.fee == pytest.approx(1.75) and not fill.maker


# -- risk & scanner -------------------------------------------------------------
def test_kill_switch_trips_and_stays_tripped():
    rm = RiskManager(RiskConfig(max_daily_loss=10))
    assert not rm.check_kill_switch(1000)
    assert rm.check_kill_switch(989)
    assert rm.check_kill_switch(2000)
    assert not rm.check_order(price=0.5, size=10, market_exposure=0, total_exposure=0, open_orders=0,
                              increases_exposure=False).allowed


def test_notional_limits():
    rm = RiskManager(RiskConfig(max_market_notional=100, max_total_notional=150))
    ok = dict(price=0.5, size=100, open_orders=0, increases_exposure=True)
    assert rm.check_order(market_exposure=0, total_exposure=0, **ok).allowed
    assert not rm.check_order(market_exposure=60, total_exposure=60, **ok).allowed
    assert not rm.check_order(market_exposure=0, total_exposure=120, **ok).allowed


def test_scanner_filters_and_diversifies():
    cfg = ScannerConfig(max_markets=5)
    good = make_market(id="a", event_id="e1")
    sibling = make_market(id="b", event_id="e1", volume_24h=40_000)
    tail = make_market(id="c", best_bid=0.01, best_ask=0.02)
    crypto = make_market(id="d", question="Will Bitcoin hit $200k?")
    picked = [s.market.id for s in select_markets([good, sibling, tail, crypto], cfg)]
    assert picked == ["a"]
    assert any("crypto" in r for r in filter_reasons(crypto, cfg))


def test_config_toml(tmp_path):
    p = tmp_path / "c.toml"
    p.write_text("[mm]\norder_size = 40\n[risk]\nmax_daily_loss = 5\n[scanner]\nexclude_keywords = ['nba']\n")
    cfg = BotConfig.load(p)
    assert cfg.mm.order_size == 40 and cfg.risk.max_daily_loss == 5 and cfg.scanner.exclude_keywords == ("nba",)
    p.write_text("[mm]\nnope = 1\n")
    with pytest.raises(ValueError):
        BotConfig.load(p)
