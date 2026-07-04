import { canOpen, divergenceStopHit, sizePosition } from "./risk";
import { BotConfig, Opportunity, Position } from "./types";

// Exit logic note: entry fees are sunk once a position is open, so the exit
// decision compares the FORWARD funding APR (what the structure earns from
// here on) against exitApr — not the entry-style netApr, which re-charges
// round-trip costs the position has already paid.

export interface CloseDecision {
  position: Position;
  reason: string;
}

/** Forward-looking gross funding APR currently received by the structure. */
export function forwardApr(pos: Position): number {
  return pos.legs.reduce((s, l) => s + (l.fundingApr ?? 0), 0);
}

export function decideCloses(
  positions: Position[],
  opportunities: Opportunity[],
  cfg: BotConfig,
  now: Date
): CloseDecision[] {
  const byId = new Map(opportunities.map((o) => [o.id, o]));
  const out: CloseDecision[] = [];
  for (const pos of positions) {
    if (pos.status !== "open" && pos.status !== "closing") continue;
    // Refresh the dashboard-facing "what would this structure yield now" number.
    pos.currentNetApr = byId.get(pos.opportunityId)?.netApr ?? forwardApr(pos);

    if (pos.status === "closing") {
      out.push({ position: pos, reason: pos.closeReason ?? "retrying close" });
      continue;
    }
    if (divergenceStopHit(pos, cfg)) {
      out.push({ position: pos, reason: "price divergence stop" });
      continue;
    }
    const fwd = forwardApr(pos);
    if (fwd < cfg.exitApr) {
      out.push({
        position: pos,
        reason: `forward funding APR ${(fwd * 100).toFixed(2)}% below exit threshold`,
      });
      continue;
    }
    const ageHours = (now.getTime() - new Date(pos.openedAt).getTime()) / 3_600_000;
    if (ageHours > cfg.maxPositionAgeHours) {
      out.push({ position: pos, reason: "max position age reached" });
    }
  }
  return out;
}

export interface OpenDecision {
  opportunity: Opportunity;
  notionalUsd: number;
}

export function decideOpen(
  opportunities: Opportunity[],
  positions: Position[],
  cfg: BotConfig,
  paperCashUsd: number | null
): OpenDecision | null {
  for (const opp of opportunities) {
    if (canOpen(cfg, positions, opp) !== null) continue;
    const notionalUsd = sizePosition(cfg, positions, paperCashUsd);
    if (notionalUsd <= 0) return null; // no headroom for anything
    return { opportunity: opp, notionalUsd };
  }
  return null;
}
