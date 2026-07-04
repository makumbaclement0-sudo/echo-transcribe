import ccxt, { Exchange } from "ccxt";
import { loadCredentials } from "./config";
import { ExchangeId, EXCHANGE_IDS, MarketType } from "./types";

// One ccxt instance per (exchange, market type). Binance splits USDT-margined
// perps into a separate class (binanceusdm); Bybit/OKX are unified and switch
// on options.defaultType. Public endpoints (funding rates, tickers, books)
// need no API keys — credentials are only required for live trading.

const CLASSES: Record<ExchangeId, Record<MarketType, new (config: object) => Exchange>> = {
  binance: { swap: ccxt.binanceusdm, spot: ccxt.binance },
  bybit: { swap: ccxt.bybit, spot: ccxt.bybit },
  okx: { swap: ccxt.okx, spot: ccxt.okx },
};

export interface ExchangePair {
  id: ExchangeId;
  swap: Exchange;
  spot: Exchange;
  ok: boolean; // false after a failed loadMarkets (geo-block, outage, ...)
  lastError?: string;
}

function build(id: ExchangeId, type: MarketType): Exchange {
  const creds = loadCredentials(id);
  return new CLASSES[id][type]({
    apiKey: creds.apiKey,
    secret: creds.secret,
    password: creds.password,
    enableRateLimit: true,
    options: { defaultType: type },
  });
}

export function createExchanges(only?: ExchangeId[]): ExchangePair[] {
  const ids = only && only.length > 0 ? only : EXCHANGE_IDS;
  return ids.map((id) => ({
    id,
    swap: build(id, "swap"),
    spot: build(id, "spot"),
    ok: false,
  }));
}

export async function loadAllMarkets(pairs: ExchangePair[]): Promise<void> {
  await Promise.all(
    pairs.map(async (p) => {
      try {
        await Promise.all([p.swap.loadMarkets(), p.spot.loadMarkets()]);
        p.ok = true;
        p.lastError = undefined;
      } catch (e) {
        // Exchange unreachable (often geo-restriction). Scanner skips it.
        p.ok = false;
        p.lastError = e instanceof Error ? e.message : String(e);
      }
    })
  );
}

/** USDT-linear perpetual markets, keyed by unified symbol (BTC/USDT:USDT). */
export function linearSwapMarkets(p: ExchangePair) {
  return Object.values(p.swap.markets ?? {}).filter(
    (m) => m && m.swap && m.linear && m.active !== false && m.quote === "USDT" && !m.expiry
  );
}

/** Matching spot symbol for a swap market's base, if listed (BTC/USDT). */
export function spotSymbolFor(p: ExchangePair, base: string): string | null {
  const symbol = `${base}/USDT`;
  const m = p.spot.markets?.[symbol];
  return m && m.spot && m.active !== false ? symbol : null;
}

export function takerFee(ex: Exchange, symbol: string, fallback: number): number {
  const t = ex.markets?.[symbol]?.taker;
  return typeof t === "number" && Number.isFinite(t) ? t : fallback;
}
