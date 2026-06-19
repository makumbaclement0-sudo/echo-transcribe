"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";
import { Job } from "@/lib/types";
import { formatDate, formatDuration, formatTimestamp } from "@/lib/format";
import { downloadMarkdown } from "@/lib/export";

type Tab = "summary" | "actions" | "transcript";

const SPEAKER_COLORS = [
  "#7c5cff",
  "#2ecc71",
  "#3b9eff",
  "#ff9f43",
  "#ff5c8a",
  "#1abc9c",
];

export default function TranscriptPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [job, setJob] = useState<Job | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<Tab>("summary");
  const [copied, setCopied] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
    if (res.status === 404) {
      setNotFound(true);
      return;
    }
    const data = await res.json();
    setJob(data.job);
  }, [id]);

  useEffect(() => {
    // Initial load. State is updated asynchronously after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  useEffect(() => {
    const active =
      job &&
      (job.status === "transcribing" ||
        job.status === "summarizing" ||
        job.status === "uploaded");
    if (timer.current) clearTimeout(timer.current);
    if (active) timer.current = setTimeout(refresh, 2500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [job, refresh]);

  const speakerColor = useMemo(() => {
    const map = new Map<string, string>();
    (job?.speakers ?? []).forEach((sp, i) => {
      map.set(sp, SPEAKER_COLORS[i % SPEAKER_COLORS.length]);
    });
    return map;
  }, [job?.speakers]);

  const activeIndex = useMemo(() => {
    const segs = job?.segments ?? [];
    let idx = -1;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].start <= currentTime + 0.05) idx = i;
      else break;
    }
    return idx;
  }, [job?.segments, currentTime]);

  function seek(t: number) {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = t;
    a.play().catch(() => {});
  }

  async function retry() {
    await fetch(`/api/jobs/${id}`, { method: "POST" });
    refresh();
  }

  function copyTranscript() {
    if (!job?.transcript) return;
    navigator.clipboard.writeText(job.transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (notFound) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-16 text-center">
        <p className="text-[var(--muted)]">Transcript not found.</p>
        <Link href="/" className="mt-4 inline-block text-[var(--accent-2)]">
          ← Back home
        </Link>
      </main>
    );
  }

  if (!job) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-16">
        <p className="text-[var(--muted)]">Loading…</p>
      </main>
    );
  }

  const processing =
    job.status === "transcribing" ||
    job.status === "summarizing" ||
    job.status === "uploaded";
  const hasContent = job.status === "done" || !!job.summary || !!job.transcript;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-10">
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
      >
        ← All transcripts
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">
            {job.filename}
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {formatDate(job.createdAt)}
            {job.durationSec ? ` · ${formatDuration(job.durationSec)}` : ""}
            {job.language ? ` · ${job.language.toUpperCase()}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasContent && (
            <>
              <button
                onClick={() => downloadMarkdown(job)}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
                title="Download as Markdown"
              >
                ↓ Markdown
              </button>
              <a
                href={`/transcript/${id}/print?auto=1`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
                title="Open printable view / Save as PDF"
              >
                ↓ PDF
              </a>
            </>
          )}
          <StatusBadge status={job.status} />
        </div>
      </div>

      {/* Audio player */}
      {hasContent && (
        <div className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-3">
          <audio
            ref={audioRef}
            src={`/api/jobs/${id}/audio`}
            controls
            preload="metadata"
            className="w-full"
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          />
        </div>
      )}

      {job.status === "error" && (
        <div className="mb-6 rounded-xl border border-[#ff5c5c]/30 bg-[#ff5c5c]/10 p-4">
          <p className="text-sm font-medium text-[#ff8a8a]">
            Something went wrong while processing this file.
          </p>
          <p className="mt-1 break-words text-xs text-[#ffb0b0]">{job.error}</p>
          <button
            onClick={retry}
            className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {processing && <ProcessingState status={job.status} />}

      {hasContent && (
        <>
          <div className="mb-5 flex gap-1 border-b border-[var(--border)]">
            <TabButton active={tab === "summary"} onClick={() => setTab("summary")}>
              Summary
            </TabButton>
            <TabButton active={tab === "actions"} onClick={() => setTab("actions")}>
              Action Items
              {job.actionItems && job.actionItems.length > 0 ? (
                <span className="ml-1.5 rounded-full bg-[var(--accent)]/20 px-1.5 text-xs text-[var(--accent-2)]">
                  {job.actionItems.length}
                </span>
              ) : null}
            </TabButton>
            <TabButton
              active={tab === "transcript"}
              onClick={() => setTab("transcript")}
            >
              Transcript
            </TabButton>
          </div>

          {tab === "summary" && (
            <div className="space-y-6">
              {job.summary ? (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-6">
                  <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
                    AI Summary
                  </h3>
                  <div className="space-y-3 leading-relaxed text-[var(--foreground)]/90">
                    {job.summary.split(/\n+/).map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-[var(--muted)]">No summary yet.</p>
              )}

              {job.keyPoints && job.keyPoints.length > 0 && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-6">
                  <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
                    Key Points
                  </h3>
                  <ul className="space-y-2">
                    {job.keyPoints.map((k, i) => (
                      <li key={i} className="flex gap-2.5">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                        <span className="text-[var(--foreground)]/90">{k}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {tab === "actions" && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-6">
              {job.actionItems && job.actionItems.length > 0 ? (
                <ul className="space-y-3">
                  {job.actionItems.map((a, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-3 rounded-lg bg-[var(--surface-2)]/60 p-3"
                    >
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--accent)]/50 text-[var(--accent-2)]">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                      <div>
                        <p className="text-[var(--foreground)]/90">{a.task}</p>
                        {(a.owner || a.due) && (
                          <p className="mt-1 text-xs text-[var(--muted)]">
                            {a.owner ? `Owner: ${a.owner}` : ""}
                            {a.owner && a.due ? " · " : ""}
                            {a.due ? `Due: ${a.due}` : ""}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[var(--muted)]">
                  No action items were identified.
                </p>
              )}
            </div>
          )}

          {tab === "transcript" && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Full Transcript
                </h3>
                <button
                  onClick={copyTranscript}
                  className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>

              {job.speakers && job.speakers.length > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">
                  <span>AI-inferred speakers:</span>
                  {job.speakers.map((sp) => (
                    <span key={sp} className="inline-flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: speakerColor.get(sp) }}
                      />
                      {sp}
                    </span>
                  ))}
                </div>
              )}

              {job.segments && job.segments.length > 0 ? (
                <div className="space-y-1">
                  {job.segments.map((s, i) => {
                    const isActive = i === activeIndex;
                    const prev = job.segments?.[i - 1];
                    const showSpeaker = s.speaker && s.speaker !== prev?.speaker;
                    const color = s.speaker
                      ? speakerColor.get(s.speaker)
                      : undefined;
                    return (
                      <div key={i} ref={isActive ? activeRef : undefined}>
                        {showSpeaker && (
                          <p
                            className="mt-3 mb-1 text-xs font-semibold"
                            style={{ color }}
                          >
                            {s.speaker}
                          </p>
                        )}
                        <button
                          onClick={() => seek(s.start)}
                          className={`group flex w-full gap-3 rounded-lg px-2 py-1.5 text-left transition-colors ${
                            isActive
                              ? "bg-[var(--accent)]/15"
                              : "hover:bg-white/[0.03]"
                          }`}
                        >
                          <span
                            className={`shrink-0 pt-0.5 font-mono text-xs ${
                              isActive
                                ? "text-[var(--accent-2)]"
                                : "text-[var(--muted)] group-hover:text-[var(--accent-2)]"
                            }`}
                          >
                            {formatTimestamp(s.start)}
                          </span>
                          <span className="text-[var(--foreground)]/90">
                            {s.text}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : job.transcript ? (
                <p className="whitespace-pre-wrap leading-relaxed text-[var(--foreground)]/90">
                  {job.transcript}
                </p>
              ) : (
                <p className="text-sm text-[var(--muted)]">
                  Transcript not available.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "text-[var(--foreground)]"
          : "text-[var(--muted)] hover:text-[var(--foreground)]"
      }`}
    >
      <span className="inline-flex items-center">{children}</span>
      {active && (
        <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--accent)]" />
      )}
    </button>
  );
}

function ProcessingState({ status }: { status: Job["status"] }) {
  const steps = [
    { key: "transcribing", label: "Transcribing audio with Whisper" },
    { key: "summarizing", label: "Speaker labels, summary & action items" },
  ];
  const activeIndex = status === "summarizing" ? 1 : 0;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-6">
      <div className="space-y-4">
        {steps.map((s, i) => {
          const done = i < activeIndex;
          const current = i === activeIndex;
          return (
            <div key={s.key} className="flex items-center gap-3">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                  done
                    ? "bg-[#2ecc71]/20 text-[#2ecc71]"
                    : current
                    ? "bg-[var(--accent)]/20 text-[var(--accent-2)]"
                    : "bg-[var(--surface-2)] text-[var(--muted)]"
                }`}
              >
                {done ? "✓" : current ? "" : i + 1}
                {current && (
                  <span className="h-2 w-2 animate-ping rounded-full bg-[var(--accent-2)]" />
                )}
              </span>
              <span
                className={
                  current ? "text-[var(--foreground)]" : "text-[var(--muted)]"
                }
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-[var(--muted)]">
        This can take a little while on the first run — Whisper downloads its
        model the first time.
      </p>
    </div>
  );
}
