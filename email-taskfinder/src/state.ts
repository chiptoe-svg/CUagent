// All persistent state IO: progress.yaml, decisions.jsonl,
// pending_residuals.jsonl, tasks.json sidecar, and the scan lock.

import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { STATE_DIR } from './config.js';
import { log } from './log.js';
import { PendingResidual, Progress } from './types.js';

function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

// --- progress.yaml ---

const PROGRESS_PATH = (): string => path.join(STATE_DIR, 'progress.yaml');

export function loadProgress(): Progress {
  try {
    const raw = fs.readFileSync(PROGRESS_PATH(), 'utf-8');
    return (YAML.parse(raw) ?? {}) as Progress;
  } catch {
    return {};
  }
}

export function writeProgress(prog: Progress): void {
  ensureStateDir();
  fs.writeFileSync(PROGRESS_PATH(), YAML.stringify(prog, { lineWidth: 0 }));
}

// --- decisions.jsonl ---

const DECISIONS_PATH = (): string => path.join(STATE_DIR, 'decisions.jsonl');

export function appendDecision(entry: Record<string, unknown>): void {
  ensureStateDir();
  fs.appendFileSync(
    DECISIONS_PATH(),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
  );
}

export function loadResolvedEmailIds(daysBack = 30): Set<string> {
  const out = new Set<string>();
  const p = DECISIONS_PATH();
  if (!fs.existsSync(p)) return out;
  const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { ts?: string; email_id?: string };
      if (!entry.email_id) continue;
      if (entry.ts) {
        const t = Date.parse(entry.ts);
        if (!Number.isNaN(t) && t < cutoffMs) continue;
      }
      out.add(entry.email_id);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// --- pending_residuals.jsonl ---

const PENDING_PATH = (): string =>
  path.join(STATE_DIR, 'pending_residuals.jsonl');

export function loadPendingResiduals(): PendingResidual[] {
  const p = PENDING_PATH();
  if (!fs.existsSync(p)) return [];
  const out: PendingResidual[] = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line) continue;
    try {
      const raw = JSON.parse(line) as Partial<PendingResidual> & {
        scan_run_id: string;
        email_id: string;
        account: 'gmail' | 'outlook';
        from: string;
        subject: string;
        handoff_ts: string;
      };
      out.push({
        scan_run_id: raw.scan_run_id,
        email_id: raw.email_id,
        account: raw.account,
        from: raw.from,
        subject: raw.subject,
        handoff_ts: raw.handoff_ts,
        first_handoff_ts: raw.first_handoff_ts ?? raw.handoff_ts,
        attempt_count: raw.attempt_count ?? 1,
      });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function writePendingResiduals(entries: PendingResidual[]): void {
  ensureStateDir();
  const body =
    entries.map((e) => JSON.stringify(e)).join('\n') +
    (entries.length > 0 ? '\n' : '');
  fs.writeFileSync(PENDING_PATH(), body);
}

// --- tasks.json sidecar ---

const SIDECAR_PATH = (): string => path.join(STATE_DIR, 'tasks.json');

export function writeSidecar(
  taskId: string,
  meta: Record<string, string | undefined>,
): void {
  ensureStateDir();
  const p = SIDECAR_PATH();
  let map: Record<string, unknown> = {};
  if (fs.existsSync(p)) {
    try {
      map = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    } catch {
      map = {};
    }
  }
  map[taskId] = meta;
  fs.writeFileSync(p, JSON.stringify(map, null, 2) + '\n');
}

// --- scan lock ---
//
// Cron and a manual run can race on tasks.json + pending_residuals.jsonl.
// The lock serializes them. Stale-lock recovery handles a scan that crashed
// without releasing.

const LOCK_PATH = (): string => path.join(STATE_DIR, 'scan_in_progress.lock');
const LOCK_STALE_MS = 10 * 60_000;

export function acquireScanLock(): boolean {
  ensureStateDir();
  const p = LOCK_PATH();
  try {
    fs.writeFileSync(p, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      const age = Date.now() - fs.statSync(p).mtimeMs;
      if (age > LOCK_STALE_MS) {
        log.warn('stale scan lock — recovering', { ageMs: age });
        fs.unlinkSync(p);
        fs.writeFileSync(p, String(process.pid), { flag: 'wx' });
        return true;
      }
    } catch {
      /* race with another runner — treat as held */
    }
    return false;
  }
}

export function releaseScanLock(): void {
  try {
    fs.unlinkSync(LOCK_PATH());
  } catch {
    /* already gone */
  }
}
