import crypto from "node:crypto";
import type { Executor, OrderRequest, OrderResult } from "./types";

// Bybit v5 **testnet** only. Credentials read per-call.
const base = () =>
  process.env.BYBIT_TESTNET_BASE || "https://api-testnet.bybit.com";
const key = () => process.env.BYBIT_TESTNET_KEY || "";
const secret = () => process.env.BYBIT_TESTNET_SECRET || "";
const RECV = "5000";

const symbol = (coin: string) => `${coin.toUpperCase()}USDT`;

function floorToStep(qty: number, step: number): number {
  if (step <= 0) return qty;
  const decimals = (String(step).split(".")[1] || "").length;
  return Number((Math.floor(qty / step) * step).toFixed(decimals));
}

async function publicGet(path: string): Promise<unknown> {
  const res = await fetch(`${base()}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`bybit ${path}: HTTP ${res.status}`);
  return res.json();
}

// v5 signature: HMAC_SHA256(secret, timestamp + apiKey + recvWindow + payload)
async function signedRequest(
  method: "GET" | "POST",
  path: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  const ts = String(Date.now());
  const body = method === "POST" ? JSON.stringify(payload) : "";
  const query =
    method === "GET"
      ? new URLSearchParams(
          Object.fromEntries(
            Object.entries(payload).map(([k, v]) => [k, String(v)])
          )
        ).toString()
      : "";
  const signPayload = method === "GET" ? query : body;
  const sign = crypto
    .createHmac("sha256", secret())
    .update(ts + key() + RECV + signPayload)
    .digest("hex");

  const url = `${base()}${path}${query ? `?${query}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-BAPI-API-KEY": key(),
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": RECV,
      "X-BAPI-SIGN": sign,
      "content-type": "application/json",
    },
    body: method === "POST" ? body : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  const json = (await res.json()) as { retCode?: number; retMsg?: string };
  if (!res.ok || (json.retCode !== undefined && json.retCode !== 0)) {
    throw new Error(`bybit ${path}: ${JSON.stringify(json)}`);
  }
  return json;
}

let stepCache: Map<string, number> | null = null;
async function qtyStep(sym: string): Promise<number> {
  if (!stepCache) {
    stepCache = new Map();
    const info = (await publicGet(
      "/v5/market/instruments-info?category=linear"
    )) as {
      result?: {
        list?: Array<{ symbol: string; lotSizeFilter?: { qtyStep?: string } }>;
      };
    };
    for (const s of info.result?.list ?? []) {
      if (s.lotSizeFilter?.qtyStep)
        stepCache.set(s.symbol, Number(s.lotSizeFilter.qtyStep));
    }
  }
  return stepCache.get(sym) ?? 0.001;
}

export const bybit: Executor = {
  venue: "bybit",
  configured: () => Boolean(key() && secret()),

  async markPrice(coin) {
    const d = (await publicGet(
      `/v5/market/tickers?category=linear&symbol=${symbol(coin)}`
    )) as { result?: { list?: Array<{ markPrice: string }> } };
    const mp = d.result?.list?.[0]?.markPrice;
    if (!mp) throw new Error(`bybit ${coin}: no mark price`);
    return Number(mp);
  },

  async setLeverage(coin, leverage) {
    const lev = String(Math.round(leverage));
    try {
      await signedRequest("POST", "/v5/position/set-leverage", {
        category: "linear",
        symbol: symbol(coin),
        buyLeverage: lev,
        sellLeverage: lev,
      });
    } catch (e) {
      // Bybit returns an error if leverage is already set to this value; ignore.
      if (!String(e).includes("110043")) throw e;
    }
  },

  async placeMarket(req: OrderRequest): Promise<OrderResult> {
    const sym = symbol(req.coin);
    const mark = await this.markPrice(req.coin);
    const step = await qtyStep(sym);
    const qty = floorToStep(req.usd / mark, step);
    if (qty <= 0) throw new Error(`bybit ${sym}: size ${req.usd} USD rounds to 0`);

    const payload: Record<string, unknown> = {
      category: "linear",
      symbol: sym,
      side: req.side === "long" ? "Buy" : "Sell",
      orderType: "Market",
      qty: String(qty),
    };
    if (req.reduceOnly) payload.reduceOnly = true;

    const r = (await signedRequest("POST", "/v5/order/create", payload)) as {
      result?: { orderId?: string };
    };
    return {
      venue: "bybit",
      coin: req.coin,
      side: req.side,
      orderId: r.result?.orderId ?? "",
      filledQty: qty, // market orders on the linear perp fill immediately
      avgPrice: mark,
      status: "filled",
      raw: r,
    };
  },
};
