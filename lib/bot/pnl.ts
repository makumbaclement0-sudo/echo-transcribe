import { Position, PositionLeg } from "./types";

// PnL attribution helpers shared by the engine, the breakdown API and the
// dashboard (client-safe: imports types only).
// Identity per position: netRealized = pricePnl + funding - fees.
// Slippage is embedded in fill prices, so it shows up inside pricePnl.

/** Price-side PnL of one leg at the given price (excludes funding and fees). */
export function legPricePnl(leg: PositionLeg, price: number): number {
  const dir = leg.side === "long" ? 1 : -1;
  return (price - leg.entryPrice) * leg.qty * dir;
}

export function positionFeesUsd(pos: Position): number {
  return pos.legs.reduce((s, l) => s + l.entryFeeUsd + (l.exitFeeUsd ?? 0), 0);
}

/** Price-side PnL: exit price for closed legs, latest mark for open ones. */
export function positionPricePnlUsd(pos: Position): number {
  return pos.legs.reduce(
    (s, l) => s + legPricePnl(l, l.exitPrice ?? l.markPrice ?? l.entryPrice),
    0
  );
}

export function positionHoldHours(pos: Position): number {
  const end = pos.closedAt ? new Date(pos.closedAt).getTime() : Date.now();
  return Math.max(0, (end - new Date(pos.openedAt).getTime()) / 3_600_000);
}

export interface BaseBreakdown {
  base: string;
  kinds: string[]; // strategy kinds seen for this coin
  roundTrips: number; // closed positions
  wins: number; // closed with net > 0
  fundingUsd: number; // closed-position funding collected
  feesUsd: number; // closed-position fees paid
  pricePnlUsd: number; // closed-position price-leg PnL (incl. slippage)
  realizedUsd: number; // closed-position net
  avgHoldHours: number;
  openCount: number;
  openFundingUsd: number;
  openUnrealizedUsd: number;
}

export function aggregateByBase(closed: Position[], open: Position[]): BaseBreakdown[] {
  const rows = new Map<string, BaseBreakdown>();
  const row = (base: string): BaseBreakdown => {
    let r = rows.get(base);
    if (!r) {
      r = {
        base,
        kinds: [],
        roundTrips: 0,
        wins: 0,
        fundingUsd: 0,
        feesUsd: 0,
        pricePnlUsd: 0,
        realizedUsd: 0,
        avgHoldHours: 0,
        openCount: 0,
        openFundingUsd: 0,
        openUnrealizedUsd: 0,
      };
      rows.set(base, r);
    }
    return r;
  };
  for (const pos of closed) {
    const r = row(pos.base);
    const net = pos.realizedPnlUsd ?? 0;
    if (!r.kinds.includes(pos.kind)) r.kinds.push(pos.kind);
    r.roundTrips += 1;
    if (net > 0) r.wins += 1;
    r.fundingUsd += pos.fundingUsd;
    r.feesUsd += positionFeesUsd(pos);
    r.pricePnlUsd += positionPricePnlUsd(pos);
    r.realizedUsd += net;
    r.avgHoldHours += positionHoldHours(pos); // sum now, divide below
  }
  for (const pos of open) {
    const r = row(pos.base);
    if (!r.kinds.includes(pos.kind)) r.kinds.push(pos.kind);
    r.openCount += 1;
    r.openFundingUsd += pos.fundingUsd;
    r.openUnrealizedUsd += pos.unrealizedPnlUsd ?? 0;
  }
  const out = [...rows.values()];
  for (const r of out) {
    if (r.roundTrips > 0) r.avgHoldHours /= r.roundTrips;
  }
  out.sort((a, b) => b.realizedUsd - a.realizedUsd);
  return out;
}
