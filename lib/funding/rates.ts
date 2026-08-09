import { FETCHERS } from "./exchanges";
import type { ExchangeId } from "./types";

/**
 * Current annualized funding per venue+coin, keyed `${exchange}:${coin}`.
 * Shared by the paper simulator and the trade-page P&L accrual so both price
 * off the same live source. Venues that fail this cycle simply drop out.
 */
export async function currentFundingRates(): Promise<Map<string, number>> {
  const settled = await Promise.allSettled(
    (Object.keys(FETCHERS) as ExchangeId[]).map((ex) => FETCHERS[ex]())
  );
  const map = new Map<string, number>();
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const p of r.value) map.set(`${p.exchange}:${p.coin}`, p.aprFraction);
  }
  return map;
}
