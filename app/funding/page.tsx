"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Opportunity, ScanResult } from "@/lib/funding/types";
import type { BacktestResult } from "@/lib/funding/backtest";

const EXCHANGE_LABEL: Record<string, string> = {
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
  hyperliquid: "Hyperliquid",
};

type BtState =
  | { status: "loading" }
  | { status: "ok"; data: BacktestResult }
  | { status: "error"; message: string };

function pct(fraction: number, digits = 2): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

function nextFunding(ms: number | null): string {
  if (!ms) return "—";
  const mins = Math.round((ms - Date.now()) / 60000);
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export default function FundingPage() {
  const [holdDays, setHoldDays] = useState(14);
  const [slippagePct, setSlippagePct] = useState(0.03);
  const [minNetPct, setMinNetPct] = useState(3);
  const [btDays, setBtDays] = useState(30);
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [backtests, setBacktests] = useState<Record<string, BtState>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useMemo(
    () => `?holdDays=${holdDays}&slippagePct=${slippagePct}&minNetPct=${minNetPct}`,
    [holdDays, slippagePct, minNetPct]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/funding${query}`, { cache: "no-store" });
      setData((await res.json()) as ScanResult);
    } catch {
      // keep last good data
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!auto) return;
    timer.current = setTimeout(refresh, 30_000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [auto, data, refresh]);

  const runBacktest = useCallback(
    async (o: Opportunity) => {
      const key = o.coin;
      setBacktests((b) => ({ ...b, [key]: { status: "loading" } }));
      try {
        const res = await fetch(
          `/api/funding/backtest?coin=${o.coin}&short=${o.short.exchange}&long=${o.long.exchange}&days=${btDays}&slippagePct=${slippagePct}`,
          { cache: "no-store" }
        );
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "backtest failed");
        setBacktests((b) => ({ ...b, [key]: { status: "ok", data: json } }));
      } catch (e) {
        setBacktests((b) => ({
          ...b,
          [key]: { status: "error", message: e instanceof Error ? e.message : "failed" },
        }));
      }
    },
    [btDays, slippagePct]
  );

  const toggle = useCallback(
    (o: Opportunity) => {
      const key = o.coin;
      if (expanded === key) {
        setExpanded(null);
        return;
      }
      setExpanded(key);
      if (!backtests[key] || backtests[key].status === "error") runBacktest(o);
    },
    [expanded, backtests, runBacktest]
  );

  const opps = data?.opportunities ?? [];
  const profitable = opps.filter((o) => o.profitable);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Funding Arbitrage Scanner
          </h1>
          <p className="text-sm text-neutral-500">
            Cross-exchange delta-neutral funding differential, ranked by{" "}
            <span className="font-medium">net edge after costs</span> — click a
            row to backtest whether the edge actually persists.
          </p>
        </div>
        <Link
          href="/"
          className="text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-800"
        >
          ← Echo
        </Link>
      </header>

      <section className="mb-6 grid grid-cols-2 gap-4 rounded-xl border border-neutral-200 bg-white/50 p-4 sm:grid-cols-5 dark:border-neutral-800 dark:bg-neutral-900/40">
        <Field label="Hold period (days)" hint="Amortizes fees">
          <NumInput value={holdDays} min={0.5} step={0.5} onChange={setHoldDays} />
        </Field>
        <Field label="Slippage / fill (%)" hint="Per leg, one way">
          <NumInput value={slippagePct} min={0} step={0.01} onChange={setSlippagePct} />
        </Field>
        <Field label="Min net APR (%)" hint="Flag-green threshold">
          <NumInput value={minNetPct} min={0} step={0.5} onChange={setMinNetPct} />
        </Field>
        <Field label="Backtest window (days)" hint="History depth">
          <NumInput value={btDays} min={3} step={1} onChange={setBtDays} />
        </Field>
        <div className="flex items-end gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {loading ? "Scanning…" : "Rescan"}
          </button>
          <label className="flex items-center gap-1.5 text-sm text-neutral-500">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Auto
          </label>
        </div>
      </section>

      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-neutral-500">
        <span>
          <span className="font-semibold text-neutral-800 dark:text-neutral-200">
            {profitable.length}
          </span>{" "}
          of {opps.length} pairs clear your {minNetPct}% net threshold
        </span>
        {data && <span>Updated {new Date(data.generatedAt).toLocaleTimeString()}</span>}
        {data?.errors.map((e) => (
          <span key={e.exchange} className="text-amber-600">
            {EXCHANGE_LABEL[e.exchange] ?? e.exchange} unavailable
          </span>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
              <Th>Coin</Th>
              <Th>Short (receive)</Th>
              <Th>Long (pay)</Th>
              <Th className="text-right">Gross APR</Th>
              <Th className="text-right">Cost drag</Th>
              <Th className="text-right">Net APR (now)</Th>
              <Th className="text-right">Next funding</Th>
            </tr>
          </thead>
          <tbody>
            {opps.map((o) => (
              <Row
                key={o.coin}
                o={o}
                open={expanded === o.coin}
                bt={backtests[o.coin]}
                onToggle={() => toggle(o)}
              />
            ))}
            {opps.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-neutral-500">
                  {loading ? "Scanning venues…" : "No opportunities found."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-neutral-500">
        <strong>Net APR (now)</strong> is the current snapshot after round-trip
        fees + slippage, amortized over your hold period. But a fat snapshot
        spread often reverses the moment you size in — so{" "}
        <strong>click any row</strong> to replay the differential over history:{" "}
        <em>persistence</em> (how often it stayed favorable) and the{" "}
        <em>realized net APR</em> are what actually separate a durable edge from
        a one-cycle trap.
      </p>
      <p className="mt-3 text-xs leading-relaxed text-neutral-400">
        Estimates from public funding data — not financial advice, not a profit
        guarantee. Funding flips sign, the short leg can be liquidated without a
        margin buffer, and venues carry counterparty risk. Validate on paper
        before risking capital.
      </p>
    </main>
  );
}

function Row({
  o,
  open,
  bt,
  onToggle,
}: {
  o: Opportunity;
  open: boolean;
  bt: BtState | undefined;
  onToggle: () => void;
}) {
  const net = o.netApr;
  const netColor =
    net >= 0.03
      ? "text-emerald-600 dark:text-emerald-400"
      : net > 0
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-500";
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-neutral-100 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-900/40"
      >
        <td className="px-3 py-2.5 font-medium">
          <span className="mr-1 inline-block text-neutral-400">{open ? "▾" : "▸"}</span>
          {o.coin}
        </td>
        <td className="px-3 py-2.5">
          {EXCHANGE_LABEL[o.short.exchange] ?? o.short.exchange}
          <span className="ml-1 text-xs text-neutral-400">{pct(o.short.aprFraction)}</span>
        </td>
        <td className="px-3 py-2.5">
          {EXCHANGE_LABEL[o.long.exchange] ?? o.long.exchange}
          <span className="ml-1 text-xs text-neutral-400">{pct(o.long.aprFraction)}</span>
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums">{pct(o.grossApr)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums text-neutral-500">
          −{pct(o.costDragApr)}
        </td>
        <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${netColor}`}>
          {pct(net)}
        </td>
        <td className="px-3 py-2.5 text-right text-xs text-neutral-500">
          {EXCHANGE_LABEL[o.short.exchange]?.slice(0, 3)} {nextFunding(o.short.nextFundingMs)} ·{" "}
          {EXCHANGE_LABEL[o.long.exchange]?.slice(0, 3)} {nextFunding(o.long.nextFundingMs)}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-neutral-100 bg-neutral-50/60 dark:border-neutral-800/60 dark:bg-neutral-900/30">
          <td colSpan={7} className="px-4 py-4">
            <BacktestPanel bt={bt} />
          </td>
        </tr>
      )}
    </>
  );
}

