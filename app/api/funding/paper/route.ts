import { NextResponse } from "next/server";
import { createPosition, tickAll } from "@/lib/funding/paper";
import type { ExchangeId } from "@/lib/funding/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXCHANGES = new Set<ExchangeId>(["binance", "bybit", "okx", "hyperliquid"]);
const isExchange = (v: unknown): v is ExchangeId =>
  typeof v === "string" && EXCHANGES.has(v as ExchangeId);

export async function GET() {
  const positions = await tickAll();
  return NextResponse.json({ positions });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const coin = typeof b.coin === "string" ? b.coin.toUpperCase() : null;
  const notional = Number(b.notional);
  const slippagePct = Number(b.slippagePct ?? 0.03);

  if (!coin || !isExchange(b.short) || !isExchange(b.long)) {
    return NextResponse.json(
      { error: "coin, short and long (valid exchange ids) are required" },
      { status: 400 }
    );
  }
  if (b.short === b.long) {
    return NextResponse.json(
      { error: "short and long must be different venues" },
      { status: 400 }
    );
  }
  if (!Number.isFinite(notional) || notional <= 0) {
    return NextResponse.json({ error: "notional must be > 0" }, { status: 400 });
  }

  const pos = await createPosition({
    coin,
    short: b.short,
    long: b.long,
    notional,
    slippagePerLeg: (Number.isFinite(slippagePct) ? slippagePct : 0.03) / 100,
  });
  return NextResponse.json({ position: pos }, { status: 201 });
}
