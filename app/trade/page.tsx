"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ExecView, Venue } from "@/lib/exec/types";

interface Status {
  mode: "sim" | "testnet";
  enabled: boolean;
  halted: boolean;
  limits: { maxUsdPerLeg: number; maxLeverage: number; minNetApr: number };
  venues: { venue: Venue; configured: boolean }[];
  hyperliquidAddress: string | null;
  positions: ExecView[];
}

function money(n: number): string {
  const v = Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
  return `${n < 0 ? "−" : ""}$${v}`;
}

const LABEL: Record<string, string> = {
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
  hyperliquid: "Hyperliquid",
};
// Venues whose testnet execution is wired.
const WIRED: Venue[] = ["binance", "bybit", "okx", "hyperliquid"];

export default function TradePage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [coin, setCoin] = useState("BTC");
  const [short, setShort] = useState<Venue>("okx");
  const [long, setLong] = useState<Venue>("hyperliquid");
  const [usd, setUsd] = useState(50);
  const [leverage, setLeverage] = useState(2);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/exec/status", { cache: "no-store" });
      setStatus(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // Status is populated asynchronously after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const execute = useCallback(async () => {
    if (short === long) {
      setMsg("Short and long must be different venues.");
      return;
    }
    const kind = status?.mode === "sim" ? "SIMULATED" : "TESTNET";
    if (
      !confirm(
        `${kind} order:\nSHORT ${LABEL[short]} · LONG ${LABEL[long]}\n${coin} — $${usd}/leg @ ${leverage}x\n\nPlace it?`
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    try {
      // Pull the coin's current net edge from the scanner to satisfy the gate.
      let netApr = 0;
      try {
        const scan = await fetch("/api/funding?holdDays=14", { cache: "no-store" });
        const j = await scan.json();
        netApr =
          j.opportunities?.find(
            (o: { coin: string }) => o.coin === coin.toUpperCase()
          )?.netApr ?? 0;
      } catch {
        /* fall through with 0 */
      }
      const res = await fetch("/api/exec/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ coin, short, long, usd, leverage, netApr }),
      });
      const j = await res.json();
      setMsg(res.ok ? `Opened pair ${j.position.id}` : `Blocked: ${j.error}`);
      refresh();
    } finally {
      setBusy(false);
    }
  }, [coin, short, long, usd, leverage, refresh, status?.mode]);

  const close = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const res = await fetch("/api/exec/close", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
        const j = await res.json();
        setMsg(res.ok ? `Closed ${id}` : `Close failed: ${j.error}`);
        refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const setHalt = useCallback(
    async (on: boolean) => {
      await fetch("/api/exec/halt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      });
      refresh();
    },
    [refresh]
  );

  const open = (status?.positions ?? []).filter((p) => p.status === "open");

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Testnet Trading</h1>
        <Link
          href="/funding"
          className="text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-800"
        >
          ← Scanner
        </Link>
      </header>

      {status?.mode === "sim" ? (
        <div className="mb-6 rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-3 text-sm text-sky-700 dark:text-sky-300">
          <strong>SIMULATION.</strong> Fills are synthesized instantly at{" "}
          <em>live</em> mark prices — no API keys, no wallet, nothing at risk.
          The full trade flow (leg-in, unwind-on-failure, positions, history)
          runs exactly as it would live. Set <code>EXEC_MODE=testnet</code> with
          keys to place real testnet orders instead.
        </div>
      ) : (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <strong>TESTNET.</strong> Real orders on exchange test environments
          with fake funds. Keep API keys trade-only (never withdrawal) and in{" "}
          <code>.env.local</code>.
        </div>
      )}

      {status && (
        <section className="mb-6 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Mode"
            value={status.mode === "sim" ? "SIMULATION" : status.enabled ? "TESTNET · ARMED" : "TESTNET · off"}
            className={status.mode === "sim" ? "text-sky-600 dark:text-sky-400" : status.enabled ? "text-emerald-600" : "text-neutral-500"} />
          <Stat label="Kill switch" value={status.halted ? "HALTED" : "clear"}
            className={status.halted ? "text-red-500" : "text-neutral-500"} />
          <Stat label="Max / leg" value={`$${status.limits.maxUsdPerLeg}`} />
          <Stat label="Max leverage" value={`${status.limits.maxLeverage}x`} />
        </section>
      )}

      {status && (
        <p className="mb-6 text-xs text-neutral-500">
          {status.mode === "sim" ? (
            <>Venues: all four available — no keys needed in simulation.</>
          ) : (
            <>
              Venues wired:{" "}
              {status.venues.map((v) => (
                <span key={v.venue} className="mr-3">
                  {LABEL[v.venue]}:{" "}
                  <span className={v.configured ? "text-emerald-600" : "text-red-500"}>
                    {v.configured ? "keys ok" : "no keys"}
                  </span>
                </span>
              ))}
            </>
          )}
          {status.hyperliquidAddress && (
            <span className="block mt-1">
              Hyperliquid signs as{" "}
              <code className="text-neutral-600 dark:text-neutral-300">
                {status.hyperliquidAddress}
              </code>{" "}
              — fund this address on testnet.
            </span>
          )}
        </p>
      )}

      <section className="mb-8 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Open a delta-neutral pair
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Field label="Coin">
            <input value={coin} onChange={(e) => setCoin(e.target.value.toUpperCase())}
              className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700" />
          </Field>
          <Field label="Short (receive)">
            <Select value={short} onChange={setShort} />
          </Field>
          <Field label="Long (pay)">
            <Select value={long} onChange={setLong} />
          </Field>
          <Field label="USD / leg">
            <input type="number" min={1} value={usd} onChange={(e) => setUsd(Number(e.target.value))}
              className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700" />
          </Field>
          <Field label="Leverage">
            <input type="number" min={1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))}
              className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700" />
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={execute} disabled={busy || !status?.enabled}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900">
            {busy ? "Working…" : "Open testnet pair"}
          </button>
          {status?.halted ? (
            <button onClick={() => setHalt(false)} className="rounded-md border border-emerald-500 px-3 py-2 text-sm text-emerald-600">
              Resume
            </button>
          ) : (
            <button onClick={() => setHalt(true)} className="rounded-md border border-red-500 px-3 py-2 text-sm text-red-500">
              HALT all
            </button>
          )}
          {!status?.enabled && (
            <span className="text-xs text-neutral-500">
              Set <code>EXEC_ENABLED=true</code> in <code>.env.local</code> to arm.
            </span>
          )}
        </div>
        {msg && <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-300">{msg}</p>}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Open positions ({open.length})
        </h2>
        {open.length === 0 ? (
          <p className="text-sm text-neutral-500">No open testnet positions.</p>
        ) : (
          <div className="space-y-2">
            {open.map((p) => {
              const pnlColor =
                p.netPnlUsd > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : p.netPnlUsd < 0
                    ? "text-red-500"
                    : "text-neutral-500";
              return (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
                  <span>
                    <span className="font-medium">{p.coin}</span> · S:{LABEL[p.short.venue]} · L:{LABEL[p.long.venue]} · ${p.usd}/leg @ {p.leverage}x
                    <span className="ml-2 text-xs text-neutral-400">
                      {p.ageHours < 1 ? `${Math.round(p.ageHours * 60)}m` : `${p.ageHours.toFixed(1)}h`} old
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-neutral-400">
                      funding {money(p.accruedFundingUsd ?? 0)} · fees −{money(p.feesUsd)}
                    </span>
                    <span className={`font-semibold tabular-nums ${pnlColor}`}>
                      {money(p.netPnlUsd)}
                    </span>
                    <button onClick={() => close(p.id)} disabled={busy}
                      className="text-xs text-neutral-400 underline underline-offset-2 hover:text-red-500">
                      close
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <TradeHistory positions={status?.positions ?? []} />
    </main>
  );
}

function TradeHistory({ positions }: { positions: ExecView[] }) {
  if (positions.length === 0) return null;
  const usd = (n: number) =>
    `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const statusColor: Record<string, string> = {
    open: "text-emerald-600 dark:text-emerald-400",
    closed: "text-neutral-500",
    unwound: "text-red-500",
  };
  const leg = (l: ExecView["short"]) =>
    l.filledQty > 0
      ? `${l.filledQty}@${l.avgPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
      : l.status;
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Trade history ({positions.length})
      </h2>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
              <th className="px-3 py-2.5 font-medium">Opened</th>
              <th className="px-3 py-2.5 font-medium">Coin</th>
              <th className="px-3 py-2.5 font-medium">Short leg</th>
              <th className="px-3 py-2.5 font-medium">Long leg</th>
              <th className="px-3 py-2.5 text-right font-medium">Size</th>
              <th className="px-3 py-2.5 text-right font-medium">Net P&amp;L</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr
                key={p.id}
                className="border-b border-neutral-100 last:border-0 align-top dark:border-neutral-800/60"
              >
                <td className="px-3 py-2.5 text-xs text-neutral-500">
                  {new Date(p.openedAt).toLocaleString()}
                </td>
                <td className="px-3 py-2.5 font-medium">{p.coin}</td>
                <td className="px-3 py-2.5 text-xs">
                  {LABEL[p.short.venue]}
                  <span className="ml-1 text-neutral-400">{leg(p.short)}</span>
                </td>
                <td className="px-3 py-2.5 text-xs">
                  {LABEL[p.long.venue]}
                  <span className="ml-1 text-neutral-400">{leg(p.long)}</span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{usd(p.usd)}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums ${p.netPnlUsd > 0 ? "text-emerald-600 dark:text-emerald-400" : p.netPnlUsd < 0 ? "text-red-500" : "text-neutral-500"}`}>
                  {money(p.netPnlUsd)}
                </td>
                <td className={`px-3 py-2.5 text-xs font-medium ${statusColor[p.status] ?? ""}`}>
                  {p.status}
                  {p.mode && (
                    <span className="ml-1 rounded bg-neutral-200 px-1 text-[9px] uppercase text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                      {p.mode}
                    </span>
                  )}
                  {p.note && (
                    <span className="block text-[10px] font-normal text-neutral-400">
                      {p.note}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Select({ value, onChange }: { value: Venue; onChange: (v: Venue) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Venue)}
      className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700">
      {WIRED.map((v) => (
        <option key={v} value={v} className="dark:bg-neutral-900">
          {LABEL[v]}
        </option>
      ))}
    </select>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">{label}</span>
      {children}
    </label>
  );
}

function Stat({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800">
      <div className="text-[11px] uppercase tracking-wide text-neutral-400">{label}</div>
      <div className={`text-sm font-semibold ${className}`}>{value}</div>
    </div>
  );
}
