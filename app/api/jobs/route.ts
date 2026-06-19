import { NextResponse } from "next/server";
import { listJobs } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  const jobs = await listJobs();
  return NextResponse.json({ jobs });
}
