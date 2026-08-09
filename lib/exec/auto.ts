import { scan, DEFAULT_PARAMS } from "@/lib/funding/scan";
import { currentFundingRates } from "@/lib/funding/rates";
import { closePair, openPair } from "./orchestrator";
import { riskConfig } from "./risk";
import {
  getLastAuto,
  isAutoOn,
  isHalted,
  listPositions,
  setAuto,
  setLastAuto,
} from "./store";

export interface AutoConfig {
  intervalMin: number;
  maxPositions: number;
  usd: number;
  leverage: number;
  minNetApr: number;
  /** Close a position when its live net APR drops below this. */
  closeApr: number;
  /** Close a position once held this many hours (0 = no time limit). */
  maxHoldHours: number;
}

export function autoConfig(): AutoConfig {
  const risk = riskConfig();
  return {
    intervalMin: Math.max(1, Number(process.env.AUTO_TRADE_INTERVAL_MIN ?? 15)),
    maxPositions: Math.max(1, Number(process.env.AUTO_MAX_POSITIONS ?? 3)),
    usd: Math.min(Number(process.env.AUTO_USD ?? 50), risk.maxUsdPerLeg),
    leverage: Math.min(Number(process.env.AUTO_LEVERAGE ?? 2), risk.maxLeverage),
    minNetApr: Number(process.env.AUTO_MIN_NET_APR ?? risk.minNetApr),
    closeApr: Number(process.env.AUTO_CLOSE_APR ?? 0),
    maxHoldHours: Number(process.env.AUTO_MAX_HOLD_HOURS ?? 168),
  };
}

export interface AutoResult {
  at: string;
  ran: boolean;
  reason?: string;
  closed?: { coin: string; reason: string }[];
  opened?: { id: string; coin: string; short: string; long: string; netApr: number };
}

/**
 * One decision cycle: if auto-trading is on and we're under the position cap,
 * open the top-ranked opportunity that clears the net-APR floor and isn't
 * already held. Safe in sim mode; in testnet it still requires arming + keys.
 */
/**
 * Close open positions that hit an exit rule: live net APR fell below the floor
 * (the edge flipped), or the position has been held past the max hold time.
 */
async function autoManage(
  cfg: AutoConfig,
  rates: Map<string, number>
): Promise<{ coin: string; reason: string }[]> {
  const closed: { coin: string; reason: string }[] = [];
  const now = Date.now();
  for (const p of await listPositions()) {
    if (p.status !== "open") continue;
    const shortApr = rates.get(`${p.short.venue}:${p.coin}`);
    const longApr = rates.get(`${p.long.venue}:${p.coin}`);
    const netApr =
      shortApr != null && longApr != null ? shortApr - longApr : null;
    const ageHours = (now - Date.parse(p.openedAt)) / 3_600_000;

    let reason: string | null = null;
    if (netApr != null && netApr < cfg.closeApr)
      reason = `net APR ${(netApr * 100).toFixed(2)}% below floor ${(
        cfg.closeApr * 100
      ).toFixed(2)}%`;
    else if (cfg.maxHoldHours > 0 && ageHours >= cfg.maxHoldHours)
      reason = `held ${ageHours.toFixed(1)}h ≥ ${cfg.maxHoldHours}h`;

    if (reason) {
      try {
        await closePair(p);
        closed.push({ coin: p.coin, reason });
      } catch {
        // leave it open; try again next cycle
      }
    }
  }
  return closed;
}

export async function autoTick(): Promise<AutoResult> {
  const at = new Date().toISOString();
  if (!(await isAutoOn())) return { at, ran: false, reason: "auto-trader off" };
  if (await isHalted()) return { at, ran: false, reason: "kill switch engaged" };

  const cfg = autoConfig();
  const rates = await currentFundingRates();

  // 1) Manage existing positions (close on flipped edge or expired hold).
  const closed = await autoManage(cfg, rates);

  // 2) Open a new one if there's room.
  const open = (await listPositions()).filter((p) => p.status === "open");
  if (open.length >= cfg.maxPositions)
    return {
      at,
      ran: closed.length > 0,
      closed,
      reason: `at position cap (${cfg.maxPositions})`,
    };
  const held = new Set(open.map((p) => p.coin));

  const { opportunities } = await scan(DEFAULT_PARAMS);
  const pick = opportunities.find(
    (o) => o.netApr >= cfg.minNetApr && !held.has(o.coin)
  );
  if (!pick)
    return {
      at,
      ran: closed.length > 0,
      closed,
      reason: "no opportunity clears the net-APR floor",
    };

  try {
    const pos = await openPair({
      coin: pick.coin,
      short: pick.short.exchange,
      long: pick.long.exchange,
      usd: cfg.usd,
      leverage: cfg.leverage,
      netApr: pick.netApr,
    });
    return {
      at,
      ran: true,
      closed,
      opened: {
        id: pos.id,
        coin: pos.coin,
        short: pos.short.venue,
        long: pos.long.venue,
        netApr: pick.netApr,
      },
    };
  } catch (e) {
    return {
      at,
      ran: closed.length > 0,
      closed,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

async function safeTick(): Promise<void> {
  try {
    await setLastAuto(await autoTick());
  } catch {
    // never let a bad cycle crash the loop
  }
}

let started = false;
/**
 * Start the background decision loop. Called once from instrumentation.ts on
 * server boot, so it resumes automatically whenever the app (re)starts.
 */
export function startAutoLoop(): void {
  if (started) return;
  started = true;
  // AUTO_TRADE=true enables the trader by default on first boot.
  if (process.env.AUTO_TRADE === "true") void setAuto(true);
  const ms = autoConfig().intervalMin * 60_000;
  setTimeout(() => void safeTick(), 30_000); // first look shortly after boot
  setInterval(() => void safeTick(), ms);
}

export async function autoState() {
  return {
    enabled: await isAutoOn(),
    config: autoConfig(),
    lastRun: (await getLastAuto()) as AutoResult | null,
  };
}
