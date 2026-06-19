# Echo — AI Audio Transcription

A Fireflies-style web app. Upload an audio file and it automatically:

1. **Transcribes** it locally with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (Whisper, running on your machine — no audio leaves your computer for transcription).
2. **Summarizes** it and **extracts action items** using the Anthropic Claude API.
3. **Labels speakers** (AI-inferred who-said-what) on the transcript.
4. **Synced audio playback** — play the audio and the current line highlights; click any line to jump to that moment.
5. **Export** the result as **Markdown** or **PDF** (print-friendly view).

> Speaker labels are *AI-inferred* from conversational cues, not acoustic
> diarization. For acoustic-accurate diarization you'd add a PyTorch/pyannote
> stack — heavier, and out of scope by default.

Built with Next.js 16 (App Router) + React 19 + Tailwind v4. Transcripts and uploads are stored locally as files under `data/` — no database to set up.

---

## How it works

```
Upload audio ──▶ /api/upload ──▶ saves file + creates a job
                                    │
                                    ▼  (background)
                            scripts/transcribe.py  ── local Whisper ──▶ transcript + segments
                                    │
                                    ▼
                            lib/summarize.ts  ── Claude API ──▶ summary + key points + action items
                                    │
                                    ▼
                            job marked "done"  ◀── UI polls /api/jobs/[id]
```

## Prerequisites

These were already installed during setup:

- **Node.js** (v24) and **npm**
- **Python 3.12** with a virtualenv at `.venv/` containing `faster-whisper`
  (PyAV bundles ffmpeg, so no separate ffmpeg install is needed).

## Setup

1. Add your Anthropic API key to `.env.local`:

   ```
   ANTHROPIC_API_KEY=sk-ant-your-key-here
   ```

   Get one at https://console.anthropic.com/settings/keys.
   See `.env.example` for all options (model, Whisper size, GPU, etc.).

2. Start the dev server:

   ```bash
   npm run dev
   ```

3. Open http://localhost:3000 and drop in an audio file
   (MP3, WAV, M4A, MP4, and more).

## Configuration

All settings live in `.env.local` (see `.env.example`):

| Variable               | Default            | Purpose                                            |
| ---------------------- | ------------------ | -------------------------------------------------- |
| `ANTHROPIC_API_KEY`    | —                  | Required for AI summary & action items.            |
| `ANTHROPIC_MODEL`      | `claude-sonnet-4-6`| Claude model for summarization.                    |
| `WHISPER_MODEL`        | `base`             | `tiny`/`base`/`small`/`medium`/`large-v3`.         |
| `WHISPER_DEVICE`       | `cpu`              | Set to `cuda` if you have an NVIDIA GPU.           |
| `WHISPER_COMPUTE_TYPE` | `int8` (cpu)       | `float16` on GPU for speed.                        |
| `PYTHON_BIN`           | `.venv` python     | Override the Python interpreter.                   |

> The first transcription downloads the Whisper model (~140 MB for `base`),
> so it takes a bit longer. Subsequent runs are faster.

## Project structure

```
app/
  page.tsx                 Dashboard: upload + transcript list (polls for status)
  transcript/[id]/page.tsx Detail: Summary / Action Items / Transcript tabs
  api/
    upload/route.ts        Accepts the file, starts the pipeline
    jobs/route.ts          Lists jobs
    jobs/[id]/route.ts     Get / delete / retry a job
lib/
  transcribe.ts            Spawns the Python Whisper script
  summarize.ts             Calls Claude (structured tool output)
  process.ts               Orchestrates transcribe ➜ summarize
  store.ts                 File-based job store (data/jobs/*.json)
scripts/
  transcribe.py            faster-whisper transcription
data/                      Uploads + job JSON (gitignored)
```

## Notes

- Transcription is fully local/private. Only the **text transcript** is sent to
  Claude for summarization.
- To use a bigger/more accurate Whisper model, set `WHISPER_MODEL=small` (or
  `medium`) in `.env.local`.
