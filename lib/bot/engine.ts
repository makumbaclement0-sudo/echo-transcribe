// Funding-rate arbitrage engine loop. Runs in one of two ways:
//   - standalone process:  npm run bot  (scripts/bot.ts)
//   - embedded in the Next.js server:   BOT_AUTOSTART=true (instrumentation.ts)
// Paper mode by default; live trading requires LIVE_TRADING=true + API keys.

import { hasCredentials, loadConfig, RUNTIME_TUNABLE } from "./config";
import { createExchanges, loadAllMarkets } from "./exchanges";
import {
  accrueFunding,
  Executor,
  LiveExecutor,
  PaperExecutor,
  refreshMarks,
} from "./executor";
import { scan, snapshotIndex } from "./scanner";
import * as store from "./state";
import { decideCloses, decideOpen } from "./strategy";
import {
  BotConfig,
  ControlFile,
  EngineState,
  ExchangeId,
  EXCHANGE_IDS,
  Opportunity,
  Trade,
} from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), "[bot]", ...args);
}

export interface EngineOptions {
  /** true when run as its own process: installs signal handlers and may exit */
  standalone?: boolean;
}

let engineStarted = false;

/**
 * Runs the scan/trade loop forever. In embedded mode fatal setup problems
 * log + return (never kill the web server) and double-starts are ignored.
 */
