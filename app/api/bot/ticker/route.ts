import { NextResponse } from "next/server";
import { readTicker } from "@/lib/bot/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ticker = await readTicker();
  return NextResponse.json({ ticker });
}
