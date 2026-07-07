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

---

# Funding-Rate Arbitrage Bot

This repo also contains an autonomous funding-rate arbitrage bot
(à la arbitragescanner.io, but it trades): it scans perpetual funding rates on
**Binance, Bybit and OKX**, and opens/closes delta-neutral positions when the
net expected yield clears your thresholds.

Two structures are traded, whichever scores higher:

- **Cross-exchange**: short the perp on the exchange where funding is high,
  long the same perp where it's low/negative — collect the funding spread.
- **Cash-and-carry**: buy spot, short the perp on the same exchange — collect
  positive funding.

Scoring nets out taker fees (entry + exit, both legs), a slippage allowance,
and the entry price basis, all amortized over `HOLD_HORIZON_HOURS`, so the
displayed **net APR** is what a position is actually expected to earn.

## Running it

```bash
npm install
npm run bot      # engine (paper mode — needs NO API keys)
npm run dev      # dashboard at http://localhost:3000/bot
```

The engine and the dashboard talk through files under `data/bot/` — no
database. The dashboard shows the live scanner table, open positions with
funding/PnL, trade history, and has start/stop, per-position close, a kill
switch, and editable risk limits.

> Single-process alternative: set `BOT_AUTOSTART=true` and the engine runs
> inside the web server itself — one `next dev`/`next start` does everything.

## Run it 24/7 on Windows (auto-start at logon)

One-time setup, same pattern as Echo's `serve.ps1` task: in your bot checkout,
double-click **`install-bot-autostart.cmd`**. It registers a "FundingBot"
scheduled task that runs `bot-serve.ps1` hidden at every logon — production
build, site + embedded engine on port **3010**, auto-restart on crashes — and
starts it immediately. Dashboard: `http://localhost:3010/bot` (or
`http://<PC-IP>:3010/bot` from your phone on the same Wi-Fi). Logs live in
`data\`. Undo with `schtasks /Delete /TN "FundingBot" /F`.

## Paper vs live

The bot **always starts in paper mode**: it uses real market data but
simulates fills (with slippage) and tracks a virtual balance
(`PAPER_STARTING_BALANCE_USD`, default $10k).

To trade real money you must set **all** of the following in `.env.local` and
restart the engine (the dashboard can never switch you to live):

```
LIVE_TRADING=true
BINANCE_API_KEY=... BINANCE_API_SECRET=...
BYBIT_API_KEY=...   BYBIT_API_SECRET=...
OKX_API_KEY=...     OKX_API_SECRET=...   OKX_API_PASSWORD=...
```

Only exchanges with keys are traded live. Use keys with **trade permission
only — never withdrawal**. See `.env.example` for every threshold and risk
limit (min net APR, exposure caps, divergence stop, etc.).

Live-execution safety built in: legs are fired concurrently and if one leg
fails the filled leg is **immediately unwound** so you're never one-sided;
closes are reduce-only; a failed close is retried every scan; exposure caps
and a price-divergence stop are enforced by the engine.

## Notes & caveats

- Some venues geo-block their APIs (e.g. Binance/Bybit from US-hosted
  servers). The bot detects this at startup and keeps running with the
  exchanges that are reachable.
- Funding-rate arbitrage is **not risk-free**: funding can flip, fills can
  slip, and cross-exchange basis can move against you. Paper-trade first,
  start small, and treat the default thresholds as a starting point.
