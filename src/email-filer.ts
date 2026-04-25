/**
 * Host-side email filer — moves an email to its target folder directly
 * via Graph / Gmail, without waking the agent.
 *
 * Called from the MS365 reconciler after detecting a tap-completed to-do.
 * Previously the reconciler enqueued a scheduled task whose only job was
 * to tell the agent "file this email"; those runs cost $0.06–$0.19 each
 * even though the operation is deterministic. This module does the same
 * work as a Graph REST call (MS365) or a gws CLI call (Gmail) for zero
 * LLM cost.
 *
 * Returns `true` on success, `false` if anything wasn't resolvable —
 * the caller (reconciler) can then fall back to the agent path so a
 * failure here never loses an email-filing intent.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const GWS_BIN = process.env.GWS_BIN || '/opt/homebrew/bin/gws';

interface ArchiveFolderMap {
  gmail: Record<string, string>;
  outlook: Record<string, string>;
}

/** Minimal archive-config reader — just the folder_ids maps we need. */
function loadArchiveFolderMap(mainFolder: string): ArchiveFolderMap {
  const p = path.join(GROUPS_DIR, mainFolder, 'email-archive', 'config.yaml');
  const out: ArchiveFolderMap = { gmail: {}, outlook: {} };
  if (!fs.existsSync(p)) return out;
  const raw = fs.readFileSync(p, 'utf-8');
  let currentAccount: 'gmail' | 'outlook' | null = null;
  let inFolderIds = false;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line) continue;
    const accountMatch = line.match(/^\s+-\s+id:\s*(gmail|outlook)\s*$/);
    if (accountMatch) {
      currentAccount = accountMatch[1] as 'gmail' | 'outlook';
      inFolderIds = false;
      continue;
    }
    if (/^\s+folder_ids:\s*$/.test(line)) {
      inFolderIds = true;
      continue;
    }
    if (/^[a-z_]+:/.test(line)) {
      currentAccount = null;
      inFolderIds = false;
    }
    if (!currentAccount || !inFolderIds) continue;
    const m = line.match(/^\s+"([^"]+)":\s*"([^"]+)"\s*$/);
    if (!m) continue;
    const [, folder, id] = m;
    out[currentAccount][folder] = id;
  }
  return out;
}

function appendFiledLog(
  mainFolder: string,
  entry: Record<string, unknown>,
): void {
  try {
    const dir = path.join(GROUPS_DIR, mainFolder, 'email-triage', 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'filed.jsonl'),
      JSON.stringify(entry) + '\n',
    );
  } catch (err) {
    logger.warn({ err }, 'email-filer: failed to append to filed.jsonl');
  }
}

async function fileMs365(
  token: string,
  emailId: string,
  folderId: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${emailId}/move`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ destinationId: folderId }),
      },
    );
    if (r.ok) return { ok: true, status: r.status };
    const bodyText = await r.text();
    return { ok: false, status: r.status, error: bodyText.slice(0, 200) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function fileGmail(
  messageId: string,
  labelId: string,
): { ok: boolean; error?: string } {
  try {
    const out = execFileSync(
      GWS_BIN,
      [
        'gmail',
        'users',
        'messages',
        'modify',
        '--params',
        JSON.stringify({ userId: 'me', id: messageId }),
        '--json',
        JSON.stringify({
          addLabelIds: [labelId],
          removeLabelIds: ['INBOX'],
        }),
        '--format',
        'json',
      ],
      {
        encoding: 'utf-8',
        env: { ...process.env, GWS_CREDENTIAL_STORE: 'plaintext' },
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const trimmed = out.trim();
    if (!trimmed) return { ok: false, error: 'empty response' };
    JSON.parse(trimmed); // validate it's a message object
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface FilingInput {
  mainFolder: string;
  ms365Token: string; // live access token, from the reconciler
  account: string; // "ms365" | "outlook" | "gmail" | "gws"
  emailId: string;
  targetFolder?: string; // e.g. "Sorted/GC-Operations"
  // Telemetry / logging fields
  taskId: string;
  taskTitle?: string;
  subject?: string;
  from?: string;
}

export interface FilingResult {
  ok: boolean;
  reason?: string; // why it couldn't be filed directly (if ok=false)
}

export async function fileEmailDirect(
  input: FilingInput,
): Promise<FilingResult> {
  if (!input.targetFolder) {
    return { ok: false, reason: 'no target folder on sidecar' };
  }
  const map = loadArchiveFolderMap(input.mainFolder);
  const isGmail = input.account === 'gmail' || input.account === 'gws';
  const accountKey: 'gmail' | 'outlook' = isGmail ? 'gmail' : 'outlook';
  const folderId = map[accountKey][input.targetFolder];
  if (!folderId) {
    return {
      ok: false,
      reason: `no ${accountKey} folder-id mapping for "${input.targetFolder}"`,
    };
  }

  const result = isGmail
    ? fileGmail(input.emailId, folderId)
    : await fileMs365(input.ms365Token, input.emailId, folderId);

  if (!result.ok) {
    return { ok: false, reason: result.error || 'unknown' };
  }

  appendFiledLog(input.mainFolder, {
    ts: new Date().toISOString(),
    via: 'host-direct',
    task_id: input.taskId,
    task_title: input.taskTitle,
    email_id: input.emailId,
    account: input.account,
    from: input.from,
    subject: input.subject,
    folder: input.targetFolder,
  });
  logger.info(
    {
      account: input.account,
      emailId: input.emailId,
      folder: input.targetFolder,
    },
    'email-filer: filed via host-direct (no agent)',
  );
  return { ok: true };
}
