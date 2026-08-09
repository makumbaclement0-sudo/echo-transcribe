import { roundTripCost } from "./edge";
import { fetchFundingHistory } from "./history";
import type { ExchangeId } from "./types";

const BUCKET_MS = 8 * 3600 * 1000; // align every venue to an 8h grid
const BUCKETS_PER_YEAR = 365 * 3;

export interface BacktestParams {
  coin: string;
  short: ExchangeId;
  long: ExchangeId;
  windowDays: number;
  slippagePerLeg: number;
}

export interface BacktestResult {
  coin: string;
  short: ExchangeId;
  long: ExchangeId;
  windowDays: number;
  /** Number of aligned 8h periods both venues had data for. */
  buckets: number;
  /** Days of actual funded exposure (buckets × 8h). */
  exposureDays: number;
  /** Realized funding differential collected over the window, as a fraction. */
  grossWindowReturn: number;
  /** …after subtracting one round-trip cost. */
  netWindowReturn: number;
  /** Annualized gross / net (fraction). */
  grossApr: number;
  netApr: number;
  /** Fraction of periods the differential stayed positive (0–1). Persistence. */
  persistence: number;
  /** Worst single-period differential (max adverse move), as a fraction. */
  worstBucket: number;
  /** Annualized Sharpe-like stability of the per-period differential. */
  annualizedSharpe: number;
  /** Per-bucket differentials, oldest→newest, for the sparkline. */
  series: number[];
}

/** Sum per-interval funding into aligned 8h buckets (keyed by bucket start). */
function bucketize(points: { time: number; rate: number }[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of points) {
    const key = Math.floor(p.time / BUCKET_MS) * BUCKET_MS;
    m.set(key, (m.get(key) ?? 0) + p.rate);
  }
  return m;
}

/**
 * Replay the cross-exchange differential over history: how much funding the
 * pair would actually have collected, how persistent the edge was, and how
 * stable — the difference between a spread that keeps paying and a one-cycle
 * blip that reverses as soon as you size in.
 */
export async function backtestPair(
  params: BacktestParams
): Promise<BacktestResult> {
  const since = Date.now() - params.windowDays * 86_400_000;
  const [shortHist, longHist] = await Promise.all([
    fetchFundingHistory(params.short, params.coin, since),
    fetchFundingHistory(params.long, params.coin, since),
  ]);

  const shortB = bucketize(shortHist);
  const longB = bucketize(longHist);

  // Keep only buckets both venues settled in, oldest → newest.
  const keys = [...shortB.keys()]
    .filter((k) => longB.has(k) && k >= since)
    .sort((a, b) => a - b);

  const series = keys.map((k) => (shortB.get(k) ?? 0) - (longB.get(k) ?? 0));
  const n = series.length;

  const sum = series.reduce((a, b) => a + b, 0);
  const mean = n ? sum / n : 0;
  const variance = n
    ? series.reduce((a, d) => a + (d - mean) ** 2, 0) / n
    : 0;
  const std = Math.sqrt(variance);
  const positive = series.filter((d) => d > 0).length;
  const worst = n ? Math.min(...series) : 0;

  const cost = roundTripCost(params.short, params.long, params.slippagePerLeg);
  const exposureDays = (n * 8) / 24;
  const annualize = exposureDays > 0 ? 365 / exposureDays : 0;

  return {
    coin: params.coin,
    short: params.short,
    long: params.long,
    windowDays: params.windowDays,
    buckets: n,
    exposureDays,
    grossWindowReturn: sum,
    netWindowReturn: sum - cost,
    grossApr: sum * annualize,
    netApr: (sum - cost) * annualize,
    persistence: n ? positive / n : 0,
    worstBucket: worst,
    annualizedSharpe: std > 0 ? (mean / std) * Math.sqrt(BUCKETS_PER_YEAR) : 0,
    series,
  };
}
