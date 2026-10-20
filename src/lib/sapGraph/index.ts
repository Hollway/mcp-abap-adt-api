/**
 * Which graph file belongs to a system, and the one load that may run on it.
 *
 * Kept per process, not per server object: over HTTP a server is built for
 * every request, and the open file and a running load have to outlive it.
 * Across processes - every chat runs its own bridge over stdio, all of them on
 * the same file - a load announces itself in a lock file next to the graph,
 * with its process id and a heartbeat. SQLite would turn a second writer away
 * by itself; the lock file is what lets the second one say who is loading and
 * how far it got instead of failing on a busy database.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphStore } from './store';
import { fullSync, deltaSync, RowSource, SyncOptions, SyncProgress, SyncResult } from './sync';

/** Where graph files live (SAP_GRAPH_DIR, default ~/.abap-graph). */
export const graphDir = (): string => (process.env.SAP_GRAPH_DIR || '').trim() || path.join(os.homedir(), '.abap-graph');

/** First letters of customer objects (SAP_GRAPH_PREFIXES, default Z,Y). */
export const graphPrefixes = (): string[] => {
  const configured = (process.env.SAP_GRAPH_PREFIXES || 'Z,Y').split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
  return configured.length > 0 ? configured : ['Z', 'Y'];
};

/** After how many minutes a question first brings the graph up to date (SAP_GRAPH_MAX_AGE_MIN, default 60; 0 = never). */
export const graphMaxAgeMinutes = (): number => {
  const value = Number(process.env.SAP_GRAPH_MAX_AGE_MIN);
  return Number.isFinite(value) && value >= 0 ? value : 60;
};

/**
 * The file for a system: host, path and client, so a development and a QA system on the same
 * host, or two clients of one system, never share a graph - whatever the MCP
 * server happens to be called.
 */
export function graphFileFor(baseUrl: string, client?: string): string {
  let host = baseUrl;
  try {
    const url = new URL(baseUrl);
    host = `${url.hostname}${url.port ? `_${url.port}` : ''}${url.pathname}`;
  } catch { /* not a URL - use it as it is */ }
  const name = `${host}_${client || 'default'}`
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return path.join(graphDir(), `${name}.db`);
}

const stores = new Map<string, GraphStore>();

/** The open graph for a file, created empty on first use. */
export function graphStore(file: string): GraphStore {
  let store = stores.get(file);
  if (!store) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    store = new GraphStore(file);
    stores.set(file, store);
  }
  return store;
}

/** What a load says about itself, in the lock file and in answers. */
export interface LoadInfo {
  pid: number;
  mode: 'full' | 'delta';
  startedAt: string;
  heartbeat: string;
  phase: string;
  rows: number;
  queries: number;
}

const lockFile = (file: string) => `${file}.lock`;
const HEARTBEAT_MS = 3000;
const STALE_MS = 3 * 60 * 1000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
};

/** The load another process is running on this file, if it is still alive. */
export function foreignLoad(file: string): LoadInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(lockFile(file), 'utf8')) as LoadInfo;
    if (info.pid === process.pid) return undefined;
    const age = Date.now() - Date.parse(info.heartbeat);
    if (!alive(info.pid) || !(age < STALE_MS)) return undefined;
    return info;
  } catch {
    return undefined;
  }
}

const writeLock = (file: string, info: LoadInfo) => {
  const temporary = `${lockFile(file)}.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(info));
  fs.renameSync(temporary, lockFile(file));
};

const removeLock = (file: string) => {
  try {
    const info = JSON.parse(fs.readFileSync(lockFile(file), 'utf8')) as LoadInfo;
    if (info.pid === process.pid) fs.unlinkSync(lockFile(file));
  } catch { /* gone already */ }
};

export interface LoadJob {
  info: LoadInfo;
  promise: Promise<SyncResult>;
  result?: SyncResult;
  error?: string;
  finishedAt?: string;
}

const jobs = new Map<string, LoadJob>();

/** This process's load on a file: running, or the last one finished. */
export const loadJob = (file: string): LoadJob | undefined => jobs.get(file);

export type StartOutcome =
  | { started: true; job: LoadJob }
  | { started: false; running: LoadJob }
  | { started: false; foreign: LoadInfo };

/**
 * Start a load unless one is running here or in another process. The load
 * goes on in the background; the caller decides how long to wait for it.
 */
export function startLoad(file: string, source: RowSource, mode: 'full' | 'delta', options: SyncOptions): StartOutcome {
  const current = jobs.get(file);
  if (current && !current.finishedAt) return { started: false, running: current };
  const foreign = foreignLoad(file);
  if (foreign) return { started: false, foreign };

  const store = graphStore(file);
  const now = new Date().toISOString();
  const info: LoadInfo = { pid: process.pid, mode, startedAt: now, heartbeat: now, phase: 'starting', rows: 0, queries: 0 };
  let lastBeat = 0;
  const onProgress = (progress: SyncProgress) => {
    info.phase = progress.phase;
    info.rows = progress.rows;
    info.queries = progress.queries;
    if (Date.now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = Date.now();
      info.heartbeat = new Date().toISOString();
      try { writeLock(file, info); } catch { /* the lock is a courtesy; the load does not depend on it */ }
    }
    options.onProgress?.(progress);
  };
  writeLock(file, info);

  const run = mode === 'full' ? fullSync : deltaSync;
  const job: LoadJob = { info, promise: Promise.resolve(undefined as unknown as SyncResult) };
  job.promise = run(store, source, { ...options, onProgress })
    .then(result => {
      job.result = result;
      return result;
    }, (error: unknown) => {
      job.error = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      removeLock(file);
    });
  // Nobody may be waiting for it; a failure is reported through job.error.
  job.promise.catch(() => undefined);
  jobs.set(file, job);
  return { started: true, job };
}

/** Wait for a load at most this long; true when it finished in time. */
export async function waitFor(job: LoadJob, seconds: number): Promise<boolean> {
  if (job.finishedAt) return true;
  if (seconds <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), seconds * 1000); });
  const done = job.promise.then(() => true, () => true);
  const finished = await Promise.race([done, timeout]);
  if (timer) clearTimeout(timer);
  return finished;
}

/** Close every open graph - for tests. */
export function closeGraphs(): void {
  for (const store of stores.values()) {
    try { store.close(); } catch { /* already closed */ }
  }
  stores.clear();
  jobs.clear();
}
