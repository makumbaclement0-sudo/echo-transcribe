import { NextResponse } from "next/server";
import { backtestPair } from "@/lib/funding/backtest";
import type { ExchangeId } from "@/lib/funding/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXCHANGES = new Set<ExchangeId>([
  "binance",
  "bybit",
  "okx",
  "hyperliquid",
]);

function isExchange(v: string | null): v is ExchangeId {
  return v != null && EXCHANGES.has(v as ExchangeId);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const coin = searchParams.get("coin")?.toUpperCase();
  const short = searchParams.get("short");
  const long = searchParams.get("long");
  const windowDays = Number(searchParams.get("days") ?? 30);
  const slippagePct = Number(searchParams.get("slippagePct") ?? 0.03);

  if (!coin || !isExchange(short) || !isExchange(long)) {
    return NextResponse.json(
      { error: "coin, short and long (valid exchange ids) are required" },
      { status: 400 }
    );
  }

  try {
    const result = await backtestPair({
      coin,
      short,
      long,
      windowDays: Number.isFinite(windowDays) ? Math.min(Math.max(windowDays, 1), 90) : 30,
      slippagePerLeg: (Number.isFinite(slippagePct) ? slippagePct : 0.03) / 100,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "backtest failed" },
      { status: 500 }
    );
  }
}
