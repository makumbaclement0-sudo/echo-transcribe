# Deploying Echo to Render (always-on)

This deploys the app as a Docker web service that runs 24/7 with a fixed URL,
a persistent disk (transcripts + Whisper model survive restarts), and HTTPS.

Everything needed is already in the repo: `Dockerfile`, `render.yaml`,
`.dockerignore`.

---

## Cost & sizing (read first)

- Whisper transcription is CPU- and RAM-heavy. The blueprint uses Render's
  **Standard** instance (2 GB RAM, ~$25/mo). The free / 512 MB tiers **cannot**
  run Whisper and don't support persistent disks.
- The persistent disk is 5 GB (~$0.25/GB/mo).
- Each AI summary is billed to **your** Anthropic API key.
- Transcribing long audio on CPU takes several minutes — that's expected.

---

## Step 1 — Put the code on GitHub

Render deploys from a Git repo. From `C:\Users\cleme\transcribe-app`:

**Option A — GitHub CLI (easiest):**
```powershell
gh auth login          # one-time, opens a browser
gh repo create echo-transcribe --private --source . --push
```

**Option B — manual:**
1. Create a new **empty** repo at https://github.com/new (no README).
2. Then:
   ```powershell
   git remote add origin https://github.com/<your-username>/echo-transcribe.git
   git branch -M main
   git push -u origin main
   ```

> Your `.env.local` (with the API key) is gitignored and will **not** be pushed.

## Step 2 — Create the Render service

1. Sign up / log in at https://render.com (connect your GitHub account).
2. Click **New ➜ Blueprint**.
3. Pick the `echo-transcribe` repo. Render reads `render.yaml` automatically.
4. Click **Apply**. It creates the web service + the 5 GB disk.

## Step 3 — Add your API key

In the new service ➜ **Environment** ➜ add the secret value:

```
ANTHROPIC_API_KEY = sk-ant-...your key...
```

(The blueprint marks it `sync: false`, so Render prompts you for it instead of
storing it in the repo.) Save — Render redeploys.

## Step 4 — Done

- First build takes ~5–10 min (installs Python + faster-whisper, builds Next).
- Your fixed URL: `https://echo-transcribe.onrender.com` (or similar).
- The **first transcription** downloads the Whisper model to the disk (~140 MB),
  so it's slower once; after that it's cached.

---

## Updating later

Push to `main` and Render auto-deploys:
```powershell
git add -A
git commit -m "your change"
git push
```

## Notes / next steps

- **No login yet** — anyone with the URL can upload and spend your API credits.
  Add HTTP Basic auth (Render env vars + middleware) or a login page before
  sharing widely. Ask and I'll wire it in.
- Want it faster/cheaper? Use a smaller `WHISPER_MODEL` (`tiny`) or move
  transcription to a GPU instance.
