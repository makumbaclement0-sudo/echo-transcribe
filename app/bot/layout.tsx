import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "./bot-theme.css";

// DELTA/8 theme (from the user's landing design), scoped to /bot —
// Echo's pages are untouched.
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
});

export const metadata: Metadata = {
  title: "DELTA/8 — Funding-Rate Arbitrage",
  description:
    "Long spot, short the perp, collect the funding delta. Paper-first funding-rate arbitrage across Binance, Bybit and OKX.",
};

export default function BotLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`bot-theme ${plexMono.variable} ${spaceGrotesk.variable}`}>{children}</div>
  );
}
