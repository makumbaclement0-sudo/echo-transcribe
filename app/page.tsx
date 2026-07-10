"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Uploader from "@/components/Uploader";
import StatusBadge from "@/components/StatusBadge";
import { Job } from "@/lib/types";
import { formatBytes, formatDate, formatDuration } from "@/lib/format";

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      const data = await res.json();
      setJobs(data.jobs ?? []);
    } catch {
      // ignore transient errors
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // Initial load. State is updated asynchronously after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  // Poll while anything is still processing.
  useEffect(() => {
    const anyActive = jobs.some(
      (j) =>
        j.status === "transcribing" ||
        j.status === "summarizing" ||
        j.status === "uploaded"
    );
    if (timer.current) clearTimeout(timer.current);
    if (anyActive) {
      timer.current = setTimeout(refresh, 2500);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobs, refresh]);

  async function remove(id: string) {
    await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    refresh();
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-10">
      <header className="mb-10 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent)]/20 text-[var(--accent-2)]">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Echo</h1>
          <p className="text-sm text-[var(--muted)]">
            Local transcription · AI summary · action items
          </p>
        </div>
        <Link
          href="/bot"
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--muted)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--foreground)]"
        >
          Arbitrage bot →
        </Link>
      </header>

      <Uploader onUploaded={refresh} />

      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
            Your transcripts
          </h2>
          <span className="text-xs text-[var(--muted)]">{jobs.length} total</span>
        </div>

        {!loaded ? (
          <p className="text-sm text-[var(--muted)]">Loading…</p>
        ) : jobs.length === 0 ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-8 text-center text-sm text-[var(--muted)]">
            No transcripts yet. Upload an audio file to get started.
          </div>
        ) : (
          <ul className="space-y-3">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="group flex items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-4 transition-colors hover:border-[var(--accent)]/40"
              >
                <Link
                  href={`/transcript/${job.id}`}
                  className="flex min-w-0 flex-1 items-center gap-4"
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--accent-2)]">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 18V5l12-2v13" />
                      <circle cx="6" cy="18" r="3" />
                      <circle cx="18" cy="16" r="3" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{job.filename}</p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {formatDate(job.createdAt)} · {formatBytes(job.sizeBytes)}
                      {job.durationSec
                        ? ` · ${formatDuration(job.durationSec)}`
                        : ""}
                    </p>
                  </div>
                </Link>
                <StatusBadge status={job.status} />
                <button
                  onClick={() => remove(job.id)}
                  className="rounded-lg p-2 text-[var(--muted)] opacity-0 transition-opacity hover:bg-[var(--surface-2)] hover:text-[#ff7676] group-hover:opacity-100"
                  title="Delete"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
