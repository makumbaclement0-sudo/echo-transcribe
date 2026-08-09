import { binance } from "./binance";
import { bybit } from "./bybit";
import { okx } from "./okx";
import { hyperliquid, hyperliquidAddress } from "./hyperliquid";
import { simExecutors } from "./sim";
import { checkRisk, riskConfig } from "./risk";
import { isHalted, savePosition } from "./store";
import type { Executor, ExecPosition, Side, Venue } from "./types";

export type ExecMode = "sim" | "testnet";

/** Default is SIMULATION (fake fills at live prices). Opt into real testnet
 *  order placement with EXEC_MODE=testnet. */
export function execMode(): ExecMode {
  return process.env.EXEC_MODE === "testnet" ? "testnet" : "sim";
}

const REAL: Partial<Record<Venue, Executor>> = {
  binance,
  bybit,
  okx,
  hyperliquid,
};
const SIM = simExecutors(REAL);

function executors(): Partial<Record<Venue, Executor>> {
  return execMode() === "testnet" ? REAL : SIM;
}

export function executorFor(venue: Venue): Executor {
  const ex = executors()[venue];
  if (!ex) throw new Error(`${venue} execution not wired`);
  return ex;
}

export function execStatus() {
  const cfg = riskConfig();
  const mode = execMode();
  const table = executors();
  return {
    mode,
    // In sim mode there's nothing to arm — it's always ready and risk-free.
    enabled: mode === "sim" ? true : cfg.enabled,
    limits: {
      maxUsdPerLeg: cfg.maxUsdPerLeg,
      maxLeverage: cfg.maxLeverage,
      minNetApr: cfg.minNetApr,
    },
    venues: (Object.keys(table) as Venue[]).map((v) => ({
      venue: v,
      configured: table[v]!.configured(),
    })),
    hyperliquidAddress: mode === "testnet" ? hyperliquidAddress() : null,
  };
}

export interface OpenPairInput {
  coin: string;
  short: Venue;
  long: Venue;
  usd: number;
  leverage: number;
  netApr: number;
}

/**
 * Open a delta-neutral pair on testnet: SHORT one venue, LONG the other, in
 * matched USD size. Legs are placed sequentially; if the second leg fails, the
 * first is immediately unwound (reduceOnly) so we never sit naked-directional.
 */
export async function openPair(input: OpenPairInput): Promise<ExecPosition> {
  const mode = execMode();
  // Testnet placement must be explicitly armed; simulation never needs arming.
  if (mode === "testnet" && !riskConfig().enabled)
    throw new Error("execution disabled — set EXEC_ENABLED=true to arm");
  if (await isHalted()) throw new Error("kill switch is engaged (HALT)");
  if (input.short === input.long)
    throw new Error("short and long must be different venues");

  const verdict = checkRisk(
    { usd: input.usd, leverage: input.leverage, netApr: input.netApr },
    { skipNetApr: mode === "sim" } // demo any pair; still cap size + leverage
  );
  if (!verdict.ok) throw new Error(`risk gate: ${verdict.reason}`);

  const shortEx = executorFor(input.short);
  const longEx = executorFor(input.long);
  if (!shortEx.configured() || !longEx.configured())
    throw new Error("missing testnet API credentials for one or both venues");

  const { usd, leverage } = verdict;

  // Set leverage on both legs first (cheap, idempotent).
  await Promise.all([
    shortEx.setLeverage(input.coin, leverage),
    longEx.setLeverage(input.coin, leverage),
  ]);

  // Leg 1: short.
  const short = await shortEx.placeMarket({
    coin: input.coin,
    side: "short",
    usd,
    leverage,
  });

  // Leg 2: long — unwind leg 1 if this throws.
  let long;
  try {
    long = await longEx.placeMarket({
      coin: input.coin,
      side: "long",
      usd,
      leverage,
    });
  } catch (e) {
    await unwind(shortEx, input.coin, "short", short.filledQty).catch(() => {});
    const pos: ExecPosition = {
      id: `${input.coin}-${Date.now().toString(36)}`,
      coin: input.coin,
      usd,
      leverage,
      short,
      long: {
        venue: input.long,
        coin: input.coin,
        side: "long",
        orderId: "",
        filledQty: 0,
        avgPrice: 0,
        status: "rejected",
      },
      openedAt: new Date().toISOString(),
      status: "unwound",
      mode,
      note: `long leg failed, short leg unwound: ${String(e)}`,
    };
    await savePosition(pos);
    throw new Error(pos.note);
  }

  const pos: ExecPosition = {
    id: `${input.coin}-${Date.now().toString(36)}`,
    coin: input.coin,
    usd,
    leverage,
    short,
    long,
    openedAt: new Date().toISOString(),
    status: "open",
    mode,
    accruedFundingUsd: 0,
    lastAccrualAt: new Date().toISOString(),
  };
  return savePosition(pos);
}

async function unwind(ex: Executor, coin: string, side: Side, qtyUsdHint: number) {
  if (qtyUsdHint <= 0) return;
  const mark = await ex.markPrice(coin);
  await ex.placeMarket({
    coin,
    side: side === "short" ? "long" : "short", // opposite to flatten
    usd: qtyUsdHint * mark,
    leverage: 1,
    reduceOnly: true,
  });
}

/** Close both legs of an open pair with reduceOnly market orders. */
export async function closePair(pos: ExecPosition): Promise<ExecPosition> {
  if (await isHalted()) throw new Error("kill switch is engaged (HALT)");
  const shortEx = executorFor(pos.short.venue);
  const longEx = executorFor(pos.long.venue);

  await Promise.all([
    pos.short.filledQty > 0
      ? shortEx.placeMarket({
          coin: pos.coin,
          side: "long",
          usd: pos.short.filledQty * pos.short.avgPrice,
          leverage: pos.leverage,
          reduceOnly: true,
        })
      : Promise.resolve(),
    pos.long.filledQty > 0
      ? longEx.placeMarket({
          coin: pos.coin,
          side: "short",
          usd: pos.long.filledQty * pos.long.avgPrice,
          leverage: pos.leverage,
          reduceOnly: true,
        })
      : Promise.resolve(),
  ]);

  pos.status = "closed";
  return savePosition(pos);
}
