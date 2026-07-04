import { NextResponse } from "next/server";
import { readOpportunities } from "@/lib/bot/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const opportunities = await readOpportunities();
  return NextResponse.json({ opportunities });
}
