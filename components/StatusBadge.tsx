import { JobStatus } from "@/lib/types";
import { STATUS_META } from "@/lib/format";

export default function StatusBadge({ status }: { status: JobStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{
        backgroundColor: `${meta.color}1a`,
        color: meta.color,
        border: `1px solid ${meta.color}33`,
      }}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${meta.pulse ? "animate-pulse" : ""}`}
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
    </span>
  );
}
