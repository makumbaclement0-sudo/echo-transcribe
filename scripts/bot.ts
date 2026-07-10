// Funding-rate arbitrage engine — standalone process, started with:
//   npm run bot
// The loop itself lives in lib/bot/engine.ts (also embeddable in the Next.js
// server via instrumentation.ts + BOT_AUTOSTART=true).

import { runEngine } from "../lib/bot/engine";

runEngine({ standalone: true }).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
