import { FETCHERS } from "./exchanges";
import { rankOpportunities } from "./edge";
import type {
  ExchangeId,
  FundingPoint,
  ScanParams,
  ScanResult,
} from "./types";

export const DEFAULT_PARAMS: ScanParams = {
  holdDays: 14,
  slippagePerLeg: 0.0003, // 0.03% per fill
  minNetApr: 0.03, // require ≥3% net APR as a margin of safety
};

const ALL_EXCHANGES: ExchangeId[] = [
  "binance",
  "bybit",
  "okx",
  "hyperliquid",
];

/**
 * Fetch live funding across all venues, group by underlying, and rank the
 * cross-exchange delta-neutral opportunities by NET edge after costs.
 *
 * Exchange failures are isolated: a venue that times out is reported in
 * `errors` and simply drops out of that cycle's match-ups.
 */
export async function scan(
  params: ScanParams = DEFAULT_PARAMS
): Promise<ScanResult> {
  const settled = await Promise.allSettled(
    ALL_EXCHANGES.map((ex) => FETCHERS[ex]())
  );

  const points: FundingPoint[] = [];
  const errors: ScanResult["errors"] = [];
  settled.forEach((r, i) => {
    const exchange = ALL_EXCHANGES[i];
    if (r.status === "fulfilled") {
      points.push(...r.value);
    } else {
      errors.push({
        exchange,
        message:
          r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });

  const byCoin = new Map<string, FundingPoint[]>();
  for (const p of points) {
    const arr = byCoin.get(p.coin);
    if (arr) arr.push(p);
    else byCoin.set(p.coin, [p]);
  }

  return {
    generatedAt: new Date().toISOString(),
    params,
    opportunities: rankOpportunities(byCoin, params),
    errors,
  };
}
