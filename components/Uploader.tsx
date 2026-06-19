"use client";

import { useRef, useState } from "react";

export default function Uploader({ onUploaded }: { onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function pick() {
    inputRef.current?.click();
  }

  function upload(file: File) {
    setError(null);
    if (!file.type.startsWith("audio/") && !file.type.startsWith("video/")) {
      // Allow anyway, but warn for clearly-wrong types.
      if (!/\.(mp3|wav|m4a|aac|ogg|flac|webm|mp4|mov)$/i.test(file.name)) {
        setError("That doesn't look like an audio file.");
        return;
      }
    }

    const form = new FormData();
    form.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      setProgress(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        onUploaded();
      } else {
        try {
          setError(JSON.parse(xhr.responseText).error || "Upload failed.");
        } catch {
          setError("Upload failed.");
        }
      }
    };
    xhr.onerror = () => {
      setProgress(null);
      setError("Network error during upload.");
    };
    setProgress(0);
    xhr.send(form);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) upload(file);
  }

  return (
    <div>
      <div
        onClick={pick}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`group cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${
          dragging
            ? "border-[var(--accent)] bg-[var(--accent)]/5"
            : "border-[var(--border)] hover:border-[var(--accent)]/60 hover:bg-white/[0.02]"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm,.mp4,.mov"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
            e.target.value = "";
          }}
        />

        {progress === null ? (
          <>
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)]/15 text-[var(--accent-2)]">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 16V4M12 4l-4 4M12 4l4 4" />
                <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
            </div>
            <p className="text-base font-medium">
              Drop an audio file here, or{" "}
              <span className="text-[var(--accent-2)]">browse</span>
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              MP3, WAV, M4A, MP4 and more · up to 500 MB
            </p>
          </>
        ) : (
          <div className="py-2">
            <p className="mb-3 text-sm font-medium">Uploading… {progress}%</p>
            <div className="mx-auto h-2 w-full max-w-md overflow-hidden rounded-full bg-[var(--surface-2)]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-3 text-sm text-[#ff7676]">{error}</p>
      )}
    </div>
  );
}
