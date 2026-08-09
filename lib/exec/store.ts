import { promises as fs } from "fs";
import path from "path";
import type { ExecPosition } from "./types";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const EXEC_DIR = path.join(DATA_DIR, "exec");
const HALT_FILE = path.join(EXEC_DIR, "HALT");

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
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(EXEC_DIR, f), "utf8")));
    } catch {
      // skip corrupt
    }
  }
  out.sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
  return out;
}
