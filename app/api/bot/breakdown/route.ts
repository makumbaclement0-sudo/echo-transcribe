import { NextResponse } from "next/server";
import { aggregateByBase } from "@/lib/bot/pnl";
import { listClosedPositions, listOpenPositions } from "@/lib/bot/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-coin PnL attribution over the full history (funding vs fees vs price
// legs) plus the closed positions with the same cost split.
export async function GET() {
  const [closed, open] = await Promise.all([listClosedPositions(1000), listOpenPositions()]);
  const byBase = aggregateByBase(closed, open);
  return NextResponse.json({ byBase, closed });
}
