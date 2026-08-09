import { promises as fs } from "fs";
import path from "path";
import { TAKER_FEE } from "./config";
import { currentFundingRates } from "./rates";
import type { ExchangeId } from "./types";

const HOURS_PER_YEAR = 24 * 365;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const PAPER_DIR = path.join(DATA_DIR, "paper");

/**
 * A simulated delta-neutral position tracked forward in real time. Funding
 * accrues on read (each tick credits the elapsed hours at the then-current
 * differential), so a live position confirms — or refutes — what the backtest
 * predicted, with no capital at risk.
 */
export interface PaperPosition {
  id: string;
  coin: string;
  short: ExchangeId;
  long: ExchangeId;
  /** USD notional per leg. */
  notional: number;
  /** One-way slippage assumption per fill, as a fraction. */
  slippagePerLeg: number;
  openedAt: string;
  /** Last time funding was credited (ISO). */
  lastAccrualAt: string;
  /** Running funding collected, in USD (can be negative). */
  accruedFundingUsd: number;
  /** Last observed per-leg annualized funding, for display. */
  lastShortApr: number | null;
  lastLongApr: number | null;
}

/** A position enriched with live marks for the UI. */
export interface PaperView extends PaperPosition {
  openFeeUsd: number;
  closeFeeUsd: number;
  /** accrued funding minus both fees (marked to an immediate close). */
  netPnlUsd: number;
  currentNetApr: number | null;
  ageHours: number;
  /** Realized net return on deployed notional, annualized so far. */
  realizedApr: number | null;
}

async function ensureDir() {
  await fs.mkdir(PAPER_DIR, { recursive: true });
}

function posPath(id: string) {
  return path.join(PAPER_DIR, `${id}.json`);
}

export function openFeeUsd(p: PaperPosition): number {
  return (
    p.notional * (TAKER_FEE[p.short] + TAKER_FEE[p.long] + 2 * p.slippagePerLeg)
  );
}

export async function listPositions(): Promise<PaperPosition[]> {
  await ensureDir();
  const files = await fs.readdir(PAPER_DIR);
  const out: PaperPosition[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(PAPER_DIR, f), "utf8")));
    } catch {
      // skip corrupt
    }
  }
  out.sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
  return out;
}

export async function savePosition(p: PaperPosition): Promise<PaperPosition> {
  await ensureDir();
  await fs.writeFile(posPath(p.id), JSON.stringify(p, null, 2), "utf8");
  return p;
}

export async function createPosition(input: {
  coin: string;
  short: ExchangeId;
  long: ExchangeId;
  notional: number;
  slippagePerLeg: number;
}): Promise<PaperPosition> {
  const now = new Date().toISOString();
  const pos: PaperPosition = {
    id: `${input.coin}-${Date.now().toString(36)}`,
    coin: input.coin,
    short: input.short,
    long: input.long,
    notional: input.notional,
    slippagePerLeg: input.slippagePerLeg,
    openedAt: now,
    lastAccrualAt: now,
    accruedFundingUsd: 0,
    lastShortApr: null,
    lastLongApr: null,
  };
  return savePosition(pos);
}

export async function deletePosition(id: string): Promise<boolean> {
  try {
    await fs.unlink(posPath(id));
    return true;
  } catch {
    return false;
  }
}

/** Credit elapsed funding to one position at the current differential. */
function accrue(
  p: PaperPosition,
  shortApr: number,
  longApr: number,
  now: number
): void {
  const elapsedHours = (now - Date.parse(p.lastAccrualAt)) / 3_600_000;
  if (elapsedHours <= 0) return;
  const netPerHour = (shortApr - longApr) / HOURS_PER_YEAR;
  p.accruedFundingUsd += p.notional * netPerHour * elapsedHours;
  p.lastAccrualAt = new Date(now).toISOString();
  p.lastShortApr = shortApr;
  p.lastLongApr = longApr;
}

function toView(p: PaperPosition): PaperView {
  const fee = openFeeUsd(p);
  const ageHours = (Date.now() - Date.parse(p.openedAt)) / 3_600_000;
  const currentNetApr =
    p.lastShortApr != null && p.lastLongApr != null
      ? p.lastShortApr - p.lastLongApr
      : null;
  const netPnlUsd = p.accruedFundingUsd - 2 * fee;
  // Annualize realized net return on one leg's notional.
  const realizedApr =
    ageHours > 0 ? (netPnlUsd / p.notional) * (HOURS_PER_YEAR / ageHours) : null;
  return {
    ...p,
    openFeeUsd: fee,
    closeFeeUsd: fee,
    netPnlUsd,
    currentNetApr,
    ageHours,
    realizedApr,
  };
}

/**
 * Tick every open position: fetch live funding once, accrue each position,
 * persist, and return enriched views. Positions on a temporarily-unavailable
 * venue simply don't accrue this cycle.
 */
export async function tickAll(): Promise<PaperView[]> {
  const positions = await listPositions();
  if (positions.length === 0) return [];

  const rates = await currentFundingRates();
  const now = Date.now();
  const views: PaperView[] = [];
  for (const p of positions) {
    const shortApr = rates.get(`${p.short}:${p.coin}`);
    const longApr = rates.get(`${p.long}:${p.coin}`);
    if (shortApr != null && longApr != null) {
      accrue(p, shortApr, longApr, now);
      await savePosition(p);
    }
    views.push(toView(p));
  }
  return views;
}
