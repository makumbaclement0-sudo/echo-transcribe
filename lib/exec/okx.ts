import crypto from "node:crypto";
import type { Executor, OrderRequest, OrderResult } from "./types";

// OKX **demo/simulated** trading only (header x-simulated-trading: 1).
// Credentials are OKX *demo* API keys. Read per-call.
const base = () => process.env.OKX_BASE || "https://www.okx.com";
const key = () => process.env.OKX_DEMO_KEY || "";
const secret = () => process.env.OKX_DEMO_SECRET || "";
const passphrase = () => process.env.OKX_DEMO_PASSPHRASE || "";

const instId = (coin: string) => `${coin.toUpperCase()}-USDT-SWAP`;

function floorToStep(qty: number, step: number): number {
  if (step <= 0) return qty;
  const decimals = (String(step).split(".")[1] || "").length;
  return Number((Math.floor(qty / step) * step).toFixed(decimals));
}

async function publicGet(path: string): Promise<unknown> {
  const res = await fetch(`${base()}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
    headers: { "x-simulated-trading": "1" },
  });
  if (!res.ok) throw new Error(`okx ${path}: HTTP ${res.status}`);
  return res.json();
}

// OKX signature: base64(HMAC_SHA256(secret, timestamp + method + requestPath + body))
async function signedRequest(
  method: "GET" | "POST",
  requestPath: string,
  bodyObj?: unknown
): Promise<unknown> {
  const ts = new Date().toISOString();
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const sign = crypto
    .createHmac("sha256", secret())
    .update(ts + method + requestPath + body)
    .digest("base64");

  const res = await fetch(`${base()}${requestPath}`, {
    method,
    headers: {
      "OK-ACCESS-KEY": key(),
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": passphrase(),
      "x-simulated-trading": "1",
      "content-type": "application/json",
    },
    body: method === "POST" ? body : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  const json = (await res.json()) as { code?: string; msg?: string; data?: unknown };
  if (!res.ok || (json.code !== undefined && json.code !== "0")) {
    throw new Error(`okx ${requestPath}: ${JSON.stringify(json)}`);
  }
  return json;
}

// Contract specs: 1 contract = ctVal coins; order size is in contracts.
let specCache: Map<string, { ctVal: number; lotSz: number }> | null = null;
async function contractSpec(id: string): Promise<{ ctVal: number; lotSz: number }> {
  if (!specCache) {
    specCache = new Map();
    const info = (await publicGet(
      "/api/v5/public/instruments?instType=SWAP"
    )) as { data?: Array<{ instId: string; ctVal: string; lotSz: string }> };
    for (const d of info.data ?? [])
      specCache.set(d.instId, { ctVal: Number(d.ctVal), lotSz: Number(d.lotSz) });
  }
  return specCache.get(id) ?? { ctVal: 0, lotSz: 1 };
}

export const okx: Executor = {
  venue: "okx",
  configured: () => Boolean(key() && secret() && passphrase()),

  async markPrice(coin) {
    const d = (await publicGet(
      `/api/v5/public/mark-price?instId=${instId(coin)}`
    )) as { data?: Array<{ markPx: string }> };
    const px = d.data?.[0]?.markPx;
    if (!px) throw new Error(`okx ${coin}: no mark price`);
    return Number(px);
  },

  async setLeverage(coin, leverage) {
    await signedRequest("POST", "/api/v5/account/set-leverage", {
      instId: instId(coin),
      lever: String(Math.round(leverage)),
      mgnMode: "cross",
    });
  },

  async placeMarket(req: OrderRequest): Promise<OrderResult> {
    const id = instId(req.coin);
    const mark = await this.markPrice(req.coin);
    const spec = await contractSpec(id);
    if (spec.ctVal <= 0) throw new Error(`okx ${id}: unknown contract value`);
    const contracts = floorToStep(req.usd / mark / spec.ctVal, spec.lotSz);
    if (contracts <= 0)
      throw new Error(`okx ${id}: size ${req.usd} USD rounds to 0 contracts`);

    const order: Record<string, string> = {
      instId: id,
      tdMode: "cross",
      side: req.side === "long" ? "buy" : "sell",
      ordType: "market",
      sz: String(contracts),
    };
    if (req.reduceOnly) order.reduceOnly = "true";

    const r = (await signedRequest("POST", "/api/v5/trade/order", order)) as {
      data?: Array<{ ordId?: string }>;
    };
    const filledCoins = contracts * spec.ctVal;
    return {
      venue: "okx",
      coin: req.coin,
      side: req.side,
      orderId: r.data?.[0]?.ordId ?? "",
      filledQty: filledCoins,
      avgPrice: mark,
      status: "filled",
      raw: r,
    };
  },
};
