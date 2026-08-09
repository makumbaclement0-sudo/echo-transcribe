import { NextResponse } from "next/server";
import { autoState, autoTick } from "@/lib/exec/auto";
import { setAuto, setLastAuto } from "@/lib/exec/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await autoState());
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // empty body is allowed (treated as a manual tick request)
  }

  if (typeof body.on === "boolean") {
    await setAuto(body.on);
  }
  if (body.tick === true) {
    await setLastAuto(await autoTick());
  }
  return NextResponse.json(await autoState());
}
