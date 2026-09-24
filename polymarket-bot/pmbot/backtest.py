"""Monte Carlo simulator for a prediction-market maker.

Answers "can high-frequency market making on Polymarket produce something
like 37,000 trades, a ~60% win rate and a steep P&L curve?" -- and, more
importantly, *under which conditions it can't*.

Model (per simulated market, one step = `dt` seconds):

* The true probability p follows a random walk in log-odds space with
  occasional news jumps.
* The bot sees the true price with a `latency_steps` lag and quotes around it
  with the same MarketMaker logic used live (spread, inventory skew).
* Noise traders arrive at random, trade in a random direction, and route to
  us with probability `flow_share` (the rest goes to competing makers).
* Informed traders arrive when our stale quote is mispriced by more than
  their taker fee, and pick us off. This is adverse selection, the thing
  that actually decides whether a market maker makes money.
* Makers pay no fees, earn fee-curve rebates, and a share of the daily
  liquidity-reward pool.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from pmbot.fees import expected_maker_rebate, taker_fee_per_share
from pmbot.models import FeeSchedule, Fill, Side
from pmbot.portfolio import Portfolio


@dataclass
class SimParams:
    days: int = 48
    markets: int = 6                  # concurrently quoted markets
    dt: float = 15.0                  # seconds per step
    start_cash: float = 25_000.0
    # price process (log-odds units)
    vol_per_hour: float = 0.05
    jump_rate_per_day: float = 2.0
    jump_sd: float = 0.5
    market_life_days: float = 12.0    # each market resolves YES/NO after this, then is replaced
    stop_quoting_hours: float = 24.0  # stop quoting this long before resolution (inventory is held)
    # our quoting
    half_spread: float = 0.005        # 0.005 on a 1c tick = join the best bid/ask
    order_size: float = 100.0
    max_inventory: float = 1_000.0
    inventory_skew: float = 0.02
    latency_steps: int = 1            # our view of the price lags the truth by this many steps
    tick: float = 0.01
    # order flow
    noise_trades_per_hour: float = 30.0
    noise_size_mean: float = 80.0
    flow_share: float = 0.25          # share of uninformed flow we get while quoting at the touch
    behind_touch_factor: float = 0.1  # ...scaled by this when our quote sits behind the best price
    informed_rate_per_hour: float = 3.0
    informed_horizon_min: float = 10.0  # informed traders know where the price is going this far ahead
    jump_sweep_prob: float = 0.3      # chance a news jump sweeps our stale quote before we cancel
    # incentives
    fees: FeeSchedule = field(default_factory=lambda: FeeSchedule(rate=0.04, exponent=1, rebate_rate=0.25))
    daily_rewards_per_market: float = 10.0  # our expected slice of the liquidity-reward pool
    seed: int = 7


SCENARIOS: dict[str, dict] = {
    # lots of uninformed flow, few pick-offs, fast bot: the viral-screenshot world
    "benign": dict(informed_rate_per_hour=1.0, jump_sweep_prob=0.1, jump_rate_per_day=1.0),
    # a realistic mix for liquid politics / economics markets
    "typical": dict(),
    # sports in-play / short-dated crypto: informed flow dominates, slow bot
    "toxic": dict(informed_rate_per_hour=12.0, jump_sweep_prob=0.8, jump_rate_per_day=6.0,
                  vol_per_hour=0.12, latency_steps=2),
}


@dataclass
class SimResult:
    params: SimParams
    fills: int
    round_trips: int
    win_rate: float
    pnl: float
    spread_pnl: float
    rebates: float
    rewards: float
    max_drawdown: float
    daily_equity: list[float]
    informed_fills: int
    noise_fills: int
    resolutions: int

    def summary(self) -> str:
        per_trade = self.pnl / self.fills if self.fills else 0.0
        return (
            f"fills {self.fills:,} (noise {self.noise_fills:,} / informed {self.informed_fills:,}) | "
            f"win {100 * self.win_rate:.1f}% | P&L ${self.pnl:,.0f} (${per_trade:.2f}/fill) = "
            f"trading ${self.spread_pnl:,.0f} + rebates ${self.rebates:,.0f} + rewards ${self.rewards:,.0f} | "
            f"max DD ${self.max_drawdown:,.0f} | {self.resolutions} resolutions"
        )


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _price_path(rng: random.Random, n: int, x0: float, step_vol: float, p_jump: float, jump_sd: float) -> list[float]:
    path = [x0]
    x = x0
    for _ in range(n - 1):
        x += rng.gauss(0, step_vol)
        if rng.random() < p_jump:
            x += rng.gauss(0, jump_sd)
        x = max(-5.0, min(5.0, x))
        path.append(x)
    return path


def simulate(params: SimParams) -> SimResult:
    rng = random.Random(params.seed)
    pf = Portfolio(params.start_cash)
    steps_per_day = int(86_400 / params.dt)
    life = int(params.market_life_days * steps_per_day)
    stop_at = life - int(params.stop_quoting_hours * 3600 / params.dt)
    horizon = max(1, int(params.informed_horizon_min * 60 / params.dt))
    step_vol = params.vol_per_hour * math.sqrt(params.dt / 3600)
    p_jump = params.jump_rate_per_day / steps_per_day
    p_noise = params.noise_trades_per_hour * params.dt / 3600
    p_informed = params.informed_rate_per_hour * params.dt / 3600
    lag = params.latency_steps

    counter = 0

    def new_market(age: int) -> dict:
        nonlocal counter
        counter += 1
        yes, no = f"m{counter}-yes", f"m{counter}-no"
        pf.register_market(yes, no)
        path = _price_path(rng, life + horizon, rng.uniform(-1.5, 1.5), step_vol, p_jump, params.jump_sd)
        return {"yes": yes, "no": no, "path": path, "t": age}

    # stagger ages so resolutions don't all land on the same day
    mkts = [new_market(int(rng.uniform(0, stop_at))) for _ in range(params.markets)]

    informed = noise = resolutions = 0
    rebates = rewards = 0.0
    daily_equity: list[float] = []
    peak, max_dd = params.start_cash, 0.0
    oid = 0
    marks: dict[str, float] = {}

    def fill(token: str, side: Side, price: float, size: float) -> None:
        nonlocal oid, rebates
        oid += 1
        f = Fill(order_id=str(oid), token_id=token, side=side, price=price, size=size, maker=True)
        r = expected_maker_rebate(size, price, params.fees)
        rebates += r
        pf.apply_fill(f, rebate=r)

    for _day in range(params.days):
        for _ in range(steps_per_day):
            for i, mk in enumerate(mkts):
                t = mk["t"]
                mk["t"] += 1
                path = mk["path"]
                if t >= life:  # resolution: the market pays 1 or 0, inventory and all
                    pf.resolve(mk["yes"], mk["no"], yes_won=rng.random() < _sigmoid(path[life - 1]))
                    resolutions += 1
                    mkts[i] = new_market(0)
                    continue
                if t >= stop_at:
                    continue  # too close to resolution: not quoting, just holding

                true_p = _sigmoid(path[t])
                seen_p = _sigmoid(path[max(0, t - lag)])
                inv = pf.net_yes(mk["yes"], mk["no"])
                ratio = max(-1.0, min(1.0, inv / params.max_inventory))
                res = seen_p - params.inventory_skew * ratio
                # competing makers keep a 1-tick market around the (public) price;
                # we can join the touch or sit behind it, never improve past it
                touch_bid = math.floor(seen_p / params.tick + 1e-9) * params.tick
                touch_ask = touch_bid + params.tick
                bid = min(math.floor((res - params.half_spread) / params.tick + 1e-9) * params.tick, touch_bid)
                ask = max(math.ceil((res + params.half_spread) / params.tick - 1e-9) * params.tick, touch_ask)
                bid, ask = max(bid, params.tick), min(ask, 1 - params.tick)
                bid_share = params.flow_share if bid >= touch_bid - 1e-9 else params.flow_share * params.behind_touch_factor
                ask_share = params.flow_share if ask <= touch_ask + 1e-9 else params.flow_share * params.behind_touch_factor
                can_buy = inv < params.max_inventory
                can_sell = inv > -params.max_inventory
                size = params.order_size

                # 1) the price just jumped and our quote is stale: someone may sweep it
                jumped = abs(path[t] - path[t - 1]) > 4 * step_vol if t > 0 else False
                if jumped and rng.random() < params.jump_sweep_prob:
                    if true_p > ask + taker_fee_per_share(ask, params.fees) and can_sell:
                        _sell_yes(pf, fill, mk, ask, size)
                        informed += 1
                    elif true_p < bid - taker_fee_per_share(bid, params.fees) and can_buy:
                        fill(mk["yes"], Side.BUY, bid, size)
                        informed += 1

                # 2) informed traders know where the price will be `horizon` from now
                if rng.random() < p_informed:
                    future = _sigmoid(path[t + horizon])
                    if future > ask + taker_fee_per_share(ask, params.fees) and can_sell:
                        _sell_yes(pf, fill, mk, ask, size)
                        informed += 1
                    elif future < bid - taker_fee_per_share(bid, params.fees) and can_buy:
                        fill(mk["yes"], Side.BUY, bid, size)
                        informed += 1

                # 3) uninformed flow: random direction, only part of it reaches us
                if rng.random() < p_noise:
                    qty = float(int(min(size, max(5.0, rng.expovariate(1 / params.noise_size_mean)))))
                    if rng.random() < 0.5:
                        if can_buy and rng.random() < bid_share:
                            fill(mk["yes"], Side.BUY, bid, qty)
                            noise += 1
                    elif can_sell and rng.random() < ask_share:
                        _sell_yes(pf, fill, mk, ask, qty)
                        noise += 1

        daily_reward = params.daily_rewards_per_market * params.markets
        rewards += daily_reward
        pf.cash += daily_reward
        marks = {}
        for mk in mkts:
            tp = _sigmoid(mk["path"][min(mk["t"], life - 1)])
            marks[mk["yes"]], marks[mk["no"]] = tp, 1 - tp
        eq = pf.equity(marks)
        daily_equity.append(eq)
        peak = max(peak, eq)
        max_dd = max(max_dd, peak - eq)

    stats = pf.stats(marks)
    pnl = daily_equity[-1] - params.start_cash
    return SimResult(
        params=params, fills=stats["fills"], round_trips=stats["round_trips"], win_rate=stats["win_rate"],
        pnl=pnl, spread_pnl=pnl - rebates - rewards, rebates=rebates, rewards=rewards, max_drawdown=max_dd,
        daily_equity=daily_equity, informed_fills=informed, noise_fills=noise, resolutions=resolutions,
    )


def _sell_yes(pf: Portfolio, fill, mk: dict, ask: float, size: float) -> None:
    """Our ask gets lifted: sell YES we hold, else buy NO at 1 - ask."""
    held = pf.position(mk["yes"])
    if held >= size:
        fill(mk["yes"], Side.SELL, ask, size)
    else:
        fill(mk["no"], Side.BUY, round(1 - ask, 6), size)


def run_scenarios(names: list[str], base: SimParams, seeds: int = 3) -> dict[str, list[SimResult]]:
    out: dict[str, list[SimResult]] = {}
    for name in names:
        results = []
        for s in range(seeds):
            kwargs = {**base.__dict__, **SCENARIOS[name], "seed": base.seed + s}
            results.append(simulate(SimParams(**kwargs)))
        out[name] = results
    return out
