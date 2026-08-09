import { scan, DEFAULT_PARAMS } from "@/lib/funding/scan";
import { openPair } from "./orchestrator";
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
}

export function autoConfig(): AutoConfig {
  const risk = riskConfig();
  return {
    intervalMin: Math.max(1, Number(process.env.AUTO_TRADE_INTERVAL_MIN ?? 15)),
    maxPositions: Math.max(1, Number(process.env.AUTO_MAX_POSITIONS ?? 3)),
    usd: Math.min(Number(process.env.AUTO_USD ?? 50), risk.maxUsdPerLeg),
    leverage: Math.min(Number(process.env.AUTO_LEVERAGE ?? 2), risk.maxLeverage),
    minNetApr: Number(process.env.AUTO_MIN_NET_APR ?? risk.minNetApr),
  };
}

export interface AutoResult {
  at: string;
  ran: boolean;
  reason?: string;
  opened?: { id: string; coin: string; short: string; long: string; netApr: number };
}

/**
 * One decision cycle: if auto-trading is on and we're under the position cap,
 * open the top-ranked opportunity that clears the net-APR floor and isn't
 * already held. Safe in sim mode; in testnet it still requires arming + keys.
 */
export async function autoTick(): Promise<AutoResult> {
  const at = new Date().toISOString();
  if (!(await isAutoOn())) return { at, ran: false, reason: "auto-trader off" };
  if (await isHalted()) return { at, ran: false, reason: "kill switch engaged" };

  const cfg = autoConfig();
  const open = (await listPositions()).filter((p) => p.status === "open");
  if (open.length >= cfg.maxPositions)
    return { at, ran: false, reason: `at position cap (${cfg.maxPositions})` };
  const held = new Set(open.map((p) => p.coin));

  const { opportunities } = await scan(DEFAULT_PARAMS);
  const pick = opportunities.find(
    (o) => o.netApr >= cfg.minNetApr && !held.has(o.coin)
  );
  if (!pick)
    return { at, ran: false, reason: "no opportunity clears the net-APR floor" };

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
      opened: {
        id: pos.id,
        coin: pos.coin,
        short: pos.short.venue,
        long: pos.long.venue,
        netApr: pick.netApr,
      },
    };
  } catch (e) {
    return { at, ran: false, reason: e instanceof Error ? e.message : String(e) };
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
