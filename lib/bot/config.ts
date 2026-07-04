import { BotConfig, ExchangeId } from "./types";

// All knobs come from env with conservative defaults. LIVE_TRADING can only be
// enabled via env + restart — the dashboard cannot flip paper -> live.

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export function loadConfig(): BotConfig {
  return {
    liveTrading: bool("LIVE_TRADING", false),
    scanIntervalMs: num("SCAN_INTERVAL_MS", 30_000),
    minNetApr: num("MIN_NET_APR", 0.08), // 8%/yr net to open
    exitApr: num("EXIT_APR", 0.02), // close below 2%/yr
    maxPositionUsd: num("MAX_POSITION_USD", 1_000),
    maxTotalExposureUsd: num("MAX_TOTAL_EXPOSURE_USD", 5_000),
    maxOpenPositions: num("MAX_OPEN_POSITIONS", 5),
    maxSlippageBps: num("MAX_SLIPPAGE_BPS", 5),
    maxEntryBasisPct: num("MAX_ENTRY_BASIS_PCT", 0.15),
    priceDivergenceStopPct: num("PRICE_DIVERGENCE_STOP_PCT", 3),
    // Horizon over which one-off entry/exit costs are amortized when scoring.
    // Too short makes fees dominate and nothing ever trades; funding-arb
    // structures are typically held for weeks.
    holdHorizonHours: num("HOLD_HORIZON_HOURS", 336),
    minQuoteVolumeUsd: num("MIN_QUOTE_VOLUME_USD", 2_000_000),
    maxPositionAgeHours: num("MAX_POSITION_AGE_HOURS", 24 * 14),
    paperStartingBalanceUsd: num("PAPER_STARTING_BALANCE_USD", 10_000),
    symbolAllowlist: (process.env.SYMBOL_ALLOWLIST || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  };
}

// Dashboard-adjustable subset (everything except the live/paper switch).
export const RUNTIME_TUNABLE: (keyof BotConfig)[] = [
  "minNetApr",
  "exitApr",
  "maxPositionUsd",
  "maxTotalExposureUsd",
  "maxOpenPositions",
  "maxSlippageBps",
  "maxEntryBasisPct",
  "priceDivergenceStopPct",
  "holdHorizonHours",
  "minQuoteVolumeUsd",
  "maxPositionAgeHours",
  "symbolAllowlist",
];

export interface ExchangeCredentials {
  apiKey?: string;
  secret?: string;
  password?: string; // OKX passphrase
}

export function loadCredentials(id: ExchangeId): ExchangeCredentials {
  const prefix = id.toUpperCase();
  return {
    apiKey: process.env[`${prefix}_API_KEY`],
    secret: process.env[`${prefix}_API_SECRET`],
    password: process.env[`${prefix}_API_PASSWORD`],
  };
}

export function hasCredentials(id: ExchangeId): boolean {
  const c = loadCredentials(id);
  return Boolean(c.apiKey && c.secret && (id !== "okx" || c.password));
}
