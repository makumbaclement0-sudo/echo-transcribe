import { Job } from "./types";
import { formatDuration, formatTimestamp } from "./format";

/** Build a Markdown document for a finished job. Pure + client-safe. */
export function jobToMarkdown(job: Job): string {
  const lines: string[] = [];
  lines.push(`# ${job.filename}`);
  const meta: string[] = [new Date(job.createdAt).toLocaleString()];
  if (job.durationSec) meta.push(formatDuration(job.durationSec));
  if (job.language) meta.push(job.language.toUpperCase());
  lines.push(`_${meta.join(" · ")}_`, "");

  if (job.summary) {
    lines.push("## Summary", "", job.summary, "");
  }

  if (job.keyPoints && job.keyPoints.length > 0) {
    lines.push("## Key Points", "");
    for (const k of job.keyPoints) lines.push(`- ${k}`);
    lines.push("");
  }

  if (job.actionItems && job.actionItems.length > 0) {
    lines.push("## Action Items", "");
    for (const a of job.actionItems) {
      const tags: string[] = [];
      if (a.owner) tags.push(`owner: ${a.owner}`);
      if (a.due) tags.push(`due: ${a.due}`);
      lines.push(`- [ ] ${a.task}${tags.length ? ` _(${tags.join(", ")})_` : ""}`);
    }
    lines.push("");
  }

  lines.push("## Transcript", "");
  if (job.segments && job.segments.length > 0) {
    for (const s of job.segments) {
      const who = s.speaker ? `**${s.speaker}** ` : "";
      lines.push(`\`${formatTimestamp(s.start)}\` ${who}${s.text}`, "");
    }
  } else if (job.transcript) {
    lines.push(job.transcript);
  }

  return lines.join("\n");
}

export function downloadMarkdown(job: Job) {
  const md = jobToMarkdown(job);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName(job.filename)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function baseName(filename: string): string {
  return filename.replace(/\.[^/.]+$/, "") || "transcript";
}
