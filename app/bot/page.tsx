"use client";

// DELTA/8 landing — built from the user's Funding_Arbitrage_Landing design.
// The ticker strip shows the engine's real funding data when it's running
// and falls back to the design's jittering demo numbers when it isn't.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface TickerRate {
  base: string;
  rate: number;
  exchange: string;
}

interface Ticker {
  rates: TickerRate[];
  bestId: string | null;
  bestNetApr: number | null;
  paper: boolean;
  updatedAt: string;
}

const DEMO_RATES: TickerRate[] = [
  { base: "BTC", rate: 0.0012, exchange: "demo" },
  { base: "ETH", rate: -0.0006, exchange: "demo" },
  { base: "SOL", rate: 0.0028, exchange: "demo" },
];

function fmtRate(v: number): string {
  const pct = (v * 100).toFixed(3);
  return (v >= 0 ? "+" : "") + pct + "%";
}

function rateColor(v: number): string {
  return v >= 0 ? "#b6ff3c" : "#ff6a4d";
}

/** Scroll-reveal: adds .d8-visible when the section enters the viewport. */
function useReveal() {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("d8-visible");
            obs.unobserve(e.target);
          }
        }
      },
      { threshold: 0, rootMargin: "0px 0px -15% 0px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return ref;
}

const HERO_WORDS = "The spread is real. So is the risk.".split(" ");

const STEPS = [
  {
    num: "01",
    title: "Long spot, short perp",
    body: "Hold the underlying asset outright while shorting the perpetual future on the same asset, same size, same venue pairing.",
  },
  {
    num: "02",
    title: "Collect the funding delta",
    body: "Perpetual funding rates diverge across venues. Every 8 hours you collect the difference between what you pay and what you receive.",
  },
  {
    num: "03",
    title: "Close before it flips",
    body: "Unwind both legs once the spread compresses or funding turns against you. The edge is temporary by design.",
  },
];

const RISKS = [
  {
    tag: "SLIPPAGE ON FILLS",
    desc: "Your two legs rarely execute at the exact prices you modeled. Thin books widen the gap fast.",
  },
  {
    tag: "FUNDING CAN FLIP",
    desc: "The rate you’re collecting today can invert before your next settlement window.",
  },
  {
    tag: "ONE LEG CAN FAIL",
    desc: "An outage, a margin call, or a halted market can leave you holding a single, directional position.",
  },
];

const MILESTONES = [
  {
    n: "01",
    title: "Paper-trade",
    body: "Run the strategy with simulated fills against live rates. No capital at risk.",
  },
  {
    n: "02",
    title: "Prove the numbers",
    body: "Let it run long enough to see slippage, flips, and failures show up in the data.",
  },
  {
    n: "03",
    title: "Start small",
    body: "Move real size only once the paper results hold up under stress.",
  },
  {
    n: "04",
    title: "Scale with discipline",
    body: "Increase size in steps, tied to realized performance, not conviction.",
  },
];

