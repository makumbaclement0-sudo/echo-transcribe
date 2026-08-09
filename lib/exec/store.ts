import { promises as fs } from "fs";
import path from "path";
import type { ExecPosition } from "./types";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const EXEC_DIR = path.join(DATA_DIR, "exec");
const HALT_FILE = path.join(EXEC_DIR, "HALT");
const AUTO_FILE = path.join(EXEC_DIR, "AUTO");
const AUTO_LAST_FILE = path.join(EXEC_DIR, "AUTO_LAST.json");

async function ensureDir() {
  await fs.mkdir(EXEC_DIR, { recursive: true });
}

/** Kill switch: while the HALT file exists, no order may be placed. */
export async function isHalted(): Promise<boolean> {
  try {
    await fs.access(HALT_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function setHalt(on: boolean): Promise<void> {
  await ensureDir();
  if (on) await fs.writeFile(HALT_FILE, new Date().toISOString(), "utf8");
  else await fs.rm(HALT_FILE, { force: true });
}

/** Auto-trader on/off toggle (persists across restarts as a file). */
export async function isAutoOn(): Promise<boolean> {
  try {
    await fs.access(AUTO_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function setAuto(on: boolean): Promise<void> {
  await ensureDir();
  if (on) await fs.writeFile(AUTO_FILE, new Date().toISOString(), "utf8");
  else await fs.rm(AUTO_FILE, { force: true });
}

export async function getLastAuto(): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(AUTO_LAST_FILE, "utf8"));
  } catch {
    return null;
  }
}

export async function setLastAuto(v: unknown): Promise<void> {
  await ensureDir();
  await fs.writeFile(AUTO_LAST_FILE, JSON.stringify(v, null, 2), "utf8");
}

function posPath(id: string) {
  return path.join(EXEC_DIR, `${id}.json`);
}

export async function savePosition(p: ExecPosition): Promise<ExecPosition> {
  await ensureDir();
  await fs.writeFile(posPath(p.id), JSON.stringify(p, null, 2), "utf8");
  return p;
}

export async function getPosition(id: string): Promise<ExecPosition | null> {
  try {
    return JSON.parse(await fs.readFile(posPath(id), "utf8"));
  } catch {
    return null;
  }
}

export async function listPositions(): Promise<ExecPosition[]> {
  await ensureDir();
  const files = await fs.readdir(EXEC_DIR);
  const out: ExecPosition[] = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f === "AUTO_LAST.json") continue;
    try {
      const p = JSON.parse(await fs.readFile(path.join(EXEC_DIR, f), "utf8"));
      // Guard against any non-position json living in the same dir.
      if (p && p.short && p.long && p.id) out.push(p);
    } catch {
      // skip corrupt
    }
  }
  out.sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
  return out;
}
