import Anthropic from "@anthropic-ai/sdk";
import { TranscriptSegment } from "./types";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
// Label this many segments per request. Small enough that the model reliably
// returns one label per line; large enough to keep the number of calls low.
const CHUNK = 80;

const LABEL_TOOL: Anthropic.Tool = {
  name: "label_speakers",
  description:
    "Return the speaker label for each numbered transcript segment, in order.",
  input_schema: {
    type: "object",
    properties: {
      labels: {
        type: "array",
        items: { type: "string" },
        description:
          "One speaker label per segment, in the same order as the input. Reuse a label from the known-speakers list when it is the same person; only introduce a new label for a genuinely new speaker.",
      },
    },
    required: ["labels"],
  },
};

async function labelChunk(
  client: Anthropic,
  chunk: TranscriptSegment[],
  roster: string[]
): Promise<string[]> {
  const numbered = chunk
    .map((s, i) => `${i}\t[${s.start.toFixed(1)}s] ${s.text}`)
    .join("\n");

  const rosterNote =
    roster.length > 0
      ? `Speakers identified so far (reuse these exact labels for the same people): ${roster
          .map((r) => `"${r}"`)
          .join(", ")}.\n`
      : "If you can infer a role from context (e.g. \"Interviewer\", \"HR Representative\"), use it; otherwise use \"Speaker 1\", \"Speaker 2\", etc.\n";

  const prompt = `${rosterNote}Assign a speaker to each of the following numbered transcript segments. Return exactly one label per segment, in order.

SEGMENTS:
${numbered}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [LABEL_TOOL],
    tool_choice: { type: "tool", name: LABEL_TOOL.name },
    messages: [{ role: "user", content: prompt }],
  });

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  const input = (toolUse?.input ?? {}) as { labels?: string[] };
  return (input.labels ?? []).map((l) => String(l).trim()).filter(Boolean);
}

/**
 * Best-effort AI speaker attribution. Processes the transcript in chunks so it
 * stays reliable on long files, keeping a consistent speaker roster across
 * chunks. Returns segments annotated with a `speaker` label plus the distinct
 * speaker list. On any problem it degrades gracefully (fewer/no labels) rather
 * than breaking the pipeline.
 */
export async function inferSpeakers(
  segments: TranscriptSegment[]
): Promise<{ segments: TranscriptSegment[]; speakers: string[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || segments.length === 0) {
    return { segments, speakers: [] };
  }

  const client = new Anthropic({ apiKey });
  const labels: string[] = new Array(segments.length).fill("");
  const roster: string[] = [];

  for (let start = 0; start < segments.length; start += CHUNK) {
    const chunk = segments.slice(start, start + CHUNK);
    let chunkLabels: string[] = [];
    try {
      chunkLabels = await labelChunk(client, chunk, roster);
    } catch (err) {
      console.error(
        "[speakers] chunk failed (continuing):",
        err instanceof Error ? err.message : err
      );
    }

    // Tolerate count drift: fall back to the previous speaker for any segment
    // the model didn't explicitly label.
    let last = roster[0] ?? "Speaker 1";
    for (let i = 0; i < chunk.length; i++) {
      const lbl = chunkLabels[i] || last;
      last = lbl;
      labels[start + i] = lbl;
      if (!roster.includes(lbl)) roster.push(lbl);
    }
  }

  if (roster.length === 0 || labels.every((l) => !l)) {
    return { segments, speakers: [] };
  }

  const annotated = segments.map((s, i) => ({
    ...s,
    speaker: labels[i] || roster[0],
  }));
  return { segments: annotated, speakers: roster };
}
