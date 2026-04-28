/**
 * Action-folder watcher.
 *
 * Polls a user-configured MS365 mail folder (e.g. "Action Required")
 * and for each NEW message creates a To Do task using the same
 * clean-title + sidecar-metadata convention as the email-triage skill.
 * No agent spawn, no LLM cost — it's a deterministic "email in this
 * folder becomes a task with this title" mapping that the user opts
 * into by dragging mail into the watched folder.
 *
 * Completion flow is shared with regular triage: when the user
 * tap-completes the task on any MS365 surface, `src/ms365-reconciler.ts`
 * reads the sidecar and enqueues the filing task.
 *
 * Config:
 *   groups/<main>/email-triage/action-folders.yaml
 *     ms365:
 *       folder_id: "AAMkAD..."
 *       folder_name: "Action Required"   # display only
 *
 * State:
 *   data/action-folder-seen.json — the message IDs we've already turned
 *   into tasks, so we don't re-create on each poll.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { getMs365AccessToken } from './ms365-reconciler.js';
import { PolicyDeniedError } from './policy/errors.js';
import { enforceM365Operation } from './policy/m365-operations.js';
import { RegisteredGroup } from './types.js';

const STATE_FILE = path.join(DATA_DIR, 'action-folder-seen.json');
const DEFAULT_INTERVAL_S = 30;
const SEEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — plenty for stale-detection
const SEEN_MAX = 5000;
const MAX_PER_TICK = 50;

interface ActionFolderConfig {
  ms365?: { folder_id: string; folder_name?: string };
  gws?: { label_id: string; label_name?: string };
}

interface Message {
  id: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  bodyPreview?: string;
}

interface SeenEntry {
  id: string;
  at: number;
}

export interface ActionFolderWatcherDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Called after any tick that created at least one task, so other
   *  subsystems can refresh their task snapshots. */
  onTaskCreated: () => void;
}

function getIntervalMs(): number {
  const s = parseInt(process.env.ACTION_FOLDER_INTERVAL || '', 10);
  return (Number.isFinite(s) && s > 0 ? s : DEFAULT_INTERVAL_S) * 1000;
}

function findMainGroup(
  groups: Record<string, RegisteredGroup>,
): { jid: string; group: RegisteredGroup } | null {
  for (const [jid, g] of Object.entries(groups)) {
    if (g.isMain) return { jid, group: g };
  }
  return null;
}

function loadConfig(mainFolder: string): ActionFolderConfig | null {
  const p = path.join(
    GROUPS_DIR,
    mainFolder,
    'email-triage',
    'action-folders.yaml',
  );
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return parseMiniYaml(raw);
  } catch {
    return null;
  }
}

/** Tiny YAML subset parser — just enough for our config shape. Avoids a
 *  dep for two nested scalars per stanza. Unknown keys are ignored. */
function parseMiniYaml(raw: string): ActionFolderConfig {
  const out: ActionFolderConfig = {};
  let currentProvider: 'ms365' | 'gws' | null = null;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line) continue;
    if (/^[a-z_]+:\s*$/i.test(line)) {
      const k = line.slice(0, -1).trim().toLowerCase();
      if (k === 'ms365') {
        currentProvider = 'ms365';
        if (!out.ms365) out.ms365 = { folder_id: '' };
      } else if (k === 'gws') {
        currentProvider = 'gws';
        if (!out.gws) out.gws = { label_id: '' };
      } else {
        currentProvider = null;
      }
      continue;
    }
    const m = line.match(/^\s+([a-z_]+):\s*"?([^"]*)"?\s*$/i);
    if (!m) continue;
    const [, key, val] = m;
    if (currentProvider === 'ms365' && out.ms365) {
      if (key === 'folder_id') out.ms365.folder_id = val;
      if (key === 'folder_name') out.ms365.folder_name = val;
    } else if (currentProvider === 'gws' && out.gws) {
      if (key === 'label_id') out.gws.label_id = val;
      if (key === 'label_name') out.gws.label_name = val;
    }
  }
  return out;
}

function loadSeen(): SeenEntry[] {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as SeenEntry[];
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* first run */
  }
  return [];
}

function saveSeen(entries: SeenEntry[]): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(entries));
  } catch (err) {
    logger.warn({ err }, 'action-folder watcher: failed to persist seen set');
  }
}

function pruneSeen(entries: SeenEntry[]): SeenEntry[] {
  const cutoff = Date.now() - SEEN_TTL_MS;
  return entries.filter((e) => e.at >= cutoff).slice(-SEEN_MAX);
}

