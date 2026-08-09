import crypto from "node:crypto";
import type { Executor, OrderRequest, OrderResult } from "./types";

// Binance USDⓈ-M **testnet** only. There is deliberately no mainnet base here.
// Credentials read per-call so .env.local is honored without a rebuild.
const base = () =>
  process.env.BINANCE_TESTNET_BASE || "https://testnet.binancefuture.com";
const key = () => process.env.BINANCE_TESTNET_KEY || "";
const secret = () => process.env.BINANCE_TESTNET_SECRET || "";

const symbol = (coin: string) => `${coin.toUpperCase()}USDT`;

function floorToStep(qty: number, step: number): number {
  if (step <= 0) return qty;
  return Math.floor(qty / step) * step;
}

async function publicGet(path: string): Promise<unknown> {
  const res = await fetch(`${base()}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`binance ${path}: HTTP ${res.status}`);
  return res.json();
}

async function signedRequest(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number>
): Promise<unknown> {
  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    timestamp: String(Date.now()),
    recvWindow: "5000",
  }).toString();
  const signature = crypto.createHmac("sha256", secret()).update(qs).digest("hex");
  const url = `${base()}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": key() },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`binance ${path}: ${JSON.stringify(body)}`);
  }
  return body;
}

let stepCache: Map<string, number> | null = null;
async function stepSize(sym: string): Promise<number> {
  if (!stepCache) {
    stepCache = new Map();
    const info = (await publicGet("/fapi/v1/exchangeInfo")) as {
      symbols: Array<{
        symbol: string;
        filters: Array<{ filterType: string; stepSize?: string }>;
      }>;
    };
    for (const s of info.symbols) {
      const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
      if (lot?.stepSize) stepCache.set(s.symbol, Number(lot.stepSize));
    }
  }
  return stepCache.get(sym) ?? 0.001;
}

export const binance: Executor = {
  venue: "binance",
  configured: () => Boolean(key() && secret()),

  async markPrice(coin) {
    const d = (await publicGet(`/fapi/v1/premiumIndex?symbol=${symbol(coin)}`)) as {
      markPrice: string;
    };
    return Number(d.markPrice);
  },

  async setLeverage(coin, leverage) {
    await signedRequest("POST", "/fapi/v1/leverage", {
      symbol: symbol(coin),
      leverage: Math.round(leverage),
    });
  },

  async placeMarket(req: OrderRequest): Promise<OrderResult> {
    const sym = symbol(req.coin);
    const mark = await this.markPrice(req.coin);
    const step = await stepSize(sym);
    const qty = floorToStep(req.usd / mark, step);
    if (qty <= 0) throw new Error(`binance ${sym}: size ${req.usd} USD rounds to 0`);

    const params: Record<string, string | number> = {
      symbol: sym,
      side: req.side === "long" ? "BUY" : "SELL",
      type: "MARKET",
      quantity: qty,
    };
    if (req.reduceOnly) params.reduceOnly = "true";

    const r = (await signedRequest("POST", "/fapi/v1/order", params)) as {
      orderId: number;
      status: string;
      executedQty: string;
      avgPrice: string;
    };
    const filled = Number(r.executedQty);
    return {
      venue: "binance",
      coin: req.coin,
      side: req.side,
      orderId: String(r.orderId),
      filledQty: filled,
      avgPrice: Number(r.avgPrice) || mark,
      status: filled > 0 ? "filled" : r.status === "NEW" ? "new" : "rejected",
      raw: r,
    };
  },
};
