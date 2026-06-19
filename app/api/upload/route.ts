import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { saveJob, uploadsDir } from "@/lib/store";
import { Job } from "@/lib/types";
import { processJob } from "@/lib/process";

export const runtime = "nodejs";
// Allow large audio uploads.
export const maxDuration = 60;

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "File is empty." }, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "File exceeds the 500 MB limit." },
      { status: 413 }
    );
  }

  const id = randomUUID();
  const ext = path.extname(file.name) || ".audio";
  const storedFile = `${id}${ext}`;

  const bytes = Buffer.from(await file.arrayBuffer());
  await fs.mkdir(uploadsDir(), { recursive: true });
  await fs.writeFile(path.join(uploadsDir(), storedFile), bytes);

  const now = new Date().toISOString();
  const job: Job = {
    id,
    filename: file.name,
    storedFile,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    status: "uploaded",
    createdAt: now,
    updatedAt: now,
    segments: [],
    keyPoints: [],
    actionItems: [],
  };

  await saveJob(job);

  // Kick off the transcription + summarization pipeline in the background.
  // We intentionally do not await it so the upload returns immediately.
  void processJob(id);

  return NextResponse.json({ job }, { status: 201 });
}