export async function runEngine(opts: EngineOptions = {}): Promise<void> {
  const standalone = opts.standalone ?? false;
  if (engineStarted) {
    log("engine already running in this process — ignoring second start");
    return;
  }
  engineStarted = true;

  const fatal = (msg: string): void => {
    console.error(`[bot] FATAL: ${msg}`);
    if (standalone) process.exit(1);
    engineStarted = false;
  };

  let config = loadConfig();
  const liveExchanges = EXCHANGE_IDS.filter(hasCredentials);

  if (config.liveTrading && liveExchanges.length === 0) {
    return fatal(
      "LIVE_TRADING=true but no exchange API keys are configured. " +
        "Set BINANCE_/BYBIT_/OKX_API_KEY + _API_SECRET (+ OKX_API_PASSWORD). Refusing to start."
    );
  }

  const pairs = createExchanges();
  log("loading markets for", pairs.map((p) => p.id).join(", "), "…");
  await loadAllMarkets(pairs);
  // Transient network failures at startup (DNS blips, ISP hiccups at boot)
  // must not kill a trading daemon — retry until at least one venue answers.
  while (pairs.every((p) => !p.ok)) {
    for (const p of pairs) {
      log(`  ${p.id}: UNAVAILABLE (${(p.lastError ?? "").slice(0, 120)})`);
    }
    log("no exchange reachable — retrying in 60s (geo-blocks won't clear, outages will)");
    await sleep(60_000);
    await loadAllMarkets(pairs);
  }
  for (const p of pairs) {
    log(`  ${p.id}: ${p.ok ? "ok" : `UNAVAILABLE (${(p.lastError ?? "").slice(0, 120)})`}`);
  }

  const executor: Executor = config.liveTrading
    ? new LiveExecutor(pairs)
    : new PaperExecutor(config.maxSlippageBps);
  log(`mode: ${executor.paper ? "PAPER (simulated fills)" : "LIVE — REAL ORDERS"}`);
  if (!executor.paper) log("live-capable exchanges:", liveExchanges.join(", "));

  // Carry balances/PnL across restarts as long as the mode didn't change.
  const prev = await store.readState();
  const carry = prev && prev.paper === executor.paper;
  const state: EngineState = {
    running: true,
    paper: executor.paper,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    lastError: null,
    scanCount: 0,
    exchangesOk: {},
    cashUsd: carry ? prev.cashUsd : config.paperStartingBalanceUsd,
    equityUsd: carry ? prev.equityUsd : config.paperStartingBalanceUsd,
    totalFundingUsd: carry ? prev.totalFundingUsd : 0,
    realizedPnlUsd: carry ? prev.realizedPnlUsd : 0,
    openPositions: 0,
    totalExposureUsd: 0,
    config,
    updatedAt: new Date().toISOString(),
  };

  // Ignore control commands issued before this process started.
  let lastControlSeq = (await store.readControl())?.seq ?? 0;
  const requestedCloses = new Set<string>(); // position ids, or "all"

  let shuttingDown = false;
  if (standalone) {
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`${signal} — saving state and exiting (open positions persist on disk)`);
      state.updatedAt = new Date().toISOString();
      await store.saveState(state).catch(() => {});
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  }

  const applyControl = (cmd: ControlFile) => {
    lastControlSeq = cmd.seq;
    switch (cmd.action) {
      case "start":
        state.running = true;
        log("control: start — new opens enabled");
        break;
      case "stop":
        state.running = false;
        log("control: stop — new opens halted (positions still managed)");
        break;
      case "close-position":
        if (cmd.positionId) {
          requestedCloses.add(cmd.positionId);
          log("control: close requested for", cmd.positionId);
        }
        break;
      case "update-config": {
        const patch: Partial<BotConfig> = {};
        for (const key of RUNTIME_TUNABLE) {
          if (cmd.config && key in cmd.config) {
            (patch as Record<string, unknown>)[key] = cmd.config[key];
          }
        }
        config = { ...config, ...patch };
        state.config = config;
        log("control: config updated", JSON.stringify(patch));
        break;
      }
    }
  };

  const recordTrades = async (trades: Trade[] | undefined) => {
    if (trades && trades.length > 0) await store.appendTrades(trades);
  };

  // In live mode only open structures whose BOTH legs are on key-holding exchanges.
  const executable = (opps: Opportunity[]) =>
    executor.paper
      ? opps
      : opps.filter(
          (o) =>
            liveExchanges.includes(o.longLeg.exchange) &&
            liveExchanges.includes(o.shortLeg.exchange)
        );

  log(`scanning every ${config.scanIntervalMs / 1000}s; minNetApr=${config.minNetApr}`);

  while (!shuttingDown) {
    const t0 = Date.now();
    try {
      const control = await store.readControl();
      if (control && control.seq > lastControlSeq) applyControl(control);

      const result = await scan(pairs, config);
      await store.saveOpportunities(result.opportunities);
      for (const p of pairs) state.exchangesOk[p.id] = p.ok && !result.errors[p.id];

      const marks = snapshotIndex(result.snapshots);
      const now = new Date();
      const positions = (await store.listOpenPositions()).filter(
        (p) => p.paper === executor.paper
      );
      for (const pos of positions) {
        accrueFunding(pos, marks, now);
        refreshMarks(pos, marks);
      }

      // ---- closes: strategy exits + dashboard-requested ----
      const closes = decideCloses(positions, result.opportunities, config, now);
      const closeAll = requestedCloses.has("all");
      for (const pos of positions) {
        const requested = closeAll || requestedCloses.has(pos.id);
        if (requested && !closes.some((c) => c.position.id === pos.id)) {
          closes.push({ position: pos, reason: "manual close" });
        }
      }
      requestedCloses.clear();

      const closedIds = new Set<string>();
      for (const { position, reason } of closes) {
        try {
          const { position: closed, trades } = await executor.close(position, reason, marks);
          await recordTrades(trades);
          await store.archivePosition(closed);
          closedIds.add(closed.id);
          state.cashUsd += closed.realizedPnlUsd ?? 0;
          state.realizedPnlUsd += closed.realizedPnlUsd ?? 0;
          state.totalFundingUsd += closed.fundingUsd;
          log(
            `closed ${closed.id} ${closed.kind} ${closed.base} (${reason}) ` +
              `pnl=$${(closed.realizedPnlUsd ?? 0).toFixed(2)} funding=$${closed.fundingUsd.toFixed(2)}`
          );
        } catch (e) {
          const err = e as Error & { trades?: Trade[] };
          await recordTrades(err.trades);
          await store.savePosition(position); // status "closing" -> retried next scan
          log(`close FAILED for ${position.id}: ${err.message}`);
        }
      }

      const open = positions.filter((p) => !closedIds.has(p.id));

      // ---- opens ----
      if (state.running && !shuttingDown) {
        const decision = decideOpen(
          executable(result.opportunities),
          open,
          config,
          executor.paper ? state.cashUsd : null
        );
        if (decision) {
          const { opportunity, notionalUsd } = decision;
          try {
            const { position, trades } = await executor.open(opportunity, notionalUsd);
            await recordTrades(trades);
            refreshMarks(position, marks);
            await store.savePosition(position);
            open.push(position);
            log(
              `opened ${position.id} ${position.kind} ${position.base} ` +
                `$${notionalUsd.toFixed(0)}/leg netAPR=${(opportunity.netApr * 100).toFixed(2)}% ` +
                `(${opportunity.shortLeg.exchange} short / ${opportunity.longLeg.exchange} ${opportunity.longLeg.market} long)`
            );
          } catch (e) {
            const err = e as Error & { trades?: Trade[] };
            await recordTrades(err.trades);
            log(`open FAILED for ${opportunity.id}: ${err.message}`);
          }
        }
      }

      // ---- persist positions + state ----
      for (const pos of open) await store.savePosition(pos);

      if (!executor.paper) {
        state.cashUsd = await fetchLiveCash(pairs, liveExchanges).catch(() => state.cashUsd);
      }
      const unrealized = open.reduce((s, p) => s + (p.unrealizedPnlUsd ?? 0), 0);
      state.equityUsd = state.cashUsd + unrealized;
      state.openPositions = open.length;
      state.totalExposureUsd = open.reduce((s, p) => s + p.notionalUsd, 0);
      state.scanCount += 1;
      state.lastScanAt = now.toISOString();
      state.lastError = null;
      state.updatedAt = new Date().toISOString();
      await store.saveState(state);

      if (state.scanCount % 10 === 1) {
        const best = result.opportunities[0];
        log(
          `scan #${state.scanCount}: ${result.snapshots.length} markets, ` +
            `${result.opportunities.length} opportunities` +
            (best ? `, best ${best.id} net ${(best.netApr * 100).toFixed(2)}%` : "") +
            `, ${open.length} open, equity $${state.equityUsd.toFixed(2)}`
        );
      }
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
      state.updatedAt = new Date().toISOString();
      await store.saveState(state).catch(() => {});
      log("scan error:", state.lastError);
      await sleep(Math.min(config.scanIntervalMs * 2, 120_000)); // extra backoff
    }
    const elapsed = Date.now() - t0;
    await sleep(Math.max(1_000, config.scanIntervalMs - elapsed));
  }
}

async function fetchLiveCash(
  pairs: ReturnType<typeof createExchanges>,
  liveExchanges: ExchangeId[]
): Promise<number> {
  let total = 0;
  for (const p of pairs) {
    if (!p.ok || !liveExchanges.includes(p.id)) continue;
    const bal = await p.swap.fetchBalance();
    const free = (bal.free as unknown as Record<string, number | undefined>)?.["USDT"];
    if (typeof free === "number") total += free;
  }
  return total;
}
