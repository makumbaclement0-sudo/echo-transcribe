import { TAKER_FEE } from "@/lib/funding/config";
import { currentFundingRates } from "@/lib/funding/rates";
import { listPositions, savePosition } from "./store";
import type { ExecPosition, ExecView } from "./types";

const HOURS_PER_YEAR = 24 * 365;

/** Round-trip taker fees (open + close, both legs) as USD on the notional. */
function feesUsd(p: ExecPosition): number {
  const perSide = TAKER_FEE[p.short.venue] + TAKER_FEE[p.long.venue];
  return p.usd * perSide * 2;
}

/** Credit elapsed funding to an open position at the current differential. */
function accrue(
  p: ExecPosition,
  shortApr: number,
  longApr: number,
  now: number
): void {
  const last = p.lastAccrualAt ?? p.openedAt;
  const elapsedHours = (now - Date.parse(last)) / 3_600_000;
  if (elapsedHours <= 0) return;
  const netPerHour = (shortApr - longApr) / HOURS_PER_YEAR;
  p.accruedFundingUsd = (p.accruedFundingUsd ?? 0) + p.usd * netPerHour * elapsedHours;
  p.lastAccrualAt = new Date(now).toISOString();
  p.lastShortApr = shortApr;
  p.lastLongApr = longApr;
}

export function execView(p: ExecPosition): ExecView {
  const fees = feesUsd(p);
  const accrued = p.accruedFundingUsd ?? 0;
  const currentNetApr =
    p.lastShortApr != null && p.lastLongApr != null
      ? p.lastShortApr - p.lastLongApr
      : null;
  return {
    ...p,
    feesUsd: fees,
    netPnlUsd: accrued - fees,
    currentNetApr,
    ageHours: (Date.now() - Date.parse(p.openedAt)) / 3_600_000,
  };
}

/**
 * Tick every OPEN position: fetch live funding once, accrue each at the current
 * cross-venue differential, persist, and return enriched views. Closed/unwound
 * positions are returned as-is (their P&L is frozen at close).
 */
export async function tickExecPositions(): Promise<ExecView[]> {
  const positions = await listPositions();
  if (positions.length === 0) return [];

  const rates = await currentFundingRates();
  const now = Date.now();
  const views: ExecView[] = [];
  for (const p of positions) {
    if (p.status === "open") {
      const shortApr = rates.get(`${p.short.venue}:${p.coin}`);
      const longApr = rates.get(`${p.long.venue}:${p.coin}`);
      if (shortApr != null && longApr != null) {
        accrue(p, shortApr, longApr, now);
        await savePosition(p);
      }
    }
    views.push(execView(p));
  }
  return views;
}
