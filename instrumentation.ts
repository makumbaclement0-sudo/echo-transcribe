// Starts the funding-rate bot engine INSIDE the web server process when
// BOT_AUTOSTART=true — lets a single hosted service run site + bot together.
// Local default stays off: run the engine separately with `npm run bot`.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.BOT_AUTOSTART !== "true") return;
  const { runEngine } = await import("./lib/bot/engine");
  // Fire and forget — the loop runs for the life of the server and must not
  // block server startup.
  void runEngine({ standalone: false }).catch((e) => {
    console.error("[bot] embedded engine crashed:", e);
  });
}
