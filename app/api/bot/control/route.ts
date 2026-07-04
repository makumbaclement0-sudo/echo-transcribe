import { NextResponse } from "next/server";
import { RUNTIME_TUNABLE } from "@/lib/bot/config";
import { writeControl } from "@/lib/bot/state";
import { BotConfig } from "@/lib/bot/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = new Set(["start", "stop", "close-position", "update-config"]);

// Commands go through data/bot/control.json; the engine picks them up on its
// next scan. The live/paper switch is intentionally NOT controllable here.
export async function POST(request: Request) {
  let body: { action?: string; positionId?: string; config?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const action = body.action ?? "";
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  }
  if (action === "close-position" && !body.positionId) {
    return NextResponse.json({ error: "positionId required" }, { status: 400 });
  }
  let config: Partial<BotConfig> | undefined;
  if (action === "update-config") {
    config = {};
    for (const key of RUNTIME_TUNABLE) {
      const v = body.config?.[key];
      if (v === undefined) continue;
      if (key === "symbolAllowlist") {
        if (Array.isArray(v)) config[key] = v.map((s) => String(s).toUpperCase());
      } else if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        (config as Record<string, number>)[key] = v;
      }
    }
    if (Object.keys(config).length === 0) {
      return NextResponse.json({ error: "no valid config keys" }, { status: 400 });
    }
  }
  const cmd = await writeControl({
    action: action as "start" | "stop" | "close-position" | "update-config",
    positionId: body.positionId,
    config,
  });
  return NextResponse.json({ ok: true, seq: cmd.seq });
}
