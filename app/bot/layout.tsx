import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Serif } from "next/font/google";
import "./bot-theme.css";

// "Spontaneity Machine" theme, scoped to /bot — Echo's pages are untouched.
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
});

const instrument = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument",
});

export const metadata: Metadata = {
  title: "Funding-Rate Arbitrage Bot",
  description: "Autonomous funding-rate arbitrage across Binance, Bybit and OKX.",
};

export default function BotLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`bot-theme ${bricolage.variable} ${instrument.variable}`}>
      <div className="bot-blob bot-blob-a" aria-hidden />
      <div className="bot-blob bot-blob-b" aria-hidden />
      {children}
    </div>
  );
}
