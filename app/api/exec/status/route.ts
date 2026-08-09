import { NextResponse } from "next/server";
import { execStatus } from "@/lib/exec/orchestrator";
import { isHalted, listPositions } from "@/lib/exec/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [halted, positions] = await Promise.all([isHalted(), listPositions()]);
  return NextResponse.json({ ...execStatus(), halted, positions });
}
