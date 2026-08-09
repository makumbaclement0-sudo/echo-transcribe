import { NextResponse } from "next/server";
import { setHalt } from "@/lib/exec/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let on: unknown;
  try {
    on = ((await req.json()) as { on?: unknown }).on;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  await setHalt(Boolean(on));
  return NextResponse.json({ halted: Boolean(on) });
}
