import { annualize, DEFAULT_INTERVAL_HOURS, UNIVERSE } from "./config";
import type { ExchangeId, FundingPoint } from "./types";

const UNIVERSE_SET = new Set<string>(UNIVERSE);

/**
 * API base URLs. Overridable via env so a deployment can point at a
 * region-appropriate host — some venues (e.g. Binance, Bybit) geo-block
 * certain egress IPs, and a scan from such a host simply reports that venue
 * as unavailable rather than failing the whole cycle.
 */
const BASE = {
  binance: process.env.FUNDING_BINANCE_BASE ?? "https://fapi.binance.com",
  bybit: process.env.FUNDING_BYBIT_BASE ?? "https://api.bybit.com",
  okx: process.env.FUNDING_OKX_BASE ?? "https://www.okx.com",
  hyperliquid:
    process.env.FUNDING_HYPERLIQUID_BASE ?? "https://api.hyperliquid.xyz",
};

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

function point(
  exchange: ExchangeId,
  coin: string,
  instrument: string,
  fundingRate: number,
  markPrice: number | null,
  nextFundingMs: number | null
): FundingPoint {
  const intervalHours = DEFAULT_INTERVAL_HOURS[exchange];
  return {
    exchange,
    coin,
    instrument,
    fundingRate,
    intervalHours,
    aprFraction: annualize(fundingRate, intervalHours),
    markPrice,
    nextFundingMs,
  };
}

// ---- Binance USDⓈ-M ------------------------------------------------------
// One bulk call returns the premium index (incl. lastFundingRate) for all perps.
export async function fetchBinance(): Promise<FundingPoint[]> {
  const data = (await getJson(
    `${BASE.binance}/fapi/v1/premiumIndex`
  )) as Array<{
    symbol: string;
    markPrice: string;
    lastFundingRate: string;
    nextFundingTime: number;
  }>;

  const out: FundingPoint[] = [];
  for (const d of data) {
    if (!d.symbol.endsWith("USDT")) continue;
    const coin = d.symbol.slice(0, -"USDT".length);
    if (!UNIVERSE_SET.has(coin)) continue;
    out.push(
      point(
        "binance",
        coin,
        d.symbol,
        Number(d.lastFundingRate),
        Number(d.markPrice) || null,
        d.nextFundingTime || null
      )
    );
  }
  return out;
}

// ---- Bybit v5 (linear) ---------------------------------------------------
export async function fetchBybit(): Promise<FundingPoint[]> {
  const data = (await getJson(
    `${BASE.bybit}/v5/market/tickers?category=linear`
  )) as {
    result?: {
      list?: Array<{
        symbol: string;
        markPrice: string;
        fundingRate: string;
        nextFundingTime: string;
      }>;
    };
  };

  const out: FundingPoint[] = [];
  for (const d of data.result?.list ?? []) {
    if (!d.symbol.endsWith("USDT")) continue;
    const coin = d.symbol.slice(0, -"USDT".length);
    if (!UNIVERSE_SET.has(coin)) continue;
    if (d.fundingRate === "" || d.fundingRate == null) continue;
    out.push(
      point(
        "bybit",
        coin,
        d.symbol,
        Number(d.fundingRate),
        Number(d.markPrice) || null,
        Number(d.nextFundingTime) || null
      )
    );
  }
  return out;
}

// ---- OKX -----------------------------------------------------------------
// Funding is per-instrument; mark prices come from one bulk SWAP call.
export async function fetchOkx(): Promise<FundingPoint[]> {
  const markMap = new Map<string, number>();
  try {
    const marks = (await getJson(
      `${BASE.okx}/api/v5/public/mark-price?instType=SWAP`
    )) as { data?: Array<{ instId: string; markPx: string }> };
    for (const m of marks.data ?? []) markMap.set(m.instId, Number(m.markPx));
  } catch {
    // mark prices are optional; continue without them
  }

  const results = await Promise.allSettled(
    UNIVERSE.map(async (coin) => {
      const instId = `${coin}-USDT-SWAP`;
      const data = (await getJson(
        `${BASE.okx}/api/v5/public/funding-rate?instId=${instId}`
      )) as {
        data?: Array<{
          instId: string;
          fundingRate: string;
          nextFundingTime: string;
        }>;
      };
      const d = data.data?.[0];
      if (!d || d.fundingRate === "") return null;
      return point(
        "okx",
        coin,
        instId,
        Number(d.fundingRate),
        markMap.get(instId) ?? null,
        Number(d.nextFundingTime) || null
      );
    })
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<FundingPoint | null> =>
        r.status === "fulfilled"
    )
    .map((r) => r.value)
    .filter((p): p is FundingPoint => p != null);
}

// ---- Hyperliquid ---------------------------------------------------------
// One POST returns per-asset context incl. the (hourly) funding rate.
export async function fetchHyperliquid(): Promise<FundingPoint[]> {
  const data = (await getJson(`${BASE.hyperliquid}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  })) as [
    { universe: Array<{ name: string }> },
    Array<{ funding: string; markPx: string }>
  ];

  const meta = data[0]?.universe ?? [];
  const ctxs = data[1] ?? [];
  const out: FundingPoint[] = [];
  for (let i = 0; i < meta.length; i++) {
    const coin = meta[i]?.name;
    const ctx = ctxs[i];
    if (!coin || !ctx || !UNIVERSE_SET.has(coin)) continue;
    out.push(
      point(
        "hyperliquid",
        coin,
        coin,
        Number(ctx.funding),
        Number(ctx.markPx) || null,
        null // Hyperliquid funds continuously each hour
      )
    );
  }
  return out;
}

export const FETCHERS: Record<ExchangeId, () => Promise<FundingPoint[]>> = {
  binance: fetchBinance,
  bybit: fetchBybit,
  okx: fetchOkx,
  hyperliquid: fetchHyperliquid,
};
