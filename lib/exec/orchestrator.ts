import { binance } from "./binance";
import { bybit } from "./bybit";
import { checkRisk, riskConfig } from "./risk";
import { isHalted, savePosition } from "./store";
import type { Executor, ExecPosition, Side, Venue } from "./types";

const EXECUTORS: Partial<Record<Venue, Executor>> = {
  binance,
  bybit,
  // okx, hyperliquid — added once their signing paths are validated on testnet.
};

export function executorFor(venue: Venue): Executor {
  const ex = EXECUTORS[venue];
  if (!ex) throw new Error(`${venue} execution not wired yet (testnet CEX first)`);
  return ex;
}

export function execStatus() {
  const cfg = riskConfig();
  return {
    enabled: cfg.enabled,
    limits: {
      maxUsdPerLeg: cfg.maxUsdPerLeg,
      maxLeverage: cfg.maxLeverage,
      minNetApr: cfg.minNetApr,
    },
    venues: (Object.keys(EXECUTORS) as Venue[]).map((v) => ({
      venue: v,
      configured: EXECUTORS[v]!.configured(),
    })),
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
  if (!riskConfig().enabled)
    throw new Error("execution disabled — set EXEC_ENABLED=true to arm");
  if (await isHalted()) throw new Error("kill switch is engaged (HALT)");
  if (input.short === input.long)
    throw new Error("short and long must be different venues");

  const verdict = checkRisk({
    usd: input.usd,
    leverage: input.leverage,
    netApr: input.netApr,
  });
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