function BacktestPanel({ bt }: { bt: BtState | undefined }) {
  if (!bt || bt.status === "loading")
    return <p className="text-sm text-neutral-500">Replaying funding history…</p>;
  if (bt.status === "error")
    return <p className="text-sm text-red-500">Backtest unavailable: {bt.message}</p>;

  const d = bt.data;
  const netColor =
    d.netApr >= 0.03
      ? "text-emerald-600 dark:text-emerald-400"
      : d.netApr > 0
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-500";
  const persistColor =
    d.persistence >= 0.7
      ? "text-emerald-600 dark:text-emerald-400"
      : d.persistence >= 0.5
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-500";

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Realized net APR" value={pct(d.netApr)} className={netColor} />
        <Stat label="Persistence" value={pct(d.persistence, 0)} className={persistColor}
          hint="% of periods favorable" />
        <Stat label="Ann. Sharpe" value={d.annualizedSharpe.toFixed(2)}
          className={d.annualizedSharpe >= 1 ? "text-emerald-600 dark:text-emerald-400" : "text-neutral-700 dark:text-neutral-300"} />
        <Stat label="Worst period" value={pct(d.worstBucket, 3)} className="text-neutral-700 dark:text-neutral-300" />
        <Stat label="Exposure" value={`${d.exposureDays.toFixed(1)}d · ${d.buckets} pds`}
          className="text-neutral-700 dark:text-neutral-300" />
      </div>
      <Sparkline series={d.series} />
    </div>
  );
}

function Sparkline({ series }: { series: number[] }) {
  if (series.length < 2) return null;
  const w = 220;
  const h = 44;
  const max = Math.max(...series, 0);
  const min = Math.min(...series, 0);
  const range = max - min || 1;
  const x = (i: number) => (i / (series.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / range) * h;
  const path = series.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  return (
    <svg width={w} height={h} className="shrink-0" aria-label="Per-period differential">
      <line x1={0} x2={w} y1={zeroY} y2={zeroY} stroke="currentColor" className="text-neutral-300 dark:text-neutral-700" strokeWidth={1} strokeDasharray="3 3" />
      <path d={path} fill="none" stroke="currentColor" className="text-sky-500" strokeWidth={1.5} />
    </svg>
  );
}

function Stat({ label, value, className = "", hint }: { label: string; value: string; className?: string; hint?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-neutral-400">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${className}`}>{value}</div>
      {hint && <div className="text-[10px] text-neutral-400">{hint}</div>}
    </div>
  );
}

function NumInput({ value, min, step, onChange }: { value: number; min?: number; step?: number; onChange: (n: number) => void }) {
  return (
    <input
      type="number"
      min={min}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700"
    />
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-neutral-400">{hint}</span>}
    </label>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2.5 font-medium ${className}`}>{children}</th>;
}
