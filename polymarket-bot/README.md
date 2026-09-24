# pmbot: Polymarket market-making & arbitrage bot

A paper-first trading bot for [Polymarket](https://polymarket.com). It's built around the strategy described in the viral
"$120,000 in 48 days, 37,000 trades, 60% win rate" story: high-frequency, two-sided market making that earns small
spreads many times over, plus a scanner for risk-free complete-set arbitrage.

It also includes the tools to check that kind of claim yourself: a Monte Carlo simulator that shows *when* market
making pays and when it bleeds, and an auditor that pulls any public wallet's real on-chain record.

> **Not financial advice.** Paper trading is on by default. Live trading uses real money, needs an explicit opt-in,
> and can lose your whole balance. Check that Polymarket is legally available where you live: the international
> exchange geoblocks the US and several other countries (the US has a separate CFTC-regulated venue). Follow
> Polymarket's Terms of Service.

---

## 1. Is the $120k / 48 days story possible?

**Short answer: yes, it's mechanically possible. It's also far harder than the story suggests, and the "60% win rate"
tells you almost nothing about whether a bot makes money.**

### What the numbers imply

| Claim | Implied |
|---|---|
| $120,000 over 48 days | ≈ **$2,500/day** |
| 37,000 trades over 48 days | ≈ **770 fills/day**, one every ~2 minutes around the clock |
| $120,000 / 37,000 | ≈ **$3.24 profit per fill** on average |
| 60% win rate | 40% of round trips *lose*, so winners must be larger than losers or more frequent |

For a market maker on 1¢-tick markets, one round trip (buy at the bid, sell at the ask) earns about 1¢ per share.
$3.24 per fill therefore means roughly **300–650 shares per fill** captured cleanly, or wider spreads, or a large
share of the profit coming from **maker rebates and liquidity rewards** rather than the spread. That points to
**tens to hundreds of thousands of dollars** of working capital, quoting in many markets at once. Polymarket trades
tens of millions of dollars a day, so capturing $250k–$500k of daily volume as a maker is plausible for a serious
operator.

### Why it's plausible

* **Makers pay zero fees on Polymarket; takers pay.** The docs give the fee as `fee = shares × rate × p × (1−p)`, with
  a rate of 0.04–0.07 depending on the category.
* **Makers get paid twice more.** *Maker rebates* return 15–25% of taker fees to the makers who were filled.
  *Liquidity rewards* are a daily pool paid to resting orders near the midpoint, scored quadratically by distance
  and size. For a busy maker these incentives alone can be a meaningful slice of P&L.
* **A 60% win rate is what adverse selection looks like.** Uninformed flow gives you small wins. Informed traders and
  news jumps give you larger losses. The net is positive only if the small wins outweigh them.

### Why you should be sceptical of the story itself

* **Survivorship and marketing.** Screenshots like this often come from people selling bots, courses or referral
  links. You never see the hundreds of bots that lost money.
* **Win rate ≠ profit.** This project's simulator (below) produces a **55–58% win rate with *negative* P&L** in the
  toxic scenario. A random real wallet the auditor checked had a **63% market win rate and only ~0.9% return on
  volume**.
* **The easy edges are gone.** Several widely shared Polymarket bot stories were latency arbitrage on short-dated
  crypto markets (reacting to exchange prices faster than the book). Polymarket then introduced taker fees on those
  markets, largely to close that trade.
* **Competition.** Professional market makers with co-located infrastructure and real-time WebSockets already quote
  the liquid books. A retail bot polling REST every 2 seconds is slower than them, and that shows up as adverse
  selection.
* **It's verifiable, so verify it.** Every Polymarket account is a public wallet. If someone gives you the profile,
  run `python -m pmbot audit 0x…` and look at the real trades, volume and P&L.

### What the simulator says

`python -m pmbot backtest`: 48 days, 6 concurrent markets, $25k capital, 100-share quotes. The same bot logic runs
under three order-flow regimes (2 seeds each):

| Scenario | Fills | Win rate | P&L | of which rebates + rewards | Max drawdown |
|---|---|---|---|---|---|
| **benign**: mostly uninformed flow, fast bot | ~26,500 | ~91% | **+$16,200** | ~$5,500 | ~$0 |
| **typical**: realistic mix | ~26,700 | ~87% | **+$14,200** | ~$5,500 | ~$0 |
| **toxic**: informed flow, news jumps, slower bot | ~35,000 | **~56%** | **−$5,600** | ~$6,000 | ~$6,000 |

What to take from this:

1. **The toxic run looks most like the viral numbers** (lots of trades, a high-50s win rate) and it **loses
   money**. Rebates and rewards cushion the loss but don't save it.
2. **Profit scales with *flow you capture*, not with order size.** Incoming orders average ~80 shares, so quoting
   bigger doesn't help much. Reaching $2,500/day requires being at the top of the book in many active markets, which
   means a real share of Polymarket's volume.
3. **Everything depends on adverse selection and latency.** It's the only parameter that turns P&L negative. It's
   also the thing you can't measure from a screenshot, which is why you paper trade first.

The simulator is a *model*, not a forecast. Its parameters are illustrative, not calibrated to any specific market.
Use it to build intuition and stress-test settings.

---

## 2. What the bot does

```
                ┌────────────┐   Gamma API: markets, fees, reward settings
                │  scanner   │── filter: volume, liquidity, 8–92¢, >24h to end,
                └─────┬──────┘   no live games, no crypto-price markets; 1 per event
                      │ selected markets
┌──────────┐    ┌─────▼──────┐    ┌──────────────┐    ┌──────────────┐
│ CLOB API │───▶│   engine   │───▶│ market maker │───▶│  risk checks │──▶ executor
│  books   │    │  (loop)    │    │  + arb scan  │    │ + kill switch│    paper | live
└──────────┘    └─────┬──────┘    └──────────────┘    └──────────────┘
                      │ fills (maker rebates estimated)
                ┌─────▼──────┐
                │ portfolio  │── cash, FIFO lots, YES+NO merging, round-trip win rate,
                └────────────┘   JSONL logs in runs/
```

### Strategies

**Market making** (`pmbot/strategies/market_maker.py`), a simplified Avellaneda–Stoikov quoter:

* fair value = microprice (size-weighted mid) of the YES book
* reservation price = fair − `inventory_skew` × (inventory / max_inventory), so the bot leans against its position
* half-spread = max(`min_half_spread`, `vol_multiplier` × short-term volatility), which widens when the market moves
* **post-only**: never crosses, so it's always the maker (zero fees, rebate-eligible)
* tightens into a market's **liquidity-reward band** (`rewardsMaxSpread`) when that doesn't go below its minimum edge
* pulls quotes on volatility spikes, stale data, or when a market is dropped
* sells YES it holds; otherwise expresses the ask as **BUY NO at 1 − ask** (identical economics, since YES + NO = $1).
  Matched YES+NO pairs are merged back to $1

**Complete-set arbitrage** (`pmbot/strategies/complete_set.py`), the only risk-free trades:

* binary: `ask(YES) + ask(NO) + taker fees < $1` → buy both. `bid(YES) + bid(NO) − fees > $1` → split and sell both
* multi-outcome (neg-risk) events: buy every YES for less than $1 total, or every NO for less than $(N−1)
* walks order-book depth and picks the size that **maximises total profit**, not average edge
* realistically, these are rare and gone within milliseconds. On 24 Sep 2026, a scan of 300 markets and 60 events
  found none, and the closest pairs summed to 1.001

### Risk controls (`pmbot/risk.py`)

Per-market and total notional caps, a max inventory per market, a max open-order count, stale-book protection and a
**daily-loss kill switch** that cancels everything and stops quoting. On shutdown, including Ctrl-C, the bot cancels
all orders.

### Paper-trading fill model (`pmbot/execution/paper.py`)

Paper results are only useful if fills are simulated honestly, so the model is deliberately pessimistic:

* a new order joins the **back of the queue** at its price level
* a shrinking level is assumed to be partly trades (`queue_trade_share`), which eat the queue ahead of us first
* if the market **trades through** our price, we're fully filled. This is the adverse-selection case: filled exactly
  when it hurts
* orders that improve the spread are filled only once the other side actually reaches them

---

## 3. Quick start

Requires Python ≥ 3.11. **The core has no dependencies**; it uses only the standard library.

```bash
cd polymarket-bot

# 1. Which markets would the bot quote right now, and why were others rejected?
python -m pmbot scan --why 10

# 2. Any risk-free arbitrage right now?
python -m pmbot arb

# 3. When does market making pay? (≈1 min)
python -m pmbot backtest                      # all scenarios
python -m pmbot backtest --scenario toxic --days 30 --size 200

# 4. Check someone's claimed performance against the blockchain
python -m pmbot audit 0xTHEIR_WALLET_ADDRESS

# 5. Paper trade against live order books (Ctrl-C to stop; logs in runs/)
python -m pmbot paper --minutes 60
python -m pmbot --config config.example.toml paper      # with your own settings
```

Run the tests:

```bash
pip install pytest && python -m pytest -q
```

### Going live (only after weeks of paper trading)

```bash
pip install polymarket-client          # official Polymarket SDK (tested with 0.11)
cp .env.example .env                   # fill in, never commit
export POLYMARKET_PRIVATE_KEY=0x...
export POLYMARKET_WALLET_ADDRESS=0x...
export PMBOT_I_UNDERSTAND_THE_RISKS=yes-real-money
python -m pmbot --config my-tiny-limits.toml live --minutes 30
```

The live executor places post-only GTC orders with `place_limit_order`, tracks fills by polling `get_order`
(`size_matched`), takes liquidity with FAK market orders for arbitrage, and calls `cancel_all` on exit. It asks you to
type `trade` before starting (`--yes` skips this). Start with limits you can afford to lose entirely. Use a dedicated
wallet holding only the bot's bankroll.

---

## 4. Project layout

```
pmbot/
  models.py            Market / OrderBook / Order / Fill; Gamma parsing, tick rounding, book sweeps
  fees.py              taker fee, maker rebate and liquidity-reward formulas (from Polymarket docs)
  data.py              Gamma, CLOB and Data API clients (stdlib, retries, backoff)
  scanner.py           market filtering and ranking
  strategies/
    market_maker.py    inventory-aware quoting
    complete_set.py    binary + neg-risk arbitrage detection
  risk.py              limits and kill switch
  portfolio.py         cash, FIFO lots, merges, resolution, win-rate stats
  execution/
    paper.py           queue-aware fill simulator
    live.py            polymarket-client SDK adapter (opt-in)
  engine.py            main loop and order reconciliation
  backtest.py          Monte Carlo market-making simulator
  audit.py             public-wallet performance auditor
  cli.py               `python -m pmbot ...`
tests/                 35 unit and integration tests (no network)
config.example.toml    every tunable, documented
```

## 5. Known limitations & upgrade path

* **Latency.** The engine polls REST every ~2 s. Serious market making needs the CLOB **WebSocket** market and user
  channels, plus a cancel-on-news reflex. That's the biggest upgrade if paper results look promising.
* **Liquidity rewards aren't simulated in paper mode.** Rebates are estimated per fill. Reward income depends on
  everyone else's resting size, so check `get_orders_scoring` and your actual daily payouts when live.
* **Live merges.** Paper mode merges YES+NO pairs instantly. Live, pairs are held (they redeem at $1). Call
  `LiveExecutor.merge()` to free capital sooner.
* **Neg-risk arbitrage** is detected by `pmbot arb` but not auto-executed. Check the event lists *every* outcome
  (watch for "Other").
* **Resolution risk.** The bot stops quoting 24 h before a market's end date, but it doesn't flatten inventory. What
  it holds resolves to $0 or $1.
* **The simulator is stylised.** Calibrate it against your own paper-trading fills before trusting any number.
