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
  const totals = positions.reduce(
    (acc, p) => {
      acc.netPnlUsd += p.netPnlUsd;
      acc.accruedFundingUsd += p.accruedFundingUsd ?? 0;
      if (p.status === "open") acc.openCount += 1;
      return acc;
    },
    { netPnlUsd: 0, accruedFundingUsd: 0, openCount: 0, count: positions.length }
  );
  return NextResponse.json({ ...execStatus(), halted, positions, totals });
}
