"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Opportunity, ScanResult } from "@/lib/funding/types";

const EXCHANGE_LABEL: Record<string, string> = {
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
  hyperliquid: "Hyperliquid",
};

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
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useMemo(
    () =>
      `?holdDays=${holdDays}&slippagePct=${slippagePct}&minNetPct=${minNetPct}`,
    [holdDays, slippagePct, minNetPct]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/funding${query}`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
    } catch {
      // keep last good data on transient errors
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!auto) return;
    timer.current = setTimeout(refresh, 30_000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [auto, data, refresh]);

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
            <span className="font-medium">net edge after costs</span>.
          </p>
        </div>
        <Link
          href="/"
          className="text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-800"
        >
          ← Echo
        </Link>
      </header>

      {/* Controls */}
      <section className="mb-6 grid grid-cols-1 gap-4 rounded-xl border border-neutral-200 bg-white/50 p-4 sm:grid-cols-4 dark:border-neutral-800 dark:bg-neutral-900/40">
        <Field label="Hold period (days)" hint="Longer holds amortize fees">
          <input
            type="number"
            min={0.5}
            step={0.5}
            value={holdDays}
            onChange={(e) => setHoldDays(Number(e.target.value))}
            className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700"
          />
        </Field>
        <Field label="Slippage / fill (%)" hint="Per leg, one way">
          <input
            type="number"
            min={0}
            step={0.01}
            value={slippagePct}
            onChange={(e) => setSlippagePct(Number(e.target.value))}
            className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700"
          />
        </Field>
        <Field label="Min net APR (%)" hint="Safety margin to flag green">
          <input
            type="number"
            min={0}
            step={0.5}
            value={minNetPct}
            onChange={(e) => setMinNetPct(Number(e.target.value))}
            className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700"
          />
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
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            Auto (30s)
          </label>
        </div>
      </section>

      {/* Summary */}
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-neutral-500">
        <span>
          <span className="font-semibold text-neutral-800 dark:text-neutral-200">
            {profitable.length}
          </span>{" "}
          of {opps.length} pairs clear your {minNetPct}% net threshold
        </span>
        {data && (
          <span>Updated {new Date(data.generatedAt).toLocaleTimeString()}</span>
        )}
        {data?.errors.map((e) => (
          <span key={e.exchange} className="text-amber-600">
            {EXCHANGE_LABEL[e.exchange] ?? e.exchange} unavailable
          </span>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
              <Th>Coin</Th>
              <Th>Short (receive)</Th>
              <Th>Long (pay)</Th>
              <Th className="text-right">Gross APR</Th>
              <Th className="text-right">Cost drag</Th>
              <Th className="text-right">Net APR</Th>
              <Th className="text-right">Next funding</Th>
            </tr>
          </thead>
          <tbody>
            {opps.map((o) => (
              <Row key={o.coin} o={o} />
            ))}
            {opps.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-10 text-center text-neutral-500"
                >
                  {loading ? "Scanning venues…" : "No opportunities found."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-neutral-500">
        <strong>How to read this:</strong> each row is a market-neutral pair —
        SHORT the perp on the high-funding venue and LONG it on the low-funding
        venue in equal size. You collect the funding <em>differential</em> while
        price exposure cancels. <strong>Net APR</strong> already subtracts
        round-trip taker fees and your slippage assumption, amortized over the
        hold period — that is the only column that decides whether a trade is
        worth doing.
      </p>
      <p className="mt-3 text-xs leading-relaxed text-neutral-400">
        Estimates from public funding data, not financial advice and not a
        profit guarantee. Live funding flips sign, the short leg can be
        liquidated without a margin buffer, and venues carry counterparty risk.
        Validate on paper before risking capital.
      </p>
    </main>
  );
}

function Row({ o }: { o: Opportunity }) {
  const net = o.netApr;
  const netColor =
    net >= 0.03
      ? "text-emerald-600 dark:text-emerald-400"
      : net > 0
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-500";
  return (
    <tr className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-900/40">
      <td className="px-3 py-2.5 font-medium">{o.coin}</td>
      <td className="px-3 py-2.5">
        {EXCHANGE_LABEL[o.short.exchange] ?? o.short.exchange}
        <span className="ml-1 text-xs text-neutral-400">
          {pct(o.short.aprFraction)}
        </span>
      </td>
      <td className="px-3 py-2.5">
        {EXCHANGE_LABEL[o.long.exchange] ?? o.long.exchange}
        <span className="ml-1 text-xs text-neutral-400">
          {pct(o.long.aprFraction)}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {pct(o.grossApr)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-neutral-500">
        −{pct(o.costDragApr)}
      </td>
      <td
        className={`px-3 py-2.5 text-right font-semibold tabular-nums ${netColor}`}
      >
        {pct(net)}
      </td>
      <td className="px-3 py-2.5 text-right text-xs text-neutral-500">
        {EXCHANGE_LABEL[o.short.exchange]?.slice(0, 3)}{" "}
        {nextFunding(o.short.nextFundingMs)} · {EXCHANGE_LABEL[o.long.exchange]?.slice(0, 3)}{" "}
        {nextFunding(o.long.nextFundingMs)}
      </td>
    </tr>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-neutral-400">{hint}</span>}
    </label>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <th className={`px-3 py-2.5 font-medium ${className}`}>{children}</th>;
}
