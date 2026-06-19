#!/usr/bin/env python
"""Transcribe an audio file locally with faster-whisper.

Usage:
    python transcribe.py <audio_path> [model_size]

Outputs a single JSON object to stdout:
    {"language": "en", "duration": 123.4, "text": "...", "segments": [...]}

All progress/log output goes to stderr so stdout stays clean JSON.
"""
import json
import os
import sys


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def main():
    if len(sys.argv) < 2:
        log("error: missing audio path argument")
        sys.exit(2)

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else os.environ.get(
        "WHISPER_MODEL", "base"
    )

    if not os.path.exists(audio_path):
        log(f"error: file not found: {audio_path}")
        sys.exit(2)

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # pragma: no cover
        log(f"error: faster-whisper not installed: {e}")
        sys.exit(3)

    # CPU-friendly defaults. int8 keeps memory/CPU low; works without a GPU.
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get(
        "WHISPER_COMPUTE_TYPE", "int8" if device == "cpu" else "float16"
    )

    log(f"loading model '{model_size}' ({device}/{compute_type})...")
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    log("transcribing...")
    segments_iter, info = model.transcribe(
        audio_path,
        beam_size=5,
        vad_filter=True,
    )

    segments = []
    parts = []
    for seg in segments_iter:
        text = seg.text.strip()
        segments.append(
            {"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text}
        )
        parts.append(text)
        log(f"  [{seg.start:.1f}s] {text}")

    result = {
        "language": info.language,
        "duration": round(info.duration, 2) if info.duration else None,
        "text": " ".join(parts).strip(),
        "segments": segments,
    }

    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
