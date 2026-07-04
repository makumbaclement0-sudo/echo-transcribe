import { NextResponse } from "next/server";
import { readState } from "@/lib/bot/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Engine heartbeat: state.updatedAt should refresh every scan. If it's older
// than a few scan intervals the engine process is likely not running.
export async function GET() {
  const state = await readState();
  if (!state) {
    return NextResponse.json({ state: null, engineAlive: false });
  }
  const ageMs = Date.now() - new Date(state.updatedAt).getTime();
  const engineAlive = ageMs < Math.max(3 * state.config.scanIntervalMs, 90_000);
  return NextResponse.json({ state, engineAlive });
}
