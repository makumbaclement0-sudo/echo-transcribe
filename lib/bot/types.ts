// Funding-rate arbitrage bot — shared types.
//
// Sign conventions used throughout:
// - fundingRate: the raw per-interval rate as reported by the exchange
//   (positive => longs pay shorts).
// - "APR" values are annualized decimals (0.10 = 10%/year).
// - A leg's fundingApr is the annualized funding the leg RECEIVES:
//   short perp receives +rate, long perp receives -rate, spot receives 0.

export type ExchangeId = "binance" | "bybit" | "okx";

export const EXCHANGE_IDS: ExchangeId[] = ["binance", "bybit", "okx"];

export type MarketType = "swap" | "spot";

export type StrategyKind = "cross-exchange" | "carry";

export interface FundingSnapshot {
  exchange: ExchangeId;
  symbol: string; // unified ccxt swap symbol, e.g. "BTC/USDT:USDT"
  base: string; // e.g. "BTC"
  fundingRate: number; // per-interval decimal rate
  intervalHours: number; // 1 / 4 / 8
  nextFundingTime: number | null; // ms epoch
  fundingApr: number; // fundingRate annualized over its interval
  markPrice: number;
  bid: number | null;
  ask: number | null;
  quoteVolumeUsd: number | null; // 24h quote volume (liquidity filter)
  takerFee: number; // decimal, e.g. 0.00055
  spotSymbol: string | null; // matching spot market, e.g. "BTC/USDT"
  spotPrice: number | null;
  spotTakerFee: number | null;
  timestamp: number;
}

export interface OpportunityLeg {
  exchange: ExchangeId;
  symbol: string;
  market: MarketType;
  side: "long" | "short";
  fundingApr: number; // annualized funding this leg receives
  price: number;
  takerFee: number;
}

export interface Opportunity {
  id: string; // stable per structure, e.g. "cross:BTC:bybit>binance"
  kind: StrategyKind;
  base: string;
  longLeg: OpportunityLeg;
  shortLeg: OpportunityLeg;
  grossApr: number; // combined funding APR received by both legs
  feesApr: number; // round-trip fees + slippage amortized over holdHorizonHours
  basisApr: number; // one-off entry basis PnL amortized (positive = tailwind)
  netApr: number; // grossApr - feesApr + basisApr
  basisPct: number; // (shortPrice - longPrice) / mid at scan time
  timestamp: number;
}

export type PositionStatus = "open" | "closing" | "closed" | "failed";

export interface PositionLeg {
  exchange: ExchangeId;
  symbol: string;
  market: MarketType;
  side: "long" | "short";
  qty: number; // base asset quantity
  entryPrice: number;
  exitPrice?: number;
  entryFeeUsd: number;
  exitFeeUsd?: number;
  fundingUsd: number; // accumulated funding received (+) / paid (-)
  markPrice?: number; // latest mark, refreshed each scan
  fundingApr?: number; // latest funding APR received by this leg
}

export interface Position {
  id: string;
  opportunityId: string;
  kind: StrategyKind;
  base: string;
  status: PositionStatus;
  paper: boolean;
  legs: [PositionLeg, PositionLeg]; // [long, short]
  notionalUsd: number; // per-leg notional at entry
  entryNetApr: number;
  currentNetApr?: number; // latest scanner netApr for the same structure
  fundingUsd: number; // total accrued funding across legs
  unrealizedPnlUsd?: number;
  realizedPnlUsd?: number; // set once closed
  openedAt: string;
  closedAt?: string;
  closeReason?: string;
  lastAccrualAt?: string; // paper mode: last funding accrual timestamp
  updatedAt: string;
}

export interface Trade {
  time: string;
  positionId: string;
  action: "open" | "close" | "unwind";
  exchange: ExchangeId;
  symbol: string;
  market: MarketType;
  side: "buy" | "sell";
  qty: number;
  price: number;
  feeUsd: number;
  paper: boolean;
  orderId?: string;
}

export interface BotConfig {
  liveTrading: boolean;
  scanIntervalMs: number;
  minNetApr: number; // open threshold (decimal APR)
  exitApr: number; // close when current structure APR drops below this
  maxPositionUsd: number; // per-leg notional cap
  maxTotalExposureUsd: number; // sum of per-position notionals (legs hedge each other)
  maxOpenPositions: number;
  maxSlippageBps: number; // per fill, used in cost model + live guard
  maxEntryBasisPct: number; // skip entry if adverse price basis exceeds this
  maxEntryApr: number; // skip entries above this net APR — likely a squeeze, not durable edge
  reentryCooldownHours: number; // after any close, don't re-open the same coin for this long
  reentryCooldownAfterStopHours: number; // longer cooldown specifically after a divergence stop
  priceDivergenceStopPct: number; // emergency close if legs diverge this far
  holdHorizonHours: number; // amortization horizon for one-off costs
  minQuoteVolumeUsd: number; // 24h liquidity filter per market
  maxPositionAgeHours: number; // recycle stale positions
  paperStartingBalanceUsd: number;
  symbolAllowlist: string[]; // base symbols; empty = no restriction
}

export interface EngineState {
  running: boolean; // false = halted (no new opens; existing positions still managed)
  paper: boolean;
  pid: number;
  startedAt: string;
  lastScanAt?: string;
  lastError?: string | null;
  scanCount: number;
  exchangesOk: Partial<Record<ExchangeId, boolean>>;
  cashUsd: number; // paper cash balance (live: sum of free USDT)
  equityUsd: number; // cash + unrealized PnL of open positions
  totalFundingUsd: number; // lifetime funding collected
  realizedPnlUsd: number; // lifetime realized PnL
  openPositions: number;
  totalExposureUsd: number;
  config: BotConfig;
  updatedAt: string;
}

export interface ControlFile {
  seq: number; // engine executes commands with seq > last processed
  action: "start" | "stop" | "close-position" | "update-config";
  positionId?: string;
  config?: Partial<BotConfig>;
  requestedAt: string;
}
