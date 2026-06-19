import { promises as fs } from "fs";
import path from "path";
import { Job } from "./types";

// Simple file-based store so the app runs with zero external DB setup.
// DATA_DIR lets a deployment point this at a persistent disk (e.g. on Render).
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

export function uploadsDir() {
  return UPLOADS_DIR;
}

async function ensureDirs() {
  await fs.mkdir(JOBS_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

function jobPath(id: string) {
  return path.join(JOBS_DIR, `${id}.json`);
}

export async function saveJob(job: Job): Promise<Job> {
  await ensureDirs();
  job.updatedAt = new Date().toISOString();
  await fs.writeFile(jobPath(job.id), JSON.stringify(job, null, 2), "utf8");
  return job;
}

export async function getJob(id: string): Promise<Job | null> {
  try {
    const raw = await fs.readFile(jobPath(id), "utf8");
    return JSON.parse(raw) as Job;
  } catch {
    return null;
  }
}

export async function updateJob(
  id: string,
  patch: Partial<Job>
): Promise<Job | null> {
  const job = await getJob(id);
  if (!job) return null;
  const updated = { ...job, ...patch };
  return saveJob(updated);
}

export async function listJobs(): Promise<Job[]> {
  await ensureDirs();
  const files = await fs.readdir(JOBS_DIR);
  const jobs: Job[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(JOBS_DIR, f), "utf8");
      jobs.push(JSON.parse(raw) as Job);
    } catch {
      // skip corrupt files
    }
  }
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return jobs;
}

export async function deleteJob(id: string): Promise<boolean> {
  const job = await getJob(id);
  if (!job) return false;
  try {
    await fs.unlink(path.join(UPLOADS_DIR, job.storedFile));
  } catch {
    // ignore missing upload
  }
  try {
    await fs.unlink(jobPath(id));
  } catch {
    return false;
  }
  return true;
}
