/** Hard limits enforced before any order is placed. Read from env per-call so
 *  a change in .env.local takes effect on restart without a rebuild. */
export interface RiskConfig {
  enabled: boolean;
  maxUsdPerLeg: number;
  minNetApr: number;
  maxLeverage: number;
}

export function riskConfig(): RiskConfig {
  return {
    // Master switch. Nothing is sent unless this is exactly "true".
    enabled: process.env.EXEC_ENABLED === "true",
    maxUsdPerLeg: Number(process.env.EXEC_MAX_USD ?? 100),
    minNetApr: Number(process.env.EXEC_MIN_NET_APR ?? 0.03),
    maxLeverage: Number(process.env.EXEC_MAX_LEVERAGE ?? 3),
  };
}

export interface RiskInput {
  usd: number;
  leverage: number;
  netApr: number;
}

export interface RiskVerdict {
  ok: boolean;
  reason?: string;
  /** Values clamped to the limits (use these, not the raw request). */
  usd: number;
  leverage: number;
}

/**
 * Gate a proposed trade. Returns ok:false with a reason when the trade must be
 * blocked outright (kill switch handled separately), otherwise clamps size and
 * leverage down to the configured caps.
 */
export function checkRisk(
  input: RiskInput,
  opts: { skipNetApr?: boolean } = {}
): RiskVerdict {
  const cfg = riskConfig();
  const usd = Math.min(Math.max(input.usd, 0), cfg.maxUsdPerLeg);
  const leverage = Math.min(Math.max(input.leverage, 1), cfg.maxLeverage);

  if (!Number.isFinite(input.usd) || input.usd <= 0)
    return { ok: false, reason: "usd must be > 0", usd, leverage };
  if (!opts.skipNetApr && input.netApr < cfg.minNetApr)
    return {
      ok: false,
      reason: `net APR ${(input.netApr * 100).toFixed(2)}% below floor ${(
        cfg.minNetApr * 100
      ).toFixed(2)}%`,
      usd,
      leverage,
    };
  return { ok: true, usd, leverage };
}
