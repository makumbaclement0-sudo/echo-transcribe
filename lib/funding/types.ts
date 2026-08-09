export type ExchangeId = "binance" | "bybit" | "okx" | "hyperliquid";

/** A single normalized funding observation for one perp on one exchange. */
export interface FundingPoint {
  exchange: ExchangeId;
  /** Underlying asset symbol, e.g. "BTC". */
  coin: string;
  /** Exchange-native instrument id, e.g. "BTCUSDT" or "BTC-USDT-SWAP". */
  instrument: string;
  /** Funding rate for one funding interval, as a fraction (0.0001 = 0.01%). */
  fundingRate: number;
  /** Length of one funding interval in hours (8 on most CEXs, 1 on Hyperliquid). */
  intervalHours: number;
  /** Annualized funding as a fraction (0.11 = 11% APR). */
  aprFraction: number;
  /** Mark price, if the exchange reports it. */
  markPrice: number | null;
  /** Next funding settlement (ms epoch), if reported. */
  nextFundingMs: number | null;
}

/**
 * A delta-neutral cross-exchange opportunity for one underlying:
 * SHORT the perp on the highest-funding venue, LONG it on the lowest-funding
 * venue, and collect the funding differential.
 */
export interface Opportunity {
  coin: string;
  /** Venue we short (receives funding — highest APR). */
  short: FundingPoint;
  /** Venue we long (pays funding — lowest APR). */
  long: FundingPoint;
  /** Gross funding differential, annualized (shortApr - longApr). */
  grossApr: number;
  /** Annualized cost drag from round-trip fees + slippage, given the hold period. */
  costDragApr: number;
  /** Net edge after costs, annualized. This is the number that matters. */
  netApr: number;
  /** True when net edge clears the configured safety margin. */
  profitable: boolean;
}

export interface ScanParams {
  /** Number of days you plan to hold the position (amortizes fixed costs). */
  holdDays: number;
  /** Extra one-way slippage assumption per leg, as a fraction (0.0003 = 0.03%). */
  slippagePerLeg: number;
  /** Minimum net APR (fraction) to flag an opportunity as profitable. */
  minNetApr: number;
}

export interface ScanResult {
  generatedAt: string;
  params: ScanParams;
  opportunities: Opportunity[];
  /** Exchanges that failed to respond this cycle (partial results are still useful). */
  errors: { exchange: ExchangeId; message: string }[];
}
