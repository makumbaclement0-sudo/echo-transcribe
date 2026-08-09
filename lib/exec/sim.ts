import type { Executor, OrderResult, Venue } from "./types";

/**
 * Wrap a real venue executor into a SIMULATED one: it reuses the venue's real
 * public mark price so fills are realistic, but never signs or sends an order —
 * fills are synthesized instantly at mark ± a small taker slippage. No API keys,
 * no wallet, nothing at risk. Used for the demo/simulation mode.
 */
export function toSim(real: Executor): Executor {
  const SLIP = 0.0002; // 0.02% taker slippage, applied against you
  return {
    venue: real.venue,
    configured: () => true, // no credentials needed to simulate
    markPrice: (coin) => real.markPrice(coin),
    setLeverage: async () => {}, // nothing to set in simulation
    async placeMarket(req): Promise<OrderResult> {
      const mark = await real.markPrice(req.coin);
      const fill = req.side === "long" ? mark * (1 + SLIP) : mark * (1 - SLIP);
      return {
        venue: real.venue,
        coin: req.coin,
        side: req.side,
        orderId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filledQty: req.usd / mark,
        avgPrice: fill,
        status: "filled",
        raw: { simulated: true },
      };
    },
  };
}

export function simExecutors(
  real: Partial<Record<Venue, Executor>>
): Partial<Record<Venue, Executor>> {
  const out: Partial<Record<Venue, Executor>> = {};
  for (const [venue, ex] of Object.entries(real))
    if (ex) out[venue as Venue] = toSim(ex);
  return out;
}
