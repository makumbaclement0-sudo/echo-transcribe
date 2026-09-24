import pytest

from conftest import make_book, make_market
from pmbot.audit import audit_wallet
from pmbot.backtest import SimParams, simulate
from pmbot.config import BotConfig
from pmbot.engine import Engine
from pmbot.execution.live import LiveExecutor, LiveTradingNotAcknowledged
from pmbot.execution.paper import PaperExecutor
from pmbot.models import Side
from pmbot.portfolio import Portfolio


class FakeGamma:
    def __init__(self, markets):
        self._markets = markets

    def active_markets(self, n):
        return self._markets[:n]


class FakeClob:
    def __init__(self):
        self.books_by_token = {}

    def books(self, tokens):
        return {t: self.books_by_token[t] for t in tokens if t in self.books_by_token}


def _engine(tmp_path):
    cfg = BotConfig()
    cfg.engine.run_dir = str(tmp_path)
    cfg.mm.order_size = 20
    cfg.mm.min_half_spread = 0.01
    cfg.mm.use_microprice = False
    cfg.arb.enabled = False
    m = make_market(event_id="e1")
    clob = FakeClob()
    clob.books_by_token = {"Y": make_book("Y", [(0.45, 100)], [(0.55, 100)]),
                           "N": make_book("N", [(0.45, 100)], [(0.55, 100)])}
    pf = Portfolio(1000)
    eng = Engine(cfg, PaperExecutor(cfg.paper), pf, gamma=FakeGamma([m]), clob=clob)
    return eng, clob, pf


def test_engine_quotes_both_sides(tmp_path):
    eng, _clob, _pf = _engine(tmp_path)
    eng.step()
    orders = sorted(eng.executor.open_orders(), key=lambda o: o.tag)
    assert [(o.tag, o.token_id, o.side) for o in orders] == [("mm-ask", "N", Side.BUY), ("mm-bid", "Y", Side.BUY)]
    bid, ask_as_no = orders[1], orders[0]
    assert bid.price < 0.55 and 1 - ask_as_no.price > 0.45


def test_engine_processes_fill_and_skews(tmp_path):
    eng, clob, pf = _engine(tmp_path)
    eng.step()
    bid = next(o for o in eng.executor.open_orders() if o.tag == "mm-bid")
    # sellers sweep down through our bid
    clob.books_by_token["Y"] = make_book("Y", [(0.40, 100)], [(bid.price, 100)])
    clob.books_by_token["N"] = make_book("N", [(1 - bid.price, 100)], [(0.60, 100)])
    eng.step()
    assert pf.position("Y") == 20
    assert pf.rebates_earned > 0
    assert (tmp_path / eng.run_dir.name / "fills.jsonl").exists()
    # now long: the ask side should be a SELL of the YES we hold
    ask = next(o for o in eng.executor.open_orders() if o.tag == "mm-ask")
    assert ask.side is Side.SELL and ask.token_id == "Y"


def test_engine_kill_switch_cancels_everything(tmp_path):
    eng, _clob, _pf = _engine(tmp_path)
    eng.step()
    assert eng.executor.open_orders()
    eng.cfg.risk.max_daily_loss = 0.0
    eng.risk.cfg.max_daily_loss = 0.0
    eng.risk.day_start_equity = 10_000  # pretend we started the day much richer
    eng.step()
    assert eng.risk.killed and eng.executor.open_orders() == []


def test_live_requires_explicit_ack(monkeypatch):
    monkeypatch.delenv("PMBOT_I_UNDERSTAND_THE_RISKS", raising=False)
    with pytest.raises(LiveTradingNotAcknowledged):
        LiveExecutor(client=object())


def test_live_executor_maps_sdk_calls(monkeypatch):
    monkeypatch.setenv("PMBOT_I_UNDERSTAND_THE_RISKS", "yes-real-money")

    class Resp:
        ok = True
        order_id = "abc"

    class Remote:
        size_matched = "7"
        status = "live"

    class FakeSdk:
        def __init__(self):
            self.calls = []

        def place_limit_order(self, **kw):
            self.calls.append(kw)
            return Resp()

        def get_order(self, order_id):
            return Remote()

    sdk = FakeSdk()
    ex = LiveExecutor(client=sdk)
    order = ex.place_limit("Y", Side.BUY, 0.45, 20, tag="mm-bid")
    assert order.id == "abc" and sdk.calls[0]["post_only"] is True and str(sdk.calls[0]["price"]) == "0.45"
    fills = ex.poll_fills({})
    assert len(fills) == 1 and fills[0].size == 7 and fills[0].maker


def test_backtest_is_deterministic_and_toxic_flow_hurts():
    base = dict(days=3, markets=2, dt=30, market_life_days=2, seed=3)
    a, b = simulate(SimParams(**base)), simulate(SimParams(**base))
    assert a.pnl == b.pnl and a.fills == b.fills > 0
    toxic = simulate(SimParams(**base, informed_rate_per_hour=40, jump_rate_per_day=10, jump_sweep_prob=1.0))
    assert toxic.informed_fills > a.informed_fills
    assert toxic.spread_pnl < a.spread_pnl
    assert a.resolutions > 0


def test_audit_wallet_cashflows():
    class Http:
        def get(self, path, **params):
            if path == "/activity":
                return [
                    {"type": "TRADE", "side": "BUY", "usdcSize": 60, "conditionId": "c1", "timestamp": 1000,
                     "transactionHash": "a", "asset": "y1", "size": 100},
                    {"type": "TRADE", "side": "SELL", "usdcSize": 70, "conditionId": "c1", "timestamp": 2000,
                     "transactionHash": "b", "asset": "y1", "size": 100},
                    {"type": "TRADE", "side": "BUY", "usdcSize": 50, "conditionId": "c2", "timestamp": 3000,
                     "transactionHash": "c", "asset": "y2", "size": 100},
                    {"type": "REWARD", "usdcSize": 5, "conditionId": "", "timestamp": 4000,
                     "transactionHash": "d", "asset": "", "size": 5},
                ]
            if path == "/positions":
                return [{"conditionId": "c2", "currentValue": 30}]
            raise AssertionError(path)

    class Client:
        http = Http()

    rep = audit_wallet("0xabc", client=Client())
    assert rep.trades == 3 and rep.buys == 2 and rep.sells == 1
    assert rep.pnl == pytest.approx(-60 + 70 - 50 + 5 + 30)
    assert rep.markets == 2 and rep.winning_markets == 1
    assert rep.incentives == 5
