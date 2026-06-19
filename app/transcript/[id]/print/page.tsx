import { notFound } from "next/navigation";
import { getJob } from "@/lib/store";
import { formatDuration, formatTimestamp } from "@/lib/format";
import PrintControls from "@/components/PrintControls";

export const dynamic = "force-dynamic";

export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ auto?: string }>;
}) {
  const { id } = await params;
  const { auto } = await searchParams;
  const job = await getJob(id);
  if (!job) notFound();

  const meta = [new Date(job.createdAt).toLocaleString()];
  if (job.durationSec) meta.push(formatDuration(job.durationSec));
  if (job.language) meta.push(job.language.toUpperCase());

  return (
    <div className="print-doc mx-auto w-full max-w-3xl flex-1 px-8 py-10">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff !important; }
          .print-doc { color: #111 !important; }
          .print-doc h1, .print-doc h2, .print-doc h3,
          .print-doc p, .print-doc li, .print-doc span { color: #111 !important; }
          @page { margin: 18mm; }
        }
        .print-doc h2 { break-after: avoid; }
        .print-doc .seg { break-inside: avoid; }
      `}</style>

      <PrintControls auto={auto === "1"} />

      <h1 className="text-2xl font-bold">{job.filename}</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">{meta.join(" · ")}</p>

      {job.summary && (
        <section className="mt-8">
          <h2 className="mb-2 text-lg font-semibold">Summary</h2>
          <div className="space-y-3 leading-relaxed">
            {job.summary.split(/\n+/).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </section>
      )}

      {job.keyPoints && job.keyPoints.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-lg font-semibold">Key Points</h2>
          <ul className="list-disc space-y-1 pl-5">
            {job.keyPoints.map((k, i) => (
              <li key={i}>{k}</li>
            ))}
          </ul>
        </section>
      )}

      {job.actionItems && job.actionItems.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-lg font-semibold">Action Items</h2>
          <ul className="space-y-2">
            {job.actionItems.map((a, i) => (
              <li key={i}>
                <span className="mr-2">☐</span>
                {a.task}
                {(a.owner || a.due) && (
                  <span className="text-sm text-[var(--muted)]">
                    {" "}
                    ({[a.owner ? `owner: ${a.owner}` : "", a.due ? `due: ${a.due}` : ""]
                      .filter(Boolean)
                      .join(", ")}
                    )
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-2 text-lg font-semibold">Transcript</h2>
        {job.segments && job.segments.length > 0 ? (
          <div className="space-y-2">
            {job.segments.map((s, i) => (
              <p key={i} className="seg">
                <span className="font-mono text-xs text-[var(--muted)]">
                  {formatTimestamp(s.start)}
                </span>{" "}
                {s.speaker && <strong>{s.speaker}: </strong>}
                {s.text}
              </p>
            ))}
          </div>
        ) : (
          <p className="whitespace-pre-wrap leading-relaxed">{job.transcript}</p>
        )}
      </section>
    </div>
  );
}
