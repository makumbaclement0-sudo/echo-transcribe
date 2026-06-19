export type JobStatus =
  | "uploaded"
  | "transcribing"
  | "summarizing"
  | "done"
  | "error";

export interface TranscriptSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
  speaker?: string | null; // AI-inferred speaker label, if available
}

export interface ActionItem {
  task: string;
  owner?: string | null;
  due?: string | null;
}

export interface Job {
  id: string;
  filename: string;
  /** stored file name on disk (inside data/uploads) */
  storedFile: string;
  mimeType: string;
  sizeBytes: number;
  status: JobStatus;
  error?: string | null;
  createdAt: string;
  updatedAt: string;

  // results
  durationSec?: number | null;
  language?: string | null;
  transcript?: string | null;
  segments?: TranscriptSegment[];
  speakers?: string[]; // distinct AI-inferred speaker labels
  summary?: string | null;
  keyPoints?: string[];
  actionItems?: ActionItem[];
}
