/**
 * Reminders reconciliation poll.
 *
 * Runs on the host every REMINDERS_POLL_INTERVAL seconds (default 30).
 * Asks the reminders-host Swift app which reminders were tap-completed in
 * the last 24h, and for each newly-seen reminder whose notes contain
 * email-triage metadata, enqueues a one-shot agent task to file the email.
 *
 * Design choices documented in docs/apple-reminders-mcp.md#polling--reconciliation:
 * - State comes from reminder.notes (no separate pending.json — the agent is
 *   the only writer, so notes integrity is trusted).
 * - Reconciliation fires filing via createTask() rather than direct container
 *   spawning; that routes through the existing scheduler + GroupQueue and
 *   keeps side-effects inside the agent's container sandbox.
 * - Processed ids are persisted with a 48h TTL so a restart doesn't re-fire
 *   already-handled completions.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { createTask, getTaskById } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const DEFAULT_HOST = 'http://127.0.0.1:3002';
const DEFAULT_INTERVAL_S = 30;
const SEEN_TTL_MS = 48 * 60 * 60 * 1000;
const SEEN_MAX = 2000;

const STATE_FILE = path.join(DATA_DIR, 'reminders-reconciled.json');

interface RemoteReminder {
  id: string;
  title: string;
  notes: string | null;
  completed: boolean;
  completedAt: string | null;
  listId: string;
  listName: string;
}

interface EmailMetadata {
  email_id: string;
  account: string;
  from?: string;
  subject?: string;
  folder?: string;
}

interface SeenEntry {
  id: string;
  at: number; // epoch ms when first seen
}

export interface ReconcilerDeps {
  /** Live map of registered groups keyed by JID. */
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Called when a new one-shot task is inserted so the scheduler can refresh snapshots. */
  onTaskCreated: () => void;
}

function getHost(): string {
  return process.env.REMINDERS_HOST || DEFAULT_HOST;
}

function getIntervalMs(): number {
  const s = parseInt(process.env.REMINDERS_POLL_INTERVAL || '', 10);
  return (Number.isFinite(s) && s > 0 ? s : DEFAULT_INTERVAL_S) * 1000;
}

function loadSeen(): SeenEntry[] {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as SeenEntry[];
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* first run or corrupted — start empty */
  }
  return [];
}

function saveSeen(entries: SeenEntry[]): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(entries));
  } catch (err) {
    logger.warn({ err }, 'reminders reconciler: failed to persist seen set');
  }
}

function pruneSeen(entries: SeenEntry[]): SeenEntry[] {
  const cutoff = Date.now() - SEEN_TTL_MS;
  return entries.filter((e) => e.at >= cutoff).slice(-SEEN_MAX);
}

/**
 * Look up email-triage metadata for a reminder.
 *
 * Primary source: sidecar at groups/<main>/email-triage/state/tasks.json,
 * keyed by reminder id. Keeps the user-facing reminder notes clean.
 *
 * Fallback: parse reminder.notes as JSON, for reminders created before
 * the sidecar convention (pre-2026-04-19).
 */
function lookupEmailMeta(
  mainFolder: string,
  reminderId: string,
  notes: string | null,
): EmailMetadata | null {
  // 1. Sidecar (primary)
  try {
    const sidecarPath = path.join(
      GROUPS_DIR,
      mainFolder,
      'email-triage',
      'state',
      'tasks.json',
    );
    const raw = fs.readFileSync(sidecarPath, 'utf-8');
    const map = JSON.parse(raw) as Record<string, unknown>;
    const entry = map[reminderId];
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).email_id === 'string' &&
      typeof (entry as Record<string, unknown>).account === 'string'
    ) {
      const e = entry as Record<string, unknown>;
      return {
        email_id: e.email_id as string,
        account: e.account as string,
        from: typeof e.from === 'string' ? e.from : undefined,
        subject: typeof e.subject === 'string' ? e.subject : undefined,
        folder: typeof e.folder === 'string' ? e.folder : undefined,
      };
    }
  } catch {
    /* sidecar missing — fall through to notes parse */
  }

  // 2. Notes-JSON fallback (pre-sidecar reminders)
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes) as Record<string, unknown>;
    if (typeof parsed.email_id !== 'string') return null;
    if (typeof parsed.account !== 'string') return null;
    return {
      email_id: parsed.email_id,
      account: parsed.account,
      from: typeof parsed.from === 'string' ? parsed.from : undefined,
      subject: typeof parsed.subject === 'string' ? parsed.subject : undefined,
      folder: typeof parsed.folder === 'string' ? parsed.folder : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchRecentlyCompleted(host: string): Promise<RemoteReminder[]> {
  const url = `${host}/reminders?status=recently_completed&limit=50`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    // Treat unreachable host as "nothing to reconcile this tick" — the Swift app
    // may be restarting, or the whole feature may not be installed on this host.
    logger.debug(
      { err, host },
      'reminders host unreachable; skipping this poll',
    );
    return [];
  }
  if (!res.ok) {
    logger.warn({ status: res.status, host }, 'reminders host returned non-OK');
    return [];
  }
  const text = await res.text();
  if (!text) return [];
  try {
    return JSON.parse(text) as RemoteReminder[];
  } catch (err) {
    logger.warn({ err }, 'reminders host returned unparseable JSON');
    return [];
  }
}

