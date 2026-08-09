import type { ExchangeId } from "./types";

/**
 * Underlyings we scan. Kept to liquid perps that exist on most venues so the
 * cross-exchange match-up is meaningful. Add/remove freely.
 */
export const UNIVERSE = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "BNB",
  "DOGE",
  "AVAX",
  "LINK",
  "LTC",
  "SUI",
  "APT",
  "ARB",
  "OP",
  "TIA",
  "WLD",
] as const;

/** Default taker fee per exchange, as a fraction of notional (0.0004 = 0.04%). */
export const TAKER_FEE: Record<ExchangeId, number> = {
  binance: 0.0004,
  bybit: 0.00055,
  okx: 0.0005,
  hyperliquid: 0.00045,
};

export const EXCHANGE_LABEL: Record<ExchangeId, string> = {
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
  hyperliquid: "Hyperliquid",
};

/**
 * Funding interval assumed per venue (hours). CEX perps settle every 8h for the
 * majors; Hyperliquid settles hourly. Used only for annualizing — the live
 * next-funding timestamps come straight from each API.
 */
export const DEFAULT_INTERVAL_HOURS: Record<ExchangeId, number> = {
  binance: 8,
  bybit: 8,
  okx: 8,
  hyperliquid: 1,
};

export const HOURS_PER_YEAR = 24 * 365;

/** Annualize a per-interval funding rate into an APR fraction. */
export function annualize(fundingRate: number, intervalHours: number): number {
  const periodsPerYear = HOURS_PER_YEAR / intervalHours;
  return fundingRate * periodsPerYear;
}
