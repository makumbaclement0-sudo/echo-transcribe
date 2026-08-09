import { NextResponse } from "next/server";
import { execStatus } from "@/lib/exec/orchestrator";
import { tickExecPositions } from "@/lib/exec/pnl";
import { isHalted } from "@/lib/exec/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // tickExecPositions accrues live funding onto open positions before returning.
  const [halted, positions] = await Promise.all([
    isHalted(),
    tickExecPositions(),
  ]);
  return NextResponse.json({ ...execStatus(), halted, positions });
}
