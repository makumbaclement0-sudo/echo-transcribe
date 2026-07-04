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

export function canOpen(cfg: BotConfig, positions: Position[], opp: Opportunity): string | null {
  if (positions.length >= cfg.maxOpenPositions) return "max open positions reached";
  if (positions.some((p) => p.opportunityId === opp.id)) return "already holding this structure";
  if (opp.netApr < cfg.minNetApr) return "below min net APR";
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
