"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { EngineState, Opportunity, Position, Trade } from "@/lib/bot/types";

const POLL_MS = 5000;

function pct(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function usd(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function signColor(v: number | undefined | null): string {
  if (v === undefined || v === null || v === 0) return "";
  return v > 0 ? "text-emerald-400" : "text-rose-400";
}

function age(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function KindBadge({ kind }: { kind: string }) {
  const cross = kind === "cross-exchange";
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        cross ? "bg-sky-500/15 text-sky-300" : "bg-amber-500/15 text-amber-300"
      }`}
    >
      {cross ? "cross" : "carry"}
    </span>
  );
}

function legLabel(l: { exchange: string; market: string; side: string }) {
  return `${l.side} ${l.exchange} ${l.market === "spot" ? "spot" : "perp"}`;
}

export default function BotDashboard() {
  const [state, setState] = useState<EngineState | null>(null);
  const [engineAlive, setEngineAlive] = useState(false);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [open, setOpen] = useState<Position[]>([]);
  const [closed, setClosed] = useState<Position[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cfgDraft, setCfgDraft] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const [s, o, p] = await Promise.all([
        fetch("/api/bot/status", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/bot/opportunities", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/bot/positions", { cache: "no-store" }).then((r) => r.json()),
      ]);
      setState(s.state ?? null);
      setEngineAlive(Boolean(s.engineAlive));
      setOpps(o.opportunities ?? []);
      setOpen(p.open ?? []);
      setClosed(p.closed ?? []);
      setTrades(p.trades ?? []);
    } catch {
      // transient polling errors are fine
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  async function control(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await fetch("/api/bot/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function submitConfig() {
    const config: Record<string, number> = {};
    const numeric: Record<string, { key: string; scale: number }> = {
      minNetAprPct: { key: "minNetApr", scale: 0.01 },
      exitAprPct: { key: "exitApr", scale: 0.01 },
      maxPositionUsd: { key: "maxPositionUsd", scale: 1 },
      maxTotalExposureUsd: { key: "maxTotalExposureUsd", scale: 1 },
      maxOpenPositions: { key: "maxOpenPositions", scale: 1 },
    };
    for (const [field, { key, scale }] of Object.entries(numeric)) {
      const raw = cfgDraft[field];
      if (raw === undefined || raw.trim() === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) config[key] = n * scale;
    }
    if (Object.keys(config).length > 0) {
      control({ action: "update-config", config });
      setCfgDraft({});
    }
  }

  const cfg = state?.config;
  const unrealized = open.reduce((s, p) => s + (p.unrealizedPnlUsd ?? 0), 0);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-10">
      <header className="mb-8 flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent)]/20 text-[var(--accent-2)]">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v18h18" />
            <path d="m7 15 3-3 3 2 5-6" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Funding-Rate Arbitrage Bot</h1>
          <p className="text-sm text-[var(--muted)]">
            Binance · Bybit · OKX — cross-exchange & cash-and-carry
          </p>
        </div>
        <Link href="/" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
          ← Echo
        </Link>
      </header>

      {/* status bar */}
      <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-4">
        {!loaded ? (
          <p className="text-sm text-[var(--muted)]">Loading…</p>
        ) : !state ? (
          <p className="text-sm text-[var(--muted)]">
            No engine state yet. Start the engine with <code className="rounded bg-[var(--surface-2)] px-1.5 py-0.5">npm run bot</code>{" "}
            — it runs in paper mode by default (no API keys needed).
          </p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-bold uppercase ${
                  state.paper ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/20 text-rose-300"
                }`}
              >
                {state.paper ? "Paper" : "LIVE"}
              </span>
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                  engineAlive ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"
                }`}
              >
                engine {engineAlive ? "alive" : "not running"}
              </span>
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                  state.running ? "bg-sky-500/15 text-sky-300" : "bg-amber-500/15 text-amber-300"
                }`}
              >
                {state.running ? "opens enabled" : "opens halted"}
              </span>
              {(["binance", "bybit", "okx"] as const).map((ex) => (
                <span
                  key={ex}
                  className={`rounded-md px-2 py-0.5 text-xs ${
                    state.exchangesOk[ex]
                      ? "bg-[var(--surface-2)] text-[var(--muted)]"
                      : "bg-rose-500/10 text-rose-400/80 line-through"
                  }`}
                >
                  {ex}
                </span>
              ))}
              <span className="ml-auto text-xs text-[var(--muted)]">
                scan #{state.scanCount}
                {state.lastScanAt ? ` · ${age(state.lastScanAt)} ago` : ""}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ["Equity", usd(state.equityUsd), ""],
                ["Cash", usd(state.cashUsd), ""],
                ["Unrealized PnL", usd(unrealized), signColor(unrealized)],
                ["Realized PnL", usd(state.realizedPnlUsd), signColor(state.realizedPnlUsd)],
                ["Funding collected", usd(state.totalFundingUsd), signColor(state.totalFundingUsd)],
                ["Exposure", usd(state.totalExposureUsd), ""],
              ].map(([label, value, color]) => (
                <div key={label as string} className="rounded-lg bg-[var(--surface-2)]/60 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</p>
                  <p className={`text-base font-semibold ${color}`}>{value}</p>
                </div>
              ))}
            </div>
            {state.lastError && (
              <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {state.lastError}
              </p>
            )}
          </>
        )}
      </section>

      {/* controls */}
      <section className="mb-8 flex flex-wrap items-end gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-4">
        <div className="flex gap-2">
          <button
            onClick={() => control({ action: "start" })}
            disabled={busy || !engineAlive}
            className="rounded-lg bg-emerald-600/80 px-4 py-2 text-sm font-semibold hover:bg-emerald-600 disabled:opacity-40"
          >
            Start
          </button>
          <button
            onClick={() => control({ action: "stop" })}
            disabled={busy || !engineAlive}
            className="rounded-lg bg-amber-600/80 px-4 py-2 text-sm font-semibold hover:bg-amber-600 disabled:opacity-40"
          >
            Stop opens
          </button>
          <button
            onClick={() => {
              if (confirm("Close ALL open positions and halt new opens?")) {
                control({ action: "stop" }).then(() =>
                  control({ action: "close-position", positionId: "all" })
                );
              }
            }}
            disabled={busy || !engineAlive || open.length === 0}
            className="rounded-lg bg-rose-600/80 px-4 py-2 text-sm font-semibold hover:bg-rose-600 disabled:opacity-40"
          >
            Kill switch
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          {(
            [
              ["minNetAprPct", "Min net APR %", cfg ? (cfg.minNetApr * 100).toFixed(2) : ""],
              ["exitAprPct", "Exit APR %", cfg ? (cfg.exitApr * 100).toFixed(2) : ""],
              ["maxPositionUsd", "Max position $", cfg ? String(cfg.maxPositionUsd) : ""],
              ["maxTotalExposureUsd", "Max exposure $", cfg ? String(cfg.maxTotalExposureUsd) : ""],
              ["maxOpenPositions", "Max positions", cfg ? String(cfg.maxOpenPositions) : ""],
            ] as const
          ).map(([field, label, placeholder]) => (
            <label key={field} className="flex flex-col gap-1 text-[var(--muted)]">
              {label}
              <input
                value={cfgDraft[field] ?? ""}
                onChange={(e) => setCfgDraft((d) => ({ ...d, [field]: e.target.value }))}
                placeholder={placeholder}
                className="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
              />
            </label>
          ))}
          <button
            onClick={submitConfig}
            disabled={busy || !engineAlive}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 font-semibold hover:border-[var(--accent)]/50 disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </section>

      {/* open positions */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
          Open positions ({open.length})
        </h2>
        {open.length === 0 ? (
          <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-5 text-sm text-[var(--muted)]">
            No open positions.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--surface-2)]/70 text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                <tr>
                  <th className="px-3 py-2">Asset</th>
                  <th className="px-3 py-2">Structure</th>
                  <th className="px-3 py-2 text-right">Notional/leg</th>
                  <th className="px-3 py-2 text-right">Entry net APR</th>
                  <th className="px-3 py-2 text-right">Now APR</th>
                  <th className="px-3 py-2 text-right">Funding</th>
                  <th className="px-3 py-2 text-right">uPnL</th>
                  <th className="px-3 py-2 text-right">Age</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {open.map((p) => (
                  <tr key={p.id} className="border-t border-[var(--border)] bg-[var(--surface)]/50">
                    <td className="px-3 py-2 font-semibold">
                      {p.base} <KindBadge kind={p.kind} />
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--muted)]">
                      {legLabel(p.legs[1])} / {legLabel(p.legs[0])}
                    </td>
                    <td className="px-3 py-2 text-right">{usd(p.notionalUsd)}</td>
                    <td className="px-3 py-2 text-right">{pct(p.entryNetApr)}</td>
                    <td className={`px-3 py-2 text-right ${signColor(p.currentNetApr)}`}>
                      {pct(p.currentNetApr)}
                    </td>
                    <td className={`px-3 py-2 text-right ${signColor(p.fundingUsd)}`}>
                      {usd(p.fundingUsd)}
                    </td>
                    <td className={`px-3 py-2 text-right ${signColor(p.unrealizedPnlUsd)}`}>
                      {usd(p.unrealizedPnlUsd)}
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--muted)]">{age(p.openedAt)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => control({ action: "close-position", positionId: p.id })}
                        disabled={busy || !engineAlive}
                        className="rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:border-rose-400/60 hover:text-rose-300 disabled:opacity-40"
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* opportunities */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
          Scanner — top opportunities ({opps.length})
        </h2>
        {opps.length === 0 ? (
          <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-5 text-sm text-[var(--muted)]">
            No opportunities yet — waiting for the engine&apos;s first scan.
          </p>
        ) : (
          <div className="max-h-[28rem] overflow-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--surface-2)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Asset</th>
                  <th className="px-3 py-2">Structure</th>
                  <th className="px-3 py-2 text-right">Gross APR</th>
                  <th className="px-3 py-2 text-right">Cost APR</th>
                  <th className="px-3 py-2 text-right">Basis</th>
                  <th className="px-3 py-2 text-right">Net APR</th>
                </tr>
              </thead>
              <tbody>
                {opps.slice(0, 60).map((o, i) => (
                  <tr key={o.id} className="border-t border-[var(--border)] bg-[var(--surface)]/50">
                    <td className="px-3 py-1.5 text-xs text-[var(--muted)]">{i + 1}</td>
                    <td className="px-3 py-1.5 font-semibold">
                      {o.base} <KindBadge kind={o.kind} />
                    </td>
                    <td className="px-3 py-1.5 text-xs text-[var(--muted)]">
                      short {o.shortLeg.exchange} perp / {legLabel(o.longLeg)}
                    </td>
                    <td className="px-3 py-1.5 text-right">{pct(o.grossApr)}</td>
                    <td className="px-3 py-1.5 text-right text-[var(--muted)]">-{pct(o.feesApr)}</td>
                    <td className="px-3 py-1.5 text-right text-[var(--muted)]">
                      {o.basisPct.toFixed(3)}%
                    </td>
                    <td className={`px-3 py-1.5 text-right font-semibold ${signColor(o.netApr)}`}>
                      {pct(o.netApr)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* history */}
      <section className="mb-8 grid gap-8 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
            Closed positions
          </h2>
          {closed.length === 0 ? (
            <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-5 text-sm text-[var(--muted)]">
              Nothing closed yet.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {closed.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]/50 px-3 py-2"
                >
                  <span className="font-semibold">{p.base}</span>
                  <KindBadge kind={p.kind} />
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted)]">
                    {p.closeReason}
                  </span>
                  <span className={`text-xs ${signColor(p.fundingUsd)}`}>
                    fund {usd(p.fundingUsd)}
                  </span>
                  <span className={`font-semibold ${signColor(p.realizedPnlUsd)}`}>
                    {usd(p.realizedPnlUsd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
            Recent fills
          </h2>
          {trades.length === 0 ? (
            <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-5 text-sm text-[var(--muted)]">
              No fills yet.
            </p>
          ) : (
            <ul className="max-h-96 space-y-1 overflow-auto text-xs">
              {trades.map((t, i) => (
                <li
                  key={`${t.positionId}-${t.time}-${i}`}
                  className="flex items-center gap-2 rounded-md bg-[var(--surface)]/50 px-2.5 py-1.5"
                >
                  <span className="w-24 shrink-0 text-[var(--muted)]">
                    {new Date(t.time).toLocaleTimeString()}
                  </span>
                  <span
                    className={`w-9 font-semibold uppercase ${
                      t.side === "buy" ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {t.side}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {t.symbol} · {t.exchange} {t.market} · {t.action}
                  </span>
                  <span className="text-[var(--muted)]">
                    {t.qty.toPrecision(4)} @ {t.price}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <p className="text-xs text-[var(--muted)]">
        Funding-rate arbitrage is not risk-free: fills can slip, funding can flip, and one leg can
        fail. Paper-trade until the numbers convince you, then start small.
      </p>
    </main>
  );
}
