import { promises as fs } from "fs";
import path from "path";
import { ControlFile, EngineState, Opportunity, Position, Trade } from "./types";

// File-based store under data/bot/ — same zero-DB approach as lib/store.ts.
// The engine process writes state; the Next.js API routes only read it (and
// write control.json to send commands). Writes go through a tmp-file rename
// so readers never see a half-written JSON file.

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const BOT_DIR = path.join(DATA_DIR, "bot");
const POSITIONS_DIR = path.join(BOT_DIR, "positions");
const HISTORY_DIR = path.join(BOT_DIR, "history");

const STATE_FILE = path.join(BOT_DIR, "state.json");
const OPPS_FILE = path.join(BOT_DIR, "opportunities.json");
const CONTROL_FILE = path.join(BOT_DIR, "control.json");
const TRADES_FILE = path.join(BOT_DIR, "trades.jsonl");

export async function ensureBotDirs() {
  await fs.mkdir(POSITIONS_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });
}

async function writeJsonAtomic(file: string, value: unknown) {
  await ensureBotDirs();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---- engine state ----

export const saveState = (s: EngineState) => writeJsonAtomic(STATE_FILE, s);
export const readState = () => readJson<EngineState>(STATE_FILE);

// ---- opportunities ----

export const saveOpportunities = (o: Opportunity[]) => writeJsonAtomic(OPPS_FILE, o);
export const readOpportunities = async () => (await readJson<Opportunity[]>(OPPS_FILE)) ?? [];

// ---- positions ----

export async function savePosition(p: Position) {
  p.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(POSITIONS_DIR, `${p.id}.json`), p);
}

export async function listOpenPositions(): Promise<Position[]> {
  await ensureBotDirs();
  return listDir<Position>(POSITIONS_DIR);
}

/** Move a closed/failed position from positions/ to history/. */
export async function archivePosition(p: Position) {
  p.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(HISTORY_DIR, `${p.id}.json`), p);
  await fs.unlink(path.join(POSITIONS_DIR, `${p.id}.json`)).catch(() => {});
}

export async function listClosedPositions(limit = 100): Promise<Position[]> {
  await ensureBotDirs();
  const all = await listDir<Position>(HISTORY_DIR);
  all.sort((a, b) => (a.closedAt ?? "").localeCompare(b.closedAt ?? "")).reverse();
  return all.slice(0, limit);
}

async function listDir<T>(dir: string): Promise<T[]> {
  const files = await fs.readdir(dir);
  const out: T[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const v = await readJson<T>(path.join(dir, f));
    if (v) out.push(v);
  }
  return out;
}

// ---- trade log ----

export async function appendTrades(trades: Trade[]) {
  if (trades.length === 0) return;
  await ensureBotDirs();
  const lines = trades.map((t) => JSON.stringify(t)).join("\n") + "\n";
  await fs.appendFile(TRADES_FILE, lines, "utf8");
}

export async function readRecentTrades(limit = 200): Promise<Trade[]> {
  try {
    const raw = await fs.readFile(TRADES_FILE, "utf8");
    const lines = raw.trim().split("\n");
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as Trade;
        } catch {
          return null;
        }
      })
      .filter((t): t is Trade => t !== null)
      .reverse();
  } catch {
    return [];
  }
}

// ---- control channel (dashboard -> engine) ----

export const readControl = () => readJson<ControlFile>(CONTROL_FILE);

export async function writeControl(cmd: Omit<ControlFile, "seq" | "requestedAt">) {
  const prev = await readControl();
  const next: ControlFile = {
    ...cmd,
    seq: (prev?.seq ?? 0) + 1,
    requestedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(CONTROL_FILE, next);
  return next;
}
