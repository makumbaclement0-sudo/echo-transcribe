import { Exchange } from "ccxt";
import { randomUUID } from "crypto";
import { ExchangePair } from "./exchanges";
import { FundingSnapshot, Opportunity, OpportunityLeg, Position, PositionLeg, Trade } from "./types";

// Two executors behind one interface. PaperExecutor simulates fills against
// live market data; LiveExecutor places real market orders via ccxt. Which one
// runs is decided once at engine startup from LIVE_TRADING — never at runtime.

export interface OpenResult {
  position: Position;
  trades: Trade[];
}

export interface CloseResult {
  position: Position;
  trades: Trade[];
}

export interface Executor {
  readonly paper: boolean;
  open(opp: Opportunity, notionalUsd: number): Promise<OpenResult>;
  close(pos: Position, reason: string, marks: Map<string, FundingSnapshot>): Promise<CloseResult>;
}

const HOURS_PER_YEAR = 24 * 365;

function newPosition(opp: Opportunity, notionalUsd: number, paper: boolean): Position {
  const now = new Date().toISOString();
  const mkLeg = (l: OpportunityLeg): PositionLeg => ({
    exchange: l.exchange,
    symbol: l.symbol,
    market: l.market,
    side: l.side,
    qty: notionalUsd / l.price,
    entryPrice: l.price,
    entryFeeUsd: notionalUsd * l.takerFee,
    fundingUsd: 0,
    markPrice: l.price,
    fundingApr: l.fundingApr,
  });
  return {
    id: randomUUID().slice(0, 13),
    opportunityId: opp.id,
    kind: opp.kind,
    base: opp.base,
    status: "open",
    paper,
    legs: [mkLeg(opp.longLeg), mkLeg(opp.shortLeg)],
    notionalUsd,
    entryNetApr: opp.netApr,
    currentNetApr: opp.netApr,
    fundingUsd: 0,
    openedAt: now,
    lastAccrualAt: now,
    updatedAt: now,
  };
}

function legTrade(
  pos: Position,
  leg: PositionLeg,
  action: Trade["action"],
  price: number,
  feeUsd: number,
  paper: boolean,
  orderId?: string
): Trade {
  const opening = action === "open";
  const buys = leg.side === "long";
  return {
    time: new Date().toISOString(),
    positionId: pos.id,
    action,
    exchange: leg.exchange,
    symbol: leg.symbol,
    market: leg.market,
    side: opening === buys ? "buy" : "sell",
    qty: leg.qty,
    price,
    feeUsd,
    paper,
    orderId,
  };
}

/** Price-side PnL of one leg (excludes funding and fees). */
export function legPricePnl(leg: PositionLeg, price: number): number {
  const dir = leg.side === "long" ? 1 : -1;
  return (price - leg.entryPrice) * leg.qty * dir;
}

export function positionUnrealizedPnl(pos: Position): number {
  return pos.legs.reduce(
    (sum, leg) =>
      sum + legPricePnl(leg, leg.markPrice ?? leg.entryPrice) + leg.fundingUsd - leg.entryFeeUsd,
    0
  );
}

/**
 * Paper funding accrual: instead of discrete settlement at each funding
 * timestamp, funding is accrued continuously pro-rata at the latest observed
 * rate. Over multiple intervals this converges to the discrete amounts and
 * keeps the simulation robust to missed scans.
 */
export function accrueFunding(pos: Position, marks: Map<string, FundingSnapshot>, now: Date) {
  const last = new Date(pos.lastAccrualAt ?? pos.openedAt).getTime();
  const dtHours = Math.max(0, (now.getTime() - last) / 3_600_000);
  if (dtHours === 0) return;
  for (const leg of pos.legs) {
    if (leg.market !== "swap") continue;
    const snap = marks.get(`${leg.exchange}:${leg.symbol}`);
    if (snap) {
      leg.markPrice = snap.markPrice;
      leg.fundingApr = leg.side === "short" ? snap.fundingApr : -snap.fundingApr;
    }
    const notional = (leg.markPrice ?? leg.entryPrice) * leg.qty;
    leg.fundingUsd += (leg.fundingApr ?? 0) * notional * (dtHours / HOURS_PER_YEAR);
  }
  pos.fundingUsd = pos.legs.reduce((s, l) => s + l.fundingUsd, 0);
  pos.lastAccrualAt = now.toISOString();
}

