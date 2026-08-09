import { NextResponse } from "next/server";
import { closePair } from "@/lib/exec/orchestrator";
import { getPosition } from "@/lib/exec/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let id: unknown;
  try {
    id = ((await req.json()) as { id?: unknown }).id;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof id !== "string")
    return NextResponse.json({ error: "id is required" }, { status: 400 });

  const pos = await getPosition(id);
  if (!pos) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    return NextResponse.json({ position: await closePair(pos) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "close failed" },
      { status: 400 }
    );
  }
}