export default function Delta8Landing() {
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [demo, setDemo] = useState<TickerRate[]>(DEMO_RATES);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/bot/ticker", { cache: "no-store" });
      const data = await res.json();
      setTicker(data.ticker ?? null);
    } catch {
      setTicker(null);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [poll]);

  // Demo jitter (design behavior) while the engine is offline.
  useEffect(() => {
    if (ticker) return;
    const t = setInterval(() => {
      setDemo((rates) =>
        rates.map((r) => ({
          ...r,
          rate: Math.max(-0.005, Math.min(0.005, r.rate + (Math.random() - 0.5) * 0.0004)),
        }))
      );
    }, 2200);
    return () => clearInterval(t);
  }, [ticker]);

  const live = ticker && ticker.rates.length > 0;
  const rates = live ? ticker.rates : demo;
  const basis =
    rates.length >= 2 ? rates[0].rate - rates[1].rate : rates[0]?.rate ?? 0;

  const howRef = useReveal();
  const riskRef = useReveal();
  const pathRef = useReveal();
  const ctaRef = useReveal();

  return (
    <main className="relative flex-1 overflow-x-clip">
      {/* ticker-tape strip */}
      <div className="fixed inset-x-0 top-0 z-50 flex h-[34px] items-center overflow-hidden border-b border-[rgba(238,241,238,0.08)] bg-[#06080a]">
        <div className="flex gap-9 whitespace-nowrap pl-6 text-[11px] tracking-[0.06em] text-[#6f7a73]">
          {rates.map((r) => (
            <span key={r.base}>
              {r.base}-PERP FUNDING{" "}
              <span style={{ color: rateColor(r.rate) }}>{fmtRate(r.rate)}</span>
            </span>
          ))}
          <span className="text-[#3a423d]">
            {ticker && !ticker.paper ? "/// LIVE CAPITAL AT RISK ///" : "/// PAPER MODE ACTIVE ///"}
          </span>
          <span>
            {live && ticker.bestNetApr !== null ? "BEST SPREAD " : "BASIS SPREAD "}
            <span className="text-[#b6ff3c]">
              {live && ticker.bestNetApr !== null
                ? `${(ticker.bestNetApr * 100).toFixed(2)}% APR`
                : fmtRate(basis)}
            </span>
          </span>
          {!live && <span className="text-[#3a423d]">ENGINE OFFLINE — DEMO FEED</span>}
        </div>
      </div>

      {/* nav */}
      <div className="fixed inset-x-0 top-[34px] z-40 flex items-center justify-between bg-gradient-to-b from-[rgba(6,8,10,0.9)] to-transparent px-[clamp(20px,5vw,64px)] py-5">
        <div className="d8-display flex items-center gap-2 text-lg font-bold">
          <span className="d8-pulse inline-block h-[9px] w-[9px] rounded-[2px] bg-[#b6ff3c]" />
          DELTA/8
        </div>
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="text-xs tracking-[0.04em] text-[#9aa39d] no-underline hover:text-[#eef1ee]"
          >
            ECHO
          </Link>
          <Link href="/bot/dashboard" className="d8-btn px-[18px] py-2.5 text-xs tracking-[0.04em]">
            Start paper trading
          </Link>
        </div>
      </div>

      {/* HERO */}
      <section className="relative flex min-h-screen flex-col justify-center overflow-hidden px-[clamp(20px,5vw,64px)] pb-20 pt-[120px]">
        <div className="absolute inset-0 z-0 opacity-60">
          <div className="d8-glow d8-glow-lime" />
          <div className="d8-glow d8-glow-blue" />
          <div className="d8-glow d8-glow-coral" />
        </div>
        <div className="d8-grid z-0" />

        <div className="relative z-10 max-w-[980px]">
          <div className="d8-label mb-[22px] flex items-center gap-2.5">
            <span className="inline-block h-px w-4 bg-[#b6ff3c]" />
            FUNDING-RATE ARBITRAGE
          </div>
          <h1 className="d8-display mb-7 text-[clamp(42px,7vw,92px)] leading-[0.98] tracking-[-0.03em]">
            {HERO_WORDS.map((w, i) => (
              <span key={i} className="d8-rise" style={{ animationDelay: `${i * 100}ms` }}>
                {w}&nbsp;
              </span>
            ))}
          </h1>
          <p
            className="mb-10 max-w-[620px] text-[clamp(16px,2vw,20px)] leading-[1.55] text-[#b7bfb9]"
            style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}
          >
            Go long spot, short the perpetual, collect the funding delta between venues.
            Market-neutral on paper — until slippage, a flip, or a failed leg says otherwise.
          </p>
          <div className="flex flex-wrap items-center gap-[18px]">
            <Link href="/bot/dashboard" className="d8-btn px-7 py-[15px] text-[15px]">
              Start paper trading
            </Link>
            <a
              href="#how"
              className="border-b border-[rgba(238,241,238,0.3)] pb-1 text-sm tracking-[0.03em] text-[#eef1ee] no-underline"
            >
              See how it works ↓
            </a>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section
        id="how"
        ref={howRef as React.RefObject<HTMLElement>}
        className="d8-reveal mx-auto max-w-[1180px] px-[clamp(20px,5vw,64px)] py-[140px]"
      >
        <div className="d8-label mb-[18px]">MECHANISM</div>
        <h2 className="d8-display mb-16 max-w-[640px] text-[clamp(30px,4vw,48px)]">
          Three moves. Same asset, two venues.
        </h2>
        <div className="grid grid-cols-1 gap-px border border-[rgba(238,241,238,0.1)] bg-[rgba(238,241,238,0.1)] md:grid-cols-3">
          {STEPS.map((step, i) => (
            <div key={step.num} className="relative bg-[#06080a] px-8 py-9">
              <div className="d8-display mb-5 text-[13px] font-normal text-[#5c6b62]">
                {step.num}
              </div>
              <h3 className="d8-display mb-3.5 text-xl">{step.title}</h3>
              <p className="mb-6 text-[13.5px] leading-[1.65] text-[#9aa39d]">{step.body}</p>
              <div className="h-0.5 overflow-hidden rounded-[1px] bg-[rgba(238,241,238,0.08)]">
                <div
                  className="h-full w-full origin-left scale-x-0 bg-[#b6ff3c] transition-transform duration-[1100ms] ease-[cubic-bezier(.2,.8,.2,1)] [.d8-visible_&]:scale-x-100"
                  style={{ transitionDelay: `${i * 100}ms` }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* RISK */}
      <section
        id="risk"
        ref={riskRef as React.RefObject<HTMLElement>}
        className="d8-reveal relative overflow-hidden bg-[#0d0908] px-[clamp(20px,5vw,64px)] py-[150px]"
      >
        <div className="d8-stripes absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-[1180px]">
          <div className="d8-label mb-[18px] !text-[#ff6a4d]">READ THIS TWICE</div>
          <h2 className="d8-display mb-7 max-w-[640px] text-[clamp(30px,4vw,48px)]">
            This is not risk-free.
          </h2>
          <p className="mb-16 max-w-[660px] text-[17px] leading-[1.7] text-[#d8bdb3]">
            Funding-rate arbitrage is not risk-free: fills can slip, funding can flip, and one
            leg can fail. Paper-trade until the numbers convince you, then start small.
          </p>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {RISKS.map((r) => (
              <div
                key={r.tag}
                className="border border-[rgba(255,106,77,0.25)] bg-[rgba(255,106,77,0.04)] px-[26px] py-7"
              >
                <div className="d8-display mb-3.5 text-xs tracking-[0.06em] text-[#ff6a4d]">
                  {r.tag}
                </div>
                <p className="m-0 text-sm leading-[1.6] text-[#e8d5cf]">{r.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PATH */}
      <section
        id="path"
        ref={pathRef as React.RefObject<HTMLElement>}
        className="d8-reveal mx-auto max-w-[1180px] px-[clamp(20px,5vw,64px)] py-[150px]"
      >
        <div className="d8-label mb-[18px]">HOW TO ACTUALLY START</div>
        <h2 className="d8-display mb-20 max-w-[640px] text-[clamp(30px,4vw,48px)]">
          Prove it on paper before it&apos;s real.
        </h2>
        <div className="relative pt-1.5">
          <div className="absolute left-0 right-0 top-1.5 h-px bg-[rgba(238,241,238,0.12)]" />
          <div className="absolute left-0 top-1.5 h-px w-full origin-left scale-x-0 bg-[#b6ff3c] transition-transform delay-200 duration-[1600ms] ease-[cubic-bezier(.2,.8,.2,1)] [.d8-visible_&]:scale-x-100" />
          <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
            {MILESTONES.map((m, i) => (
              <div key={m.n} className="relative pt-[26px]">
                <div
                  className={`absolute -top-[3px] left-0 h-2 w-2 rounded-full ${
                    i === 0 ? "bg-[#b6ff3c]" : "bg-[#3a423d]"
                  }`}
                />
                <div className="d8-display mb-2.5 text-xs font-normal text-[#5c6b62]">{m.n}</div>
                <h4 className="d8-display mb-2 text-base">{m.title}</h4>
                <p className="m-0 text-[13px] leading-[1.6] text-[#9aa39d]">{m.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section
        id="cta"
        ref={ctaRef as React.RefObject<HTMLElement>}
        className="d8-reveal relative px-[clamp(20px,5vw,64px)] pb-[100px] pt-[160px] text-center"
      >
        <div
          className="pointer-events-none absolute left-1/2 top-[20%] h-[520px] w-[520px] -translate-x-1/2"
          style={{ background: "radial-gradient(circle, rgba(182,255,60,0.10), transparent 70%)" }}
        />
        <div className="relative">
          <h2 className="d8-display mb-8 text-[clamp(32px,5vw,58px)]">
            Start where the risk is zero.
          </h2>
          <Link href="/bot/dashboard" className="d8-btn inline-block px-[34px] py-4 text-[15px]">
            Open paper trading
          </Link>
          <p className="mx-auto mt-7 max-w-[480px] text-xs leading-[1.6] text-[#5c6b62]">
            Simulated fills, live funding data. No capital at risk until you decide it&apos;s
            proven. Not financial advice.
          </p>
        </div>

        <div className="mt-[140px] flex items-center justify-between border-t border-[rgba(238,241,238,0.08)] pt-7 text-left text-xs text-[#5c6b62]">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-[2px] bg-[#b6ff3c]" />
            DELTA/8
          </div>
          <div className="flex gap-6">
            <Link href="/bot/dashboard" className="no-underline hover:text-[#b6ff3c]">
              Dashboard
            </Link>
            <a href="#risk" className="no-underline hover:text-[#ff6a4d]">
              Risk disclosures
            </a>
            <Link href="/" className="no-underline hover:text-[#eef1ee]">
              Echo
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