/** Refresh spot-leg marks (perp legs are refreshed inside accrueFunding). */
export function refreshMarks(pos: Position, marks: Map<string, FundingSnapshot>) {
  for (const leg of pos.legs) {
    if (leg.market !== "spot") continue;
    for (const snap of marks.values()) {
      if (snap.exchange === leg.exchange && snap.spotSymbol === leg.symbol && snap.spotPrice) {
        leg.markPrice = snap.spotPrice;
      }
    }
  }
  pos.unrealizedPnlUsd = positionUnrealizedPnl(pos);
}

// ---------------------------------------------------------------- paper ----

export class PaperExecutor implements Executor {
  readonly paper = true;

  constructor(private slippageBps: number) {}

  private fill(side: "buy" | "sell", price: number): number {
    const slip = this.slippageBps / 10_000;
    return side === "buy" ? price * (1 + slip) : price * (1 - slip);
  }

  async open(opp: Opportunity, notionalUsd: number): Promise<OpenResult> {
    const pos = newPosition(opp, notionalUsd, true);
    const trades = pos.legs.map((leg) => {
      const side = leg.side === "long" ? "buy" : "sell";
      const price = this.fill(side, leg.entryPrice);
      leg.entryPrice = price;
      leg.qty = notionalUsd / price;
      leg.entryFeeUsd = notionalUsd * (pos.legs.indexOf(leg) === 0 ? opp.longLeg.takerFee : opp.shortLeg.takerFee);
      return legTrade(pos, leg, "open", price, leg.entryFeeUsd, true);
    });
    return { position: pos, trades };
  }

  async close(pos: Position, reason: string, marks: Map<string, FundingSnapshot>): Promise<CloseResult> {
    const trades: Trade[] = [];
    for (const leg of pos.legs) {
      const mark = leg.markPrice ?? leg.entryPrice;
      const side = leg.side === "long" ? "sell" : "buy";
      const price = this.fill(side, mark);
      const feeUsd = price * leg.qty * feeRateForClose(leg, marks);
      leg.exitPrice = price;
      leg.exitFeeUsd = feeUsd;
      trades.push(legTrade(pos, leg, "close", price, feeUsd, true));
    }
    finalizeClose(pos, reason);
    return { position: pos, trades };
  }
}

function feeRateForClose(leg: PositionLeg, marks: Map<string, FundingSnapshot>): number {
  const snap = marks.get(`${leg.exchange}:${leg.symbol}`);
  if (leg.market === "swap" && snap) return snap.takerFee;
  if (leg.market === "spot") {
    for (const s of marks.values()) {
      if (s.exchange === leg.exchange && s.spotSymbol === leg.symbol && s.spotTakerFee !== null) {
        return s.spotTakerFee;
      }
    }
  }
  return 0.001;
}

function finalizeClose(pos: Position, reason: string) {
  pos.realizedPnlUsd = pos.legs.reduce((sum, leg) => {
    const exit = leg.exitPrice ?? leg.entryPrice;
    return sum + legPricePnl(leg, exit) + leg.fundingUsd - leg.entryFeeUsd - (leg.exitFeeUsd ?? 0);
  }, 0);
  pos.unrealizedPnlUsd = 0;
  pos.status = "closed";
  pos.closeReason = reason;
  pos.closedAt = new Date().toISOString();
}

// ----------------------------------------------------------------- live ----

export class LiveExecutor implements Executor {
  readonly paper = false;

  constructor(private pairs: ExchangePair[]) {}

  private client(exchange: string, market: "swap" | "spot"): Exchange {
    const pair = this.pairs.find((p) => p.id === exchange);
    if (!pair || !pair.ok) throw new Error(`exchange ${exchange} unavailable`);
    return market === "swap" ? pair.swap : pair.spot;
  }

  /** Round qty to exchange precision and enforce min amount/cost limits. */
  private prepareQty(ex: Exchange, symbol: string, qty: number, price: number): number {
    const rounded = Number(ex.amountToPrecision(symbol, qty));
    const limits = ex.markets?.[symbol]?.limits;
    const minAmount = limits?.amount?.min;
    const minCost = limits?.cost?.min;
    if (minAmount !== undefined && rounded < minAmount) {
      throw new Error(`${symbol}: qty ${rounded} below exchange minimum ${minAmount}`);
    }
    if (minCost !== undefined && rounded * price < minCost) {
      throw new Error(`${symbol}: cost below exchange minimum ${minCost}`);
    }
    return rounded;
  }

