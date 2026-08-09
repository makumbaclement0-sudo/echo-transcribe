import { encode as msgpackEncode } from "@msgpack/msgpack";
import {
  addressFromPrivateKey,
  bytesToHex,
  eip712Digest,
  keccak256,
  signDigest,
  type Domain,
  type Types,
} from "./eip712";
import type { Executor, OrderRequest, OrderResult } from "./types";

// Hyperliquid **testnet** only. Signed with an Ethereum wallet private key.
const base = () =>
  process.env.HYPERLIQUID_TESTNET_BASE || "https://api.hyperliquid-testnet.xyz";
const privKey = () => {
  const k = process.env.HYPERLIQUID_TESTNET_PRIVKEY || "";
  return k && !k.startsWith("0x") ? `0x${k}` : k;
};
const IS_MAINNET = false; // this module is testnet-only

const AGENT_DOMAIN: Domain = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};
const AGENT_TYPES: Types = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

/** keccak256( msgpack(action) ‖ nonce(8B big-endian) ‖ 0x00 ) — no vault. */
function actionHash(action: unknown, nonce: number): Uint8Array {
  const packed = new Uint8Array(msgpackEncode(action));
  const buf = new Uint8Array(packed.length + 9);
  buf.set(packed, 0);
  const view = new DataView(buf.buffer);
  view.setBigUint64(packed.length, BigInt(nonce), false); // big-endian nonce
  buf[packed.length + 8] = 0x00; // vault flag: none
  return keccak256(buf);
}

/** Sign an L1 action the way Hyperliquid expects (phantom Agent, EIP-712). */
function signAction(action: unknown, nonce: number) {
  const connectionId = bytesToHex(actionHash(action, nonce));
  const digest = eip712Digest(AGENT_DOMAIN, "Agent", AGENT_TYPES, {
    source: IS_MAINNET ? "a" : "b",
    connectionId,
  });
  return signDigest(digest, privKey());
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`hyperliquid ${path}: ${JSON.stringify(json)}`);
  return json;
}

// Asset index + size decimals come from the perp meta (cached).
let metaCache: Map<string, { index: number; szDecimals: number }> | null = null;
async function assetMeta(coin: string) {
  if (!metaCache) {
    metaCache = new Map();
    const meta = (await post("/info", { type: "meta" })) as {
      universe: Array<{ name: string; szDecimals: number }>;
    };
    meta.universe.forEach((u, i) =>
      metaCache!.set(u.name, { index: i, szDecimals: u.szDecimals })
    );
  }
  const m = metaCache.get(coin.toUpperCase());
  if (!m) throw new Error(`hyperliquid: unknown coin ${coin}`);
  return m;
}

async function midPrice(coin: string): Promise<number> {
  const mids = (await post("/info", { type: "allMids" })) as Record<string, string>;
  const px = mids[coin.toUpperCase()];
  if (!px) throw new Error(`hyperliquid ${coin}: no mid price`);
  return Number(px);
}

/** Perp price: ≤5 significant figures and ≤(6 − szDecimals) decimals. */
function formatPrice(px: number, szDecimals: number): string {
  const maxDec = Math.max(0, 6 - szDecimals);
  const sig = Number(px.toPrecision(5));
  return String(Number(sig.toFixed(maxDec)));
}

function formatSize(sz: number, szDecimals: number): string {
  return String(Number(sz.toFixed(szDecimals)));
}

export const hyperliquid: Executor = {
  venue: "hyperliquid",
  configured: () => Boolean(privKey()),

  async markPrice(coin) {
    return midPrice(coin);
  },

  // Hyperliquid sets leverage via a separate action; on testnet the default is
  // usually fine, so this is best-effort and won't block a trade if it errors.
  async setLeverage(coin, leverage) {
    try {
      const { index } = await assetMeta(coin);
      const nonce = Date.now();
      const action = {
        type: "updateLeverage",
        asset: index,
        isCross: true,
        leverage: Math.round(leverage),
      };
      await post("/exchange", {
        action,
        nonce,
        signature: signAction(action, nonce),
        vaultAddress: null,
      });
    } catch {
      // non-fatal — proceed at whatever leverage the account already has
    }
  },

  async placeMarket(req: OrderRequest): Promise<OrderResult> {
    const { index, szDecimals } = await assetMeta(req.coin);
    const mid = await midPrice(req.coin);
    const isBuy = req.side === "long";
    // Aggressive IOC limit so it fills like a market order (5% cross).
    const limitPx = isBuy ? mid * 1.05 : mid * 0.95;
    const size = req.usd / mid;

    const action = {
      type: "order",
      orders: [
        {
          a: index,
          b: isBuy,
          p: formatPrice(limitPx, szDecimals),
          s: formatSize(size, szDecimals),
          r: Boolean(req.reduceOnly),
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
    };
    const nonce = Date.now();
    const r = await post("/exchange", {
      action,
      nonce,
      signature: signAction(action, nonce),
      vaultAddress: null,
    });

    return {
      venue: "hyperliquid",
      coin: req.coin,
      side: req.side,
      orderId: JSON.stringify(r).slice(0, 120),
      filledQty: Number(formatSize(size, szDecimals)),
      avgPrice: mid,
      status: "filled",
      raw: r,
    };
  },
};

/** Exposed for the status page: which wallet address will sign. */
export function hyperliquidAddress(): string | null {
  const k = privKey();
  return k ? addressFromPrivateKey(k) : null;
}
