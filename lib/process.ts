import path from "path";
import { getJob, updateJob, uploadsDir } from "./store";
import { transcribeAudio } from "./transcribe";
import { summarizeTranscript } from "./summarize";
import { inferSpeakers } from "./speakers";
import { TranscriptSegment } from "./types";

// Tracks jobs currently being processed in this server instance so a
// duplicate trigger doesn't kick off a second pipeline for the same job.
const inFlight = new Set<string>();

export async function processJob(id: string): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const job = await getJob(id);
    if (!job) return;

    const audioPath = path.join(uploadsDir(), job.storedFile);

    // 1) Transcribe locally with Whisper — unless we already have a transcript
    // (e.g. a retry after the summary step failed). Avoids re-doing slow work.
    let transcriptText = job.transcript ?? "";
    let segments: TranscriptSegment[] = job.segments ?? [];
    if (!transcriptText.trim()) {
      await updateJob(id, { status: "transcribing", error: null });
      const t = await transcribeAudio(audioPath);
      transcriptText = t.text;
      segments = t.segments;
      await updateJob(id, {
        transcript: t.text,
        segments: t.segments,
        language: t.language,
        durationSec: t.duration,
      });
    } else {
      await updateJob(id, { error: null });
    }

    if (transcriptText.trim().length === 0) {
      await updateJob(id, {
        status: "done",
        summary: "No speech was detected in this audio.",
        keyPoints: [],
        actionItems: [],
      });
      return;
    }

    // 2) AI speaker attribution (best-effort) — only if not already labeled.
    await updateJob(id, { status: "summarizing" });
    const alreadyLabeled = segments.some((s) => s.speaker);
    if (segments.length > 0 && !alreadyLabeled) {
      const { segments: labeled, speakers } = await inferSpeakers(segments);
      if (speakers.length > 0) {
        segments = labeled;
        await updateJob(id, { segments: labeled, speakers });
      }
    }

    // 3) Summarize + extract action items with Claude.
    const s = await summarizeTranscript(transcriptText);
    await updateJob(id, {
      status: "done",
      summary: s.summary,
      keyPoints: s.keyPoints,
      actionItems: s.actionItems,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[process] job ${id} failed:`, message);
    await updateJob(id, { status: "error", error: message });
  } finally {
    inFlight.delete(id);
  }
}