function buildFilingPrompt(
  reminder: RemoteReminder,
  meta: EmailMetadata,
): string {
  return [
    `The user tap-completed a reminder on their iPhone (or Reminders.app) that was created by email-triage.`,
    `File the associated email silently — do not send a chat message. Append the filing record to /workspace/group/email-triage/state/filed.jsonl.`,
    ``,
    `Reminder:`,
    `- id: ${reminder.id}`,
    `- title: ${reminder.title}`,
    `- completed_at: ${reminder.completedAt ?? 'unknown'}`,
    ``,
    `Email metadata (from reminder notes):`,
    `- email_id: ${meta.email_id}`,
    `- account: ${meta.account}`,
    meta.from ? `- from: ${meta.from}` : '',
    meta.subject ? `- subject: ${meta.subject}` : '',
    meta.folder
      ? `- target folder: ${meta.folder}`
      : `- target folder: (not specified — look up from email-archive/rules.yaml)`,
    ``,
    `Use the appropriate MCP tool for the account (mcp__gws_mcp__*, mcp__ms365__*, or the legacy gws CLI) to move the message out of the inbox into the target folder. If the email is already out of the inbox, log that as the outcome.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function findMainGroup(
  groups: Record<string, RegisteredGroup>,
): { jid: string; group: RegisteredGroup } | null {
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) return { jid, group };
  }
  return null;
}

export function startRemindersReconciler(deps: ReconcilerDeps): void {
  const seenEntries = pruneSeen(loadSeen());
  const seen = new Set(seenEntries.map((e) => e.id));
  const seenEntryList: SeenEntry[] = seenEntries;

  const intervalMs = getIntervalMs();
  logger.info({ host: getHost(), intervalMs }, 'reminders reconciler starting');

  const tick = async (): Promise<void> => {
    try {
      const main = findMainGroup(deps.registeredGroups());
      if (!main) {
        return; // No main group registered yet — nothing to file.
      }

      const reminders = await fetchRecentlyCompleted(getHost());
      if (reminders.length === 0) return;

      let filed = 0;
      for (const r of reminders) {
        if (!r.completed) continue;
        if (seen.has(r.id)) continue;

        const meta = lookupEmailMeta(main.group.folder, r.id, r.notes);
        seen.add(r.id);
        seenEntryList.push({ id: r.id, at: Date.now() });

        if (!meta) {
          // Track seen but skip — a non-triage reminder the user checked off.
          continue;
        }

        const taskId = `reconcile-${r.id}`;
        if (getTaskById(taskId)) {
          // A previous tick already enqueued; don't duplicate even if the
          // seen set got wiped (e.g. after a reinstall).
          continue;
        }

        try {
          createTask({
            id: taskId,
            group_folder: main.group.folder,
            chat_jid: main.jid,
            prompt: buildFilingPrompt(r, meta),
            script: null,
            schedule_type: 'once',
            schedule_value: new Date().toISOString(),
            context_mode: 'isolated',
            next_run: new Date().toISOString(),
            status: 'active',
            created_at: new Date().toISOString(),
          });
          filed += 1;
          logger.info(
            { reminderId: r.id, emailId: meta.email_id, account: meta.account },
            'enqueued email-filing task from completed reminder',
          );
        } catch (err) {
          logger.warn(
            { err, reminderId: r.id },
            'failed to enqueue filing task — will retry next tick',
          );
          // Roll back seen so we retry next tick.
          seen.delete(r.id);
          seenEntryList.pop();
        }
      }

      if (filed > 0) {
        deps.onTaskCreated();
        const pruned = pruneSeen(seenEntryList);
        seenEntryList.length = 0;
        seenEntryList.push(...pruned);
        saveSeen(seenEntryList);
      }
    } catch (err) {
      logger.warn({ err }, 'reminders reconciler tick failed');
    } finally {
      setTimeout(tick, intervalMs);
    }
  };

  // First tick after a small delay so the service has time to finish other startup.
  setTimeout(tick, 5_000);
}
