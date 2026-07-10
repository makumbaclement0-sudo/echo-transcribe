import { ExchangePair, linearSwapMarkets, spotSymbolFor, takerFee } from "./exchanges";
import {
  BotConfig,
  ExchangeId,
  FundingSnapshot,
  Opportunity,
  OpportunityLeg,
} from "./types";

// Unit conventions: APRs are decimals (0.10 = 10%/yr); *Pct values are in
// percent (0.15 = 0.15%). Funding sign: positive rate => longs pay shorts,
// so a short perp leg receives +fundingApr and a long leg receives -fundingApr.

const HOURS_PER_YEAR = 24 * 365;
const DEFAULT_TAKER = 0.001; // pessimistic fallback when market has no fee info
const MAX_OPPORTUNITIES = 120;

export interface ScanResult {
  snapshots: FundingSnapshot[];
  opportunities: Opportunity[];
  errors: Partial<Record<ExchangeId, string>>;
  timestamp: number;
}

function parseIntervalHours(rate: Record<string, unknown>, marketInfo: unknown): number {
  const iv = rate?.interval;
  if (typeof iv === "string") {
    const m = iv.match(/^(\d+)h$/i);
    if (m) return Number(m[1]);
  }
  // Bybit exposes fundingInterval in minutes on market.info
  const info = marketInfo as { fundingInterval?: string | number } | undefined;
  const mins = Number(info?.fundingInterval);
  if (Number.isFinite(mins) && mins > 0) return mins / 60;
  return 8;
}

async function snapshotExchange(
  p: ExchangePair,
  errors: Partial<Record<ExchangeId, string>>
): Promise<FundingSnapshot[]> {
  if (!p.ok) {
    if (p.lastError) errors[p.id] = p.lastError;
    return [];
  }
  try {
    const [rates, swapTickers, spotTickers] = await Promise.all([
      p.swap.fetchFundingRates(),
      p.swap.fetchTickers(),
      p.spot.fetchTickers().catch(() => ({}) as Record<string, never>),
    ]);
    const now = Date.now();
    const out: FundingSnapshot[] = [];
    for (const market of linearSwapMarkets(p)) {
      const symbol = market.symbol;
      const rate = rates[symbol];
      const ticker = swapTickers[symbol];
      if (!rate || typeof rate.fundingRate !== "number") continue;
      const markPrice =
        (typeof rate.markPrice === "number" && rate.markPrice > 0 && rate.markPrice) ||
        (typeof ticker?.last === "number" && ticker.last) ||
        0;
      if (!(markPrice > 0)) continue;
      const intervalHours = parseIntervalHours(
        rate as unknown as Record<string, unknown>,
        market.info
      );
      const quoteVolume =
        (typeof ticker?.quoteVolume === "number" && ticker.quoteVolume) ||
        (typeof ticker?.baseVolume === "number" ? ticker.baseVolume * markPrice : null);
      const spotSymbol = spotSymbolFor(p, market.base as string);
      const spotTicker = spotSymbol
        ? (spotTickers as Record<string, { last?: number }>)[spotSymbol]
        : undefined;
      out.push({
        exchange: p.id,
        symbol,
        base: market.base as string,
        fundingRate: rate.fundingRate,
        intervalHours,
        nextFundingTime: typeof rate.fundingTimestamp === "number" ? rate.fundingTimestamp : null,
        fundingApr: rate.fundingRate * (HOURS_PER_YEAR / intervalHours),
        markPrice,
        bid: typeof ticker?.bid === "number" ? ticker.bid : null,
        ask: typeof ticker?.ask === "number" ? ticker.ask : null,
        quoteVolumeUsd: quoteVolume,
        takerFee: takerFee(p.swap, symbol, DEFAULT_TAKER),
        spotSymbol,
        spotPrice: typeof spotTicker?.last === "number" ? spotTicker.last : null,
        spotTakerFee: spotSymbol ? takerFee(p.spot, spotSymbol, DEFAULT_TAKER) : null,
        timestamp: now,
      });
    }
    return out;
  } catch (e) {
    errors[p.id] = e instanceof Error ? e.message : String(e);
    return [];
  }
}

function passesFilters(s: FundingSnapshot, cfg: BotConfig): boolean {
  if (cfg.symbolAllowlist.length > 0 && !cfg.symbolAllowlist.includes(s.base)) return false;
  if (s.quoteVolumeUsd !== null && s.quoteVolumeUsd < cfg.minQuoteVolumeUsd) return false;
  return true;
}

/**
 * One-off round-trip cost (fees on open+close for both legs plus a slippage
 * allowance per fill), expressed as a fraction of per-leg notional, then
 * amortized over the configured hold horizon to make it comparable to APRs.
 */
function amortizedCostApr(legFees: number[], slipBps: number, holdHours: number): number {
  const perFillSlip = slipBps / 10_000;
  const fills = legFees.length * 2; // open + close per leg
  const roundTrip = legFees.reduce((a, f) => a + f * 2, 0) + fills * perFillSlip;
  return roundTrip / (holdHours / HOURS_PER_YEAR);
}

