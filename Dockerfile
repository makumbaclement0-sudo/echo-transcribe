# Echo — single image running both the Next.js app and local Whisper (Python).
FROM node:22-bookworm-slim

# --- System deps: Python for faster-whisper (PyAV bundles ffmpeg) ---
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# --- Python virtualenv with faster-whisper ---
ENV VENV=/opt/venv
RUN python3 -m venv "$VENV"
ENV PATH="$VENV/bin:$PATH"
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir faster-whisper

WORKDIR /app

# --- Node dependencies (cached layer) ---
COPY package.json package-lock.json ./
RUN npm ci

# --- App source + production build ---
COPY . .
RUN npm run build

# --- Runtime configuration ---
ENV NODE_ENV=production
# Point the transcription script at the venv interpreter.
ENV PYTHON_BIN=/opt/venv/bin/python3
# Persist transcripts/uploads and the downloaded Whisper model on a mounted disk.
ENV DATA_DIR=/var/data
ENV HF_HOME=/var/data/hf
ENV WHISPER_MODEL=base
ENV WHISPER_DEVICE=cpu

EXPOSE 3000
# Render (and most hosts) inject $PORT; default to 3000 locally.
CMD ["sh", "-c", "node_modules/.bin/next start -p ${PORT:-3000} -H 0.0.0.0"]
