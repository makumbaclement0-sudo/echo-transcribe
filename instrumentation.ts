// Runs once when the Next.js server boots (both dev and production). We use it
// to start the auto-trader's background loop, so it resumes automatically every
// time the app restarts — including after a PC reboot when the app is launched
// by the Windows startup task.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutoLoop } = await import("./lib/exec/auto");
    startAutoLoop();
  }
}