async function listFolderMessages(
  token: string,
  folderId: string,
): Promise<Message[]> {
  const headers = { Authorization: `Bearer ${token}` };
  const url =
    `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages` +
    `?$select=id,subject,from,receivedDateTime,bodyPreview` +
    `&$orderby=receivedDateTime desc&$top=${MAX_PER_TICK}`;
  try {
    enforceM365Operation('read_mail', {
      graphPath: `/me/mailFolders/${folderId}/messages`,
    });
    const r = await fetch(url, { headers });
    if (!r.ok) {
      logger.debug(
        { status: r.status },
        'action-folder: messages fetch non-ok',
      );
      return [];
    }
    return ((await r.json()) as { value: Message[] }).value || [];
  } catch (err) {
    if (err instanceof PolicyDeniedError) return [];
    return [];
  }
}

/** Find the user's default To Do list id, cached in-process. */
let cachedDefaultListId: string | null = null;
async function getDefaultTodoListId(token: string): Promise<string | null> {
  if (cachedDefaultListId) return cachedDefaultListId;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    enforceM365Operation('read_task', { graphPath: '/me/todo/lists' });
    const r = await fetch('https://graph.microsoft.com/v1.0/me/todo/lists', {
      headers,
    });
    if (!r.ok) return null;
    const lists = (
      (await r.json()) as {
        value: Array<{
          id: string;
          displayName: string;
          wellknownListName?: string;
        }>;
      }
    ).value;
    const def =
      lists.find((l) => l.wellknownListName === 'defaultList') ||
      lists.find((l) => l.displayName === 'Tasks') ||
      lists[0];
    cachedDefaultListId = def?.id || null;
    return cachedDefaultListId;
  } catch {
    return null;
  }
}

function buildCleanTitle(
  m: Message,
  folderName: string,
  account: 'outlook' | 'gmail',
): string {
  const subj = (m.subject || '(no subject)').replace(/\s+/g, ' ').trim();
  return `${subj} → /${account}/${folderName}`;
}

// --- Gmail branch (shells out to gws CLI on host) ---
//
// Gmail uses label IDs. The watcher lists messages carrying the configured
// label, then fetches minimal metadata for each one. No Graph equivalent of
// "move out of folder" is used — since the label stays on the email, we
// rely on the seen-set to avoid re-triggering on each poll.
// gws CLI is installed at /opt/homebrew/bin/gws on macOS; use absolute path
// because launchd doesn't always inherit Homebrew's PATH.

const GWS_BIN = process.env.GWS_BIN || '/opt/homebrew/bin/gws';

