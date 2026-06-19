"use client";

import { useEffect } from "react";

export default function PrintControls({ auto = false }: { auto?: boolean }) {
  useEffect(() => {
    if (auto) {
      // Give the page a tick to lay out before opening the print dialog.
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [auto]);

  return (
    <div className="no-print mb-6 flex gap-3">
      <button
        onClick={() => window.print()}
        className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        Print / Save as PDF
      </button>
      <button
        onClick={() => window.close()}
        className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
      >
        Close
      </button>
    </div>
  );
}
