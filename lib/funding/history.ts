import type { ExchangeId } from "./types";

/** One historical funding settlement: a per-interval rate at a point in time. */
export interface FundingHistoryPoint {
  time: number; // ms epoch of the settlement
  rate: number; // funding rate for that interval, as a fraction
}

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
    signal: AbortSignal.timeout(12_000),
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function binanceHistory(
  coin: string,
  since: number
): Promise<FundingHistoryPoint[]> {
  const data = (await getJson(
    `${BASE.binance}/fapi/v1/fundingRate?symbol=${coin}USDT&startTime=${since}&limit=1000`
  )) as Array<{ fundingTime: number; fundingRate: string }>;
  return data.map((d) => ({ time: d.fundingTime, rate: Number(d.fundingRate) }));
}

async function bybitHistory(
  coin: string,
  since: number
): Promise<FundingHistoryPoint[]> {
  const data = (await getJson(
    `${BASE.bybit}/v5/market/funding/history?category=linear&symbol=${coin}USDT&startTime=${since}&limit=200`
  )) as {
    result?: {
      list?: Array<{ fundingRateTimestamp: string; fundingRate: string }>;
    };
  };
  return (data.result?.list ?? []).map((d) => ({
    time: Number(d.fundingRateTimestamp),
    rate: Number(d.fundingRate),
  }));
}

async function okxHistory(
  coin: string,
  since: number
): Promise<FundingHistoryPoint[]> {
  const out: FundingHistoryPoint[] = [];
  let before = ""; // OKX paginates backwards via the `after` cursor (older than ts)
  // Pull up to ~5 pages (100 each) to cover a month of 8h settlements.
  for (let page = 0; page < 5; page++) {
    const url =
      `${BASE.okx}/api/v5/public/funding-rate-history?instId=${coin}-USDT-SWAP&limit=100` +
      (before ? `&after=${before}` : "");
    const data = (await getJson(url)) as {
      data?: Array<{ fundingTime: string; realizedRate: string; fundingRate: string }>;
    };
    const rows = data.data ?? [];
    if (rows.length === 0) break;
    for (const d of rows) {
      const time = Number(d.fundingTime);
      out.push({ time, rate: Number(d.realizedRate || d.fundingRate) });
    }
    before = rows[rows.length - 1].fundingTime;
    if (Number(before) < since) break;
  }
  return out.filter((p) => p.time >= since);
}

async function hyperliquidHistory(
  coin: string,
  since: number
): Promise<FundingHistoryPoint[]> {
  const data = (await getJson(`${BASE.hyperliquid}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "fundingHistory", coin, startTime: since }),
  })) as Array<{ time: number; fundingRate: string }>;
  return data.map((d) => ({ time: d.time, rate: Number(d.fundingRate) }));
}

const HISTORY: Record<
  ExchangeId,
  (coin: string, since: number) => Promise<FundingHistoryPoint[]>
> = {
  binance: binanceHistory,
  bybit: bybitHistory,
  okx: okxHistory,
  hyperliquid: hyperliquidHistory,
};

export function fetchFundingHistory(
  exchange: ExchangeId,
  coin: string,
  since: number
): Promise<FundingHistoryPoint[]> {
  return HISTORY[exchange](coin, since);
}
