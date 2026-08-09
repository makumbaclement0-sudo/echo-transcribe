import { NextResponse } from "next/server";
import { scan, DEFAULT_PARAMS } from "@/lib/funding/scan";
import type { ScanParams } from "@/lib/funding/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function num(value: string | null, fallback: number): number {
  const n = value == null ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const params: ScanParams = {
    holdDays: Math.max(num(searchParams.get("holdDays"), DEFAULT_PARAMS.holdDays), 0.01),
    // UI passes percents; store as fractions.
    slippagePerLeg:
      num(searchParams.get("slippagePct"), DEFAULT_PARAMS.slippagePerLeg * 100) / 100,
    minNetApr: num(searchParams.get("minNetPct"), DEFAULT_PARAMS.minNetApr * 100) / 100,
  };

  try {
    const result = await scan(params);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "scan failed" },
      { status: 500 }
    );
  }
}