function crossExchangeOpportunity(
  a: FundingSnapshot,
  b: FundingSnapshot,
  cfg: BotConfig
): Opportunity | null {
  // Short the leg with the higher funding APR, long the lower one.
  const [shortSnap, longSnap] = a.fundingApr >= b.fundingApr ? [a, b] : [b, a];
  const grossApr = shortSnap.fundingApr - longSnap.fundingApr;
  if (grossApr <= 0) return null;
  const mid = (shortSnap.markPrice + longSnap.markPrice) / 2;
  const basisPct = ((shortSnap.markPrice - longSnap.markPrice) / mid) * 100;
  if (basisPct < -cfg.maxEntryBasisPct) return null; // adverse entry basis
  const feesApr = amortizedCostApr(
    [shortSnap.takerFee, longSnap.takerFee],
    cfg.maxSlippageBps,
    cfg.holdHorizonHours
  );
  const basisApr = basisPct / 100 / (cfg.holdHorizonHours / HOURS_PER_YEAR);
  const longLeg: OpportunityLeg = {
    exchange: longSnap.exchange,
    symbol: longSnap.symbol,
    market: "swap",
    side: "long",
    fundingApr: -longSnap.fundingApr,
    price: longSnap.markPrice,
    takerFee: longSnap.takerFee,
  };
  const shortLeg: OpportunityLeg = {
    exchange: shortSnap.exchange,
    symbol: shortSnap.symbol,
    market: "swap",
    side: "short",
    fundingApr: shortSnap.fundingApr,
    price: shortSnap.markPrice,
    takerFee: shortSnap.takerFee,
  };
  return {
    id: `cross:${shortSnap.base}:${shortSnap.exchange}>${longSnap.exchange}`,
    kind: "cross-exchange",
    base: shortSnap.base,
    longLeg,
    shortLeg,
    grossApr,
    feesApr,
    basisApr,
    netApr: grossApr - feesApr + basisApr,
    basisPct,
    timestamp: Math.min(shortSnap.timestamp, longSnap.timestamp),
  };
}

function carryOpportunity(s: FundingSnapshot, cfg: BotConfig): Opportunity | null {
  // Buy spot, short the perp on the same exchange; collect positive funding.
  if (s.fundingApr <= 0 || !s.spotSymbol || !s.spotPrice || s.spotTakerFee === null) return null;
  const grossApr = s.fundingApr;
  const basisPct = ((s.markPrice - s.spotPrice) / s.spotPrice) * 100; // perp premium = tailwind
  if (basisPct < -cfg.maxEntryBasisPct) return null;
  const feesApr = amortizedCostApr(
    [s.takerFee, s.spotTakerFee],
    cfg.maxSlippageBps,
    cfg.holdHorizonHours
  );
  const basisApr = basisPct / 100 / (cfg.holdHorizonHours / HOURS_PER_YEAR);
  return {
    id: `carry:${s.base}:${s.exchange}`,
    kind: "carry",
    base: s.base,
    longLeg: {
      exchange: s.exchange,
      symbol: s.spotSymbol,
      market: "spot",
      side: "long",
      fundingApr: 0,
      price: s.spotPrice,
      takerFee: s.spotTakerFee,
    },
    shortLeg: {
      exchange: s.exchange,
      symbol: s.symbol,
      market: "swap",
      side: "short",
      fundingApr: s.fundingApr,
      price: s.markPrice,
      takerFee: s.takerFee,
    },
    grossApr,
    feesApr,
    basisApr,
    netApr: grossApr - feesApr + basisApr,
    basisPct,
    timestamp: s.timestamp,
  };
}

export function computeOpportunities(
  snapshots: FundingSnapshot[],
  cfg: BotConfig
): Opportunity[] {
  const eligible = snapshots.filter((s) => passesFilters(s, cfg));
  const byBase = new Map<string, FundingSnapshot[]>();
  for (const s of eligible) {
    const list = byBase.get(s.base) ?? [];
    list.push(s);
    byBase.set(s.base, list);
  }
  const out: Opportunity[] = [];
  for (const group of byBase.values()) {
    for (let i = 0; i < group.length; i++) {
      const carry = carryOpportunity(group[i], cfg);
      if (carry) out.push(carry);
      for (let j = i + 1; j < group.length; j++) {
        const cross = crossExchangeOpportunity(group[i], group[j], cfg);
        if (cross) out.push(cross);
      }
    }
  }
  return out
    .filter((o) => Number.isFinite(o.netApr))
    .sort((x, y) => y.netApr - x.netApr)
    .slice(0, MAX_OPPORTUNITIES);
}

export async function scan(pairs: ExchangePair[], cfg: BotConfig): Promise<ScanResult> {
  const errors: Partial<Record<ExchangeId, string>> = {};
  const perExchange = await Promise.all(pairs.map((p) => snapshotExchange(p, errors)));
  const snapshots = perExchange.flat();
  return {
    snapshots,
    opportunities: computeOpportunities(snapshots, cfg),
    errors,
    timestamp: Date.now(),
  };
}

/** Lookup helper: latest snapshot per (exchange, swap symbol). */
export function snapshotIndex(snapshots: FundingSnapshot[]) {
  const map = new Map<string, FundingSnapshot>();
  for (const s of snapshots) map.set(`${s.exchange}:${s.symbol}`, s);
  return map;
}
