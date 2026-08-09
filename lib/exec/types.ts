export type Venue = "binance" | "bybit" | "okx" | "hyperliquid";
export type Side = "long" | "short";

export interface OrderRequest {
  coin: string; // "BTC"
  side: Side; // long = buy, short = sell
  usd: number; // target notional in USD
  leverage: number;
  reduceOnly?: boolean; // closing an existing position
}

export interface OrderResult {
  venue: Venue;
  coin: string;
  side: Side;
  orderId: string;
  filledQty: number; // base units actually filled
  avgPrice: number; // fill price (or mark price if the venue didn't report one)
  status: "filled" | "partial" | "new" | "rejected";
  raw?: unknown;
}

/** A venue that can place testnet perp orders. */
export interface Executor {
  readonly venue: Venue;
  /** True when API credentials are present in the environment. */
  configured(): boolean;
  markPrice(coin: string): Promise<number>;
  setLeverage(coin: string, leverage: number): Promise<void>;
  placeMarket(req: OrderRequest): Promise<OrderResult>;
}

export interface LegPlan {
  venue: Venue;
  side: Side;
}

/** One opened delta-neutral pair, persisted so it can be closed later. */
export interface ExecPosition {
  id: string;
  coin: string;
  usd: number;
  leverage: number;
  short: OrderResult;
  long: OrderResult;
  openedAt: string;
  status: "open" | "closed" | "unwound";
  /** "sim" = simulated fills at live prices; "testnet" = real testnet orders. */
  mode?: "sim" | "testnet";
  note?: string;

  // Forward funding P&L (accrues while the position is open).
  accruedFundingUsd?: number;
  lastAccrualAt?: string;
  lastShortApr?: number | null;
  lastLongApr?: number | null;
}

/** A position enriched with live funding P&L for the UI. */
export interface ExecView extends ExecPosition {
  feesUsd: number;
  /** accrued funding minus round-trip fees. */
  netPnlUsd: number;
  currentNetApr: number | null;
  ageHours: number;
}
