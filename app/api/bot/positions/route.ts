import { NextResponse } from "next/server";
import { listClosedPositions, listOpenPositions, readRecentTrades } from "@/lib/bot/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [open, closed, trades] = await Promise.all([
    listOpenPositions(),
    listClosedPositions(50),
    readRecentTrades(100),
  ]);
  open.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  return NextResponse.json({ open, closed, trades });
}
