import { NextResponse } from "next/server";
import { openPair } from "@/lib/exec/orchestrator";
import type { Venue } from "@/lib/exec/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VENUES = new Set<Venue>(["binance", "bybit", "okx", "hyperliquid"]);
const isVenue = (v: unknown): v is Venue =>
  typeof v === "string" && VENUES.has(v as Venue);

export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const coin = typeof b.coin === "string" ? b.coin.toUpperCase() : null;
  if (!coin || !isVenue(b.short) || !isVenue(b.long)) {
    return NextResponse.json(
      { error: "coin, short and long (valid venues) are required" },
      { status: 400 }
    );
  }

  try {
    const pos = await openPair({
      coin,
      short: b.short,
      long: b.long,
      usd: Number(b.usd),
      leverage: Number(b.leverage ?? 2),
      netApr: Number(b.netApr ?? 0),
    });
    return NextResponse.json({ position: pos }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "execution failed" },
      { status: 400 }
    );
  }
}
