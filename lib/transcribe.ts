import { spawn } from "child_process";
import path from "path";
import { existsSync } from "fs";
import { TranscriptSegment } from "./types";

export interface TranscriptionResult {
  language: string | null;
  duration: number | null;
  text: string;
  segments: TranscriptSegment[];
}

function resolvePython(): string {
  if (process.env.PYTHON_BIN && existsSync(process.env.PYTHON_BIN)) {
    return process.env.PYTHON_BIN;
  }
  // Prefer the project virtualenv created during setup.
  const winVenv = path.join(process.cwd(), ".venv", "Scripts", "python.exe");
  const nixVenv = path.join(process.cwd(), ".venv", "bin", "python");
  if (existsSync(winVenv)) return winVenv;
  if (existsSync(nixVenv)) return nixVenv;
  // Fall back to whatever python is on PATH.
  return process.platform === "win32" ? "python" : "python3";
}

export function transcribeAudio(
  audioPath: string
): Promise<TranscriptionResult> {
  const python = resolvePython();
  const script = path.join(process.cwd(), "scripts", "transcribe.py");
  const model = process.env.WHISPER_MODEL || "base";

  return new Promise((resolve, reject) => {
    const proc = spawn(python, [script, audioPath, model], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      // Stream progress to the server console for visibility.
      process.stderr.write(s);
    });

    proc.on("error", (err) =>
      reject(new Error(`Failed to start transcription process: ${err.message}`))
    );

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Transcription failed (exit ${code}). ${stderr.slice(-500)}`
          )
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as TranscriptionResult;
        resolve(parsed);
      } catch {
        reject(
          new Error(
            `Could not parse transcription output. ${stderr.slice(-500)}`
          )
        );
      }
    });
  });
}