function runGws(args: string[]): unknown | null {
  try {
    const out = execFileSync(GWS_BIN, args, {
      encoding: 'utf-8',
      env: { ...process.env, GWS_CREDENTIAL_STORE: 'plaintext' },
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    // gws prefixes output with "Using keyring backend: ..." on stderr, not
    // stdout; stdout is pure JSON when --format json is used.
    const trimmed = out.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (err) {
    logger.debug({ err, args }, 'action-folder: gws call failed');
    return null;
  }
}

interface GmailMessage {
  id: string;
  subject?: string;
  from?: string;
}

function listGmailMessages(labelId: string): GmailMessage[] {
  const listResp = runGws([
    'gmail',
    'users',
    'messages',
    'list',
    '--params',
    JSON.stringify({
      userId: 'me',
      labelIds: [labelId],
      maxResults: MAX_PER_TICK,
    }),
    '--format',
    'json',
  ]) as { messages?: Array<{ id: string }> } | null;
  if (!listResp?.messages?.length) return [];

  // Fetch metadata for each message — subject + from only, no body. We do
  // this serially because gws has internal rate-limiting; MAX_PER_TICK=50
  // caps the per-tick cost.
  const out: GmailMessage[] = [];
  for (const m of listResp.messages) {
    const meta = runGws([
      'gmail',
      'users',
      'messages',
      'get',
      '--params',
      JSON.stringify({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      }),
      '--format',
      'json',
    ]) as {
      id: string;
      payload?: { headers?: Array<{ name: string; value: string }> };
    } | null;
    if (!meta) continue;
    const headers = meta.payload?.headers || [];
    const subject = headers.find(
      (h) => h.name.toLowerCase() === 'subject',
    )?.value;
    const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value;
    out.push({ id: meta.id, subject, from });
  }
  return out;
}

async function createTaskForMessage(
  token: string,
  listId: string,
  title: string,
): Promise<string | null> {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  // Default due date: next business day 9am local.
  const now = new Date();
  const due = new Date(now);
  due.setDate(due.getDate() + 1);
  if (due.getDay() === 6) due.setDate(due.getDate() + 2); // Sat → Mon
  if (due.getDay() === 0) due.setDate(due.getDate() + 1); // Sun → Mon
  due.setHours(9, 0, 0, 0);

  const body = {
    title,
    importance: 'normal' as const,
    dueDateTime: { dateTime: due.toISOString().slice(0, 19), timeZone: 'UTC' },
  };
  try {
    enforceM365Operation('write_task', {
      graphPath: `/me/todo/lists/${listId}/tasks`,
    });
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks`,
      { method: 'POST', headers, body: JSON.stringify(body) },
    );
    if (!r.ok) {
      logger.warn(
        { status: r.status },
        'action-folder: create-todo-task failed',
      );
      return null;
    }
    const parsed = (await r.json()) as { id?: string };
    return parsed.id || null;
  } catch (err) {
    logger.warn({ err }, 'action-folder: create-todo-task threw');
    return null;
  }
}

function writeSidecar(
  mainFolder: string,
  taskId: string,
  meta: {
    email_id: string;
    account: string;
    from?: string;
    subject?: string;
    folder?: string;
  },
): void {
  const dir = path.join(GROUPS_DIR, mainFolder, 'email-triage', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'tasks.json');
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    /* first write */
  }
  obj[taskId] = meta;
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

export function startActionFolderWatcher(deps: ActionFolderWatcherDeps): void {
  const seenList = pruneSeen(loadSeen());
  const seen = new Set(seenList.map((e) => e.id));

  const intervalMs = getIntervalMs();
  logger.info({ intervalMs }, 'action-folder watcher starting');

  const tick = async (): Promise<void> => {
    try {
      const main = findMainGroup(deps.registeredGroups());
      if (!main) return;

      const cfg = loadConfig(main.group.folder);
      if (!cfg?.ms365?.folder_id && !cfg?.gws?.label_id) return; // not configured — noop

      const token = await getMs365AccessToken();
      if (!token) return;

      const listId = await getDefaultTodoListId(token);
      if (!listId) return;

      let created = 0;

      // --- MS365 branch ---
      if (cfg.ms365?.folder_id) {
        const folderName = cfg.ms365.folder_name || 'Action Required';
        const messages = await listFolderMessages(token, cfg.ms365.folder_id);
        for (const m of messages) {
          if (seen.has(m.id)) continue;
          const title = buildCleanTitle(m, folderName, 'outlook');
          const taskId = await createTaskForMessage(token, listId, title);
          if (!taskId) continue;

          writeSidecar(main.group.folder, taskId, {
            email_id: m.id,
            account: 'outlook',
            from: m.from?.emailAddress?.address,
            subject: m.subject,
            folder: `action/${folderName}`,
          });

          seen.add(m.id);
          seenList.push({ id: m.id, at: Date.now() });
          created += 1;
          logger.info(
            {
              messageId: m.id,
              taskId,
              subject: m.subject?.slice(0, 60),
              src: 'ms365',
            },
            'action-folder: created task from dropped email',
          );
        }
      }

      // --- Gmail branch (shells out to gws CLI) ---
      // All tasks still land in MS365 To Do — the user's single task surface.
      if (cfg.gws?.label_id) {
        const labelName = cfg.gws.label_name || 'Action Required';
        const messages = listGmailMessages(cfg.gws.label_id);
        for (const m of messages) {
          if (seen.has(m.id)) continue;
          const title = buildCleanTitle(
            { id: m.id, subject: m.subject } as Message,
            labelName,
            'gmail',
          );
          const taskId = await createTaskForMessage(token, listId, title);
          if (!taskId) continue;

          writeSidecar(main.group.folder, taskId, {
            email_id: m.id,
            account: 'gmail',
            from: m.from,
            subject: m.subject,
            folder: `action/${labelName}`,
          });

          seen.add(m.id);
          seenList.push({ id: m.id, at: Date.now() });
          created += 1;
          logger.info(
            {
              messageId: m.id,
              taskId,
              subject: m.subject?.slice(0, 60),
              src: 'gmail',
            },
            'action-folder: created task from dropped email',
          );
        }
      }

      if (created > 0) {
        deps.onTaskCreated();
        const pruned = pruneSeen(seenList);
        seenList.length = 0;
        seenList.push(...pruned);
        saveSeen(seenList);
      }
    } catch (err) {
      logger.warn({ err }, 'action-folder watcher tick failed');
    } finally {
      setTimeout(tick, intervalMs);
    }
  };

  setTimeout(tick, 10_000);
}
