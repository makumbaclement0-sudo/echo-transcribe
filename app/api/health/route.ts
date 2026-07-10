import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Unauthenticated health check (exempted in middleware.ts) so hosting
// platforms can probe the service. Returns no data beyond liveness.
export async function GET() {
  return NextResponse.json({ ok: true });
}
