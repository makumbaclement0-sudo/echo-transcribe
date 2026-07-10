import { BotConfig, Opportunity, Position } from "./types";

// Exposure is measured as the sum of per-position (single-leg) notionals —
// the two legs of a position hedge each other, so one notional per structure.

const MIN_VIABLE_NOTIONAL_USD = 50;

export function totalExposureUsd(positions: Position[]): number {
  return positions.reduce((s, p) => s + p.notionalUsd, 0);
}

/** Returns the per-leg notional to deploy, or 0 if the trade shouldn't open. */
export function sizePosition(
  cfg: BotConfig,
  positions: Position[],
  paperCashUsd: number | null
): number {
  const headroom = cfg.maxTotalExposureUsd - totalExposureUsd(positions);
  let notional = Math.min(cfg.maxPositionUsd, headroom);
  // In paper mode, never deploy more than remaining simulated cash.
  if (paperCashUsd !== null) notional = Math.min(notional, paperCashUsd);
  return notional >= MIN_VIABLE_NOTIONAL_USD ? notional : 0;
}

const HOURS_PER_MS = 1 / 3_600_000;

/**
 * How many hours ago `positions` last closed a position in this base coin, and
 * under what reason — used to enforce a re-entry cooldown. Extreme funding
 * APRs are usually a symptom of a price squeeze between venues, which is
 * exactly what trips the divergence stop; without a cooldown the bot
 * re-enters the same volatile coin next scan and churns fees for no edge.
 */
function lastCloseFor(base: string, recentCloses: Position[]): Position | null {
  let latest: Position | null = null;
  for (const p of recentCloses) {
    if (p.base !== base || !p.closedAt) continue;
    if (!latest || p.closedAt > latest.closedAt!) latest = p;
  }
  return latest;
}

export function canOpen(
  cfg: BotConfig,
  positions: Position[],
  opp: Opportunity,
  recentCloses: Position[]
): string | null {
  if (positions.length >= cfg.maxOpenPositions) return "max open positions reached";
  if (positions.some((p) => p.base === opp.base)) return "already holding this coin";
  if (opp.netApr < cfg.minNetApr) return "below min net APR";
  if (opp.netApr > cfg.maxEntryApr) {
    return `entry APR implausibly high (${(opp.netApr * 100).toFixed(0)}% — likely a squeeze)`;
  }
  const last = lastCloseFor(opp.base, recentCloses);
  if (last) {
    const isStop = (last.closeReason ?? "").startsWith("price divergence");
    const cooldownHours = isStop ? cfg.reentryCooldownAfterStopHours : cfg.reentryCooldownHours;
    const hoursSince = (Date.now() - new Date(last.closedAt!).getTime()) * HOURS_PER_MS;
    if (hoursSince < cooldownHours) {
      return `re-entry cooldown (${(cooldownHours - hoursSince).toFixed(1)}h left after ${
        isStop ? "stop-out" : "close"
      })`;
    }
  }
  return null;
}

/** Emergency stop: legs' prices have diverged beyond the configured limit. */
export function divergenceStopHit(pos: Position, cfg: BotConfig): boolean {
  const [a, b] = pos.legs;
  const pa = a.markPrice ?? a.entryPrice;
  const pb = b.markPrice ?? b.entryPrice;
  const mid = (pa + pb) / 2;
  if (!(mid > 0)) return false;
  return (Math.abs(pa - pb) / mid) * 100 > cfg.priceDivergenceStopPct;
}