  private async placeMarket(
    ex: Exchange,
    leg: PositionLeg,
    side: "buy" | "sell",
    qty: number,
    clientId: string,
    reduceOnly: boolean
  ) {
    const params: Record<string, unknown> = { clientOrderId: clientId };
    if (leg.market === "swap" && reduceOnly) params.reduceOnly = true;
    const order = await ex.createOrder(leg.symbol, "market", side, qty, undefined, params);
    // Market orders may return before fill details are available; poll once.
    let filled = order;
    if (order.id && !(typeof filled.average === "number" && filled.average > 0)) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        filled = await ex.fetchOrder(order.id, leg.symbol);
      } catch {
        filled = order;
      }
    }
    const price =
      (typeof filled.average === "number" && filled.average) ||
      (typeof filled.price === "number" && filled.price) ||
      leg.markPrice ||
      leg.entryPrice;
    const feeUsd =
      typeof filled.fee?.cost === "number" ? filled.fee.cost : price * qty * 0.001;
    return { orderId: order.id, price, feeUsd };
  }

  async open(opp: Opportunity, notionalUsd: number): Promise<OpenResult> {
    const pos = newPosition(opp, notionalUsd, false);
    // Pre-validate both legs before sending anything.
    for (const leg of pos.legs) {
      const ex = this.client(leg.exchange, leg.market);
      leg.qty = this.prepareQty(ex, leg.symbol, leg.qty, leg.entryPrice);
    }
    // Fire both legs concurrently to minimize one-sided exposure.
    const results = await Promise.allSettled(
      pos.legs.map((leg) =>
        this.placeMarket(
          this.client(leg.exchange, leg.market),
          leg,
          leg.side === "long" ? "buy" : "sell",
          leg.qty,
          `fra-${pos.id}-${leg.side}-o`,
          false
        )
      )
    );
    const failed = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.status === "rejected");
    if (failed.length > 0) {
      // Unwind any leg that DID fill so we are never one-sided.
      const trades: Trade[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status !== "fulfilled") continue;
        const leg = pos.legs[i];
        leg.entryPrice = r.value.price;
        const unwind = await this.placeMarket(
          this.client(leg.exchange, leg.market),
          leg,
          leg.side === "long" ? "sell" : "buy",
          leg.qty,
          `fra-${pos.id}-${leg.side}-u`,
          true
        );
        trades.push(legTrade(pos, leg, "unwind", unwind.price, unwind.feeUsd, false, unwind.orderId));
      }
      const reasons = failed
        .map(({ r, i }) => `${pos.legs[i].symbol}: ${(r as PromiseRejectedResult).reason}`)
        .join("; ");
      const err = new Error(`open failed, unwound filled legs — ${reasons}`) as Error & {
        trades?: Trade[];
      };
      err.trades = trades;
      throw err;
    }
    const trades = pos.legs.map((leg, i) => {
      const r = results[i] as PromiseFulfilledResult<{ orderId: string; price: number; feeUsd: number }>;
      leg.entryPrice = r.value.price;
      leg.entryFeeUsd = r.value.feeUsd;
      return legTrade(pos, leg, "open", r.value.price, r.value.feeUsd, false, r.value.orderId);
    });
    return { position: pos, trades };
  }

  // Live closes use real fills, so the marks map is unused here.
  async close(pos: Position, reason: string): Promise<CloseResult> {
    const trades: Trade[] = [];
    const errors: string[] = [];
    for (const leg of pos.legs) {
      if (leg.exitPrice) continue; // already closed on a previous attempt
      try {
        const r = await this.placeMarket(
          this.client(leg.exchange, leg.market),
          leg,
          leg.side === "long" ? "sell" : "buy",
          leg.qty,
          `fra-${pos.id}-${leg.side}-c`,
          true
        );
        leg.exitPrice = r.price;
        leg.exitFeeUsd = r.feeUsd;
        trades.push(legTrade(pos, leg, "close", r.price, r.feeUsd, false, r.orderId));
      } catch (e) {
        errors.push(`${leg.symbol}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (errors.length > 0) {
      // Keep status "closing" so the engine retries remaining legs next scan.
      pos.status = "closing";
      pos.closeReason = reason;
      const err = new Error(`close incomplete — ${errors.join("; ")}`) as Error & {
        trades?: Trade[];
      };
      err.trades = trades;
      throw err;
    }
    finalizeClose(pos, reason);
    return { position: pos, trades };
  }
}
