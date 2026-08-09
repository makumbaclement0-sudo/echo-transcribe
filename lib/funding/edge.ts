import { TAKER_FEE } from "./config";
import type { FundingPoint, Opportunity, ScanParams } from "./types";

/**
 * Round-trip cost to enter AND exit a delta-neutral pair, as a fraction of
 * notional. Two legs, opened and closed once = taker fee ×2 per leg, plus a
 * one-way slippage assumption on each of the four fills.
 */
function roundTripCost(
  short: FundingPoint,
  long: FundingPoint,
  slippagePerLeg: number
): number {
  const fees = 2 * (TAKER_FEE[short.exchange] + TAKER_FEE[long.exchange]);
  const slippage = 4 * slippagePerLeg;
  return fees + slippage;
}

/**
 * Turn a set of funding points for ONE underlying into the best cross-exchange
 * delta-neutral opportunity: short the highest-funding venue, long the lowest.
 *
 * The key insight vs. flip-in/flip-out trading: the round-trip cost is a FIXED
 * one-time drag. Amortized over a long hold it shrinks toward zero, so a
 * position that loses money held for hours can be clearly profitable held for
 * weeks. `holdDays` makes that trade-off explicit.
 */
export function bestOpportunity(
  points: FundingPoint[],
  params: ScanParams
): Opportunity | null {
  if (points.length < 2) return null;

  let short = points[0];
  let long = points[0];
  for (const p of points) {
    if (p.aprFraction > short.aprFraction) short = p;
    if (p.aprFraction < long.aprFraction) long = p;
  }
  if (short.exchange === long.exchange) return null;

  const grossApr = short.aprFraction - long.aprFraction;
  const cost = roundTripCost(short, long, params.slippagePerLeg);
  // Amortize the one-time cost across the holding period → annualized drag.
  const costDragApr = cost * (365 / Math.max(params.holdDays, 0.001));
  const netApr = grossApr - costDragApr;

  return {
    coin: short.coin,
    short,
    long,
    grossApr,
    costDragApr,
    netApr,
    profitable: netApr >= params.minNetApr,
  };
}

/** Compute and rank opportunities (highest net edge first) for every coin. */
export function rankOpportunities(
  pointsByCoin: Map<string, FundingPoint[]>,
  params: ScanParams
): Opportunity[] {
  const out: Opportunity[] = [];
  for (const points of pointsByCoin.values()) {
    const opp = bestOpportunity(points, params);
    if (opp) out.push(opp);
  }
  out.sort((a, b) => b.netApr - a.netApr);
  return out;
}
