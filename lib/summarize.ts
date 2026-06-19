import Anthropic from "@anthropic-ai/sdk";
import { ActionItem } from "./types";

export interface SummaryResult {
  summary: string;
  keyPoints: string[];
  actionItems: ActionItem[];
}

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

// Structured-output tool: forcing tool use guarantees well-formed JSON back.
const SUMMARY_TOOL: Anthropic.Tool = {
  name: "record_meeting_notes",
  description:
    "Record the structured summary, key points, and action items extracted from a transcript.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "A concise 2-4 paragraph narrative summary of the conversation.",
      },
      key_points: {
        type: "array",
        items: { type: "string" },
        description: "The most important points or decisions, as short bullets.",
      },
      action_items: {
        type: "array",
        description: "Concrete follow-up tasks mentioned or implied.",
        items: {
          type: "object",
          properties: {
            task: { type: "string", description: "What needs to be done." },
            owner: {
              type: ["string", "null"],
              description: "Who is responsible, if stated. Otherwise null.",
            },
            due: {
              type: ["string", "null"],
              description: "Any deadline mentioned. Otherwise null.",
            },
          },
          required: ["task"],
        },
      },
    },
    required: ["summary", "key_points", "action_items"],
  },
};

export async function summarizeTranscript(
  transcript: string
): Promise<SummaryResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local to enable AI summaries."
    );
  }

  const client = new Anthropic({ apiKey });

  const prompt = `You are an expert meeting-notes assistant. Analyze the following transcript and produce a clear summary, the key points, and any action items. Be faithful to the content — do not invent tasks that were not discussed. If no action items exist, return an empty list.

TRANSCRIPT:
"""
${transcript}
"""`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    tools: [SUMMARY_TOOL],
    tool_choice: { type: "tool", name: SUMMARY_TOOL.name },
    messages: [{ role: "user", content: prompt }],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );

  if (!toolUse) {
    throw new Error("Model did not return structured notes.");
  }

  const input = toolUse.input as {
    summary?: string;
    key_points?: string[];
    action_items?: ActionItem[];
  };

  return {
    summary: input.summary ?? "",
    keyPoints: input.key_points ?? [],
    actionItems: input.action_items ?? [],
  };
}
