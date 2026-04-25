/**
 * Known-contacts harvester — scans sent-mail for the last 90 days (on
 * first run) or since `last_harvested` (thereafter), extracts every To/Cc
 * address, dedupes, and appends new entries to
 *   groups/<main>/email-archive/known_contacts.yaml
 *
 * Host-side, zero-LLM. Runs on startup and re-arms for 24h later.
 * Consumed by /email-taskfinder: anyone you've sent mail to is treated
 * as "solicited" and bypasses the unsolicited-bucket label-only path.
 *
 * Self-disables gracefully when an account is not set up (missing token,
 * missing gws binary, etc.) — an individual account's failure must not
 * break the others.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { getMs365AccessToken } from './ms365-reconciler.js';
import { RegisteredGroup } from './types.js';

const GWS_BIN = process.env.GWS_BIN || '/opt/homebrew/bin/gws';
const BOOTSTRAP_WINDOW_DAYS = 90;
const DAILY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000; // let other init finish first
const GMAIL_PAGE_CAP = 500; // soft cap per run — sent-folder volume is low
const MS365_PAGE_CAP = 500;

export interface ContactsHarvesterDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface EmailAccountsFile {
  accounts: Array<{
    id: string;
    type: 'gws' | 'ms365' | 'imap';
    address?: string;
    enabled?: boolean;
  }>;
}

interface HarvestState {
  known: Set<string>;
  lastHarvested: string | null;
}

function findMainGroup(
  groups: Record<string, RegisteredGroup>,
): RegisteredGroup | null {
  for (const g of Object.values(groups)) if (g.isMain) return g;
  return null;
}

function loadAccounts(mainFolder: string): EmailAccountsFile['accounts'] {
  const p = path.join(GROUPS_DIR, mainFolder, 'email-accounts.yaml');
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf-8');
  // Tiny YAML subset: list of flat objects under `accounts:`.
  const accounts: EmailAccountsFile['accounts'] = [];
  let cur: Partial<EmailAccountsFile['accounts'][number]> | null = null;
  for (const line of raw.split('\n')) {
    const stripped = line.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!stripped) continue;
    if (/^\s*-\s+id:\s*(.+)$/.test(stripped)) {
      if (cur?.id) accounts.push(cur as EmailAccountsFile['accounts'][number]);
      cur = {
        id: stripped.match(/^\s*-\s+id:\s*(.+)$/)?.[1]?.trim() as string,
      };
      continue;
    }
    if (!cur) continue;
    const m = stripped.match(/^\s+([a-z_]+):\s*"?([^"]*)"?\s*$/);
    if (!m) continue;
    const [, key, val] = m;
    const v = val.trim();
    if (key === 'type') cur.type = v as 'gws' | 'ms365' | 'imap';
    else if (key === 'address') cur.address = v;
    else if (key === 'enabled') cur.enabled = v === 'true';
  }
  if (cur?.id) accounts.push(cur as EmailAccountsFile['accounts'][number]);
  return accounts.filter((a) => a.enabled !== false);
}

/**
 * Read known_contacts.yaml. Returns the set of existing addresses and the
 * last_harvested timestamp (ISO string) if present.
 */
function loadState(mainFolder: string): HarvestState {
  const p = path.join(
    GROUPS_DIR,
    mainFolder,
    'email-archive',
    'known_contacts.yaml',
  );
  const state: HarvestState = { known: new Set(), lastHarvested: null };
  if (!fs.existsSync(p)) return state;
  const raw = fs.readFileSync(p, 'utf-8');
  let inList = false;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line) continue;
    if (/^known_contacts:\s*\[\s*\]\s*$/.test(line)) {
      inList = false;
      continue;
    }
    if (/^known_contacts:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (/^[a-z_]/.test(line)) {
      // top-level key ends any list
      inList = false;
      const m = line.match(/^last_harvested:\s*"?([^"]*)"?\s*$/);
      if (m && m[1] && m[1] !== 'null') state.lastHarvested = m[1].trim();
      continue;
    }
    if (inList) {
      const m = line.match(/^\s+-\s+"?([^"\s]+)"?\s*$/);
      if (m) state.known.add(m[1].trim().toLowerCase());
    }
  }
  return state;
}

function writeState(
  mainFolder: string,
  addresses: string[],
  nowIso: string,
): void {
  const dir = path.join(GROUPS_DIR, mainFolder, 'email-archive');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'known_contacts.yaml');
  const header = `# Auto-populated by the contacts harvester. Addresses you have sent mail
# to in the last 90 days are treated as "solicited" by /email-taskfinder
# (skip the unsolicited bucket entirely — runs LLM classification).
#
# Safe to edit by hand; the harvester merges rather than overwrites, so
# manual additions survive the next run.\n\n`;
  const sorted = [...new Set(addresses.map((a) => a.toLowerCase()))].sort();
  const list =
    sorted.length === 0
      ? 'known_contacts: []\n'
      : 'known_contacts:\n' + sorted.map((a) => `  - "${a}"`).join('\n') + '\n';
  const tail = `\n# Last-harvested timestamp, updated by src/contacts-harvester.ts\nlast_harvested: "${nowIso}"\n`;
  fs.writeFileSync(p, header + list + tail);
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function extractEmails(text: string): string[] {
  return (text.match(EMAIL_RE) || []).map((e) => e.toLowerCase());
}

function ownAddress(accountAddress: string | undefined): string | null {
  return accountAddress ? accountAddress.toLowerCase() : null;
}

/**
 * Gmail sent-folder scan via the gws CLI. We list message IDs with a
 * single API call, then fetch metadata (To/Cc headers only) per message.
 * Each `get` call is ~60ms; 500 messages ≈ 30s, which is fine for a
 * daily background job.
 */
function harvestGmail(sinceIso: string | null, own: string | null): string[] {
  const q = sinceIso
    ? `in:sent after:${Math.floor(new Date(sinceIso).getTime() / 1000)}`
    : `in:sent newer_than:${BOOTSTRAP_WINDOW_DAYS}d`;
  let ids: string[] = [];
  try {
    const listOut = execFileSync(
      GWS_BIN,
      [
        'gmail',
        'users',
        'messages',
        'list',
        '--params',
        JSON.stringify({ userId: 'me', q, maxResults: GMAIL_PAGE_CAP }),
        '--format',
        'json',
      ],
      {
        encoding: 'utf-8',
        env: { ...process.env, GWS_CREDENTIAL_STORE: 'plaintext' },
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const parsed = JSON.parse(listOut) as { messages?: Array<{ id: string }> };
    ids = (parsed.messages || []).map((m) => m.id);
  } catch (err) {
    logger.debug({ err }, 'contacts-harvester: gmail list failed');
    return [];
  }

  const out = new Set<string>();
  for (const id of ids) {
    try {
      const getOut = execFileSync(
        GWS_BIN,
        [
          'gmail',
          'users',
          'messages',
          'get',
          '--params',
          JSON.stringify({
            userId: 'me',
            id,
            format: 'metadata',
            metadataHeaders: ['To', 'Cc', 'Bcc'],
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
      const msg = JSON.parse(getOut) as {
        payload?: { headers?: Array<{ name: string; value: string }> };
      };
      const headers = msg.payload?.headers || [];
      for (const h of headers) {
        if (!['To', 'Cc', 'Bcc'].includes(h.name)) continue;
        for (const addr of extractEmails(h.value || '')) {
          if (addr !== own) out.add(addr);
        }
      }
    } catch {
      /* per-message failures are fine — skip and continue */
    }
  }
  return [...out];
}

/**
 * Outlook sent-folder scan via Graph. One $select-narrowed request per
 * page (1000 msgs/page) is enough for any realistic user; we cap at
 * MS365_PAGE_CAP and move on.
 */
async function harvestMs365(
  sinceIso: string | null,
  own: string | null,
): Promise<string[]> {
  const token = await getMs365AccessToken();
  if (!token) return [];
  const filter = sinceIso ? `sentDateTime ge ${sinceIso}` : undefined;
  const selectFields = 'toRecipients,ccRecipients,bccRecipients,sentDateTime';
  const base =
    'https://graph.microsoft.com/v1.0/me/mailFolders/SentItems/messages';
  const params = new URLSearchParams({
    $select: selectFields,
    $top: String(Math.min(MS365_PAGE_CAP, 1000)),
  });
  if (filter) params.set('$filter', filter);

  const out = new Set<string>();
  try {
    const r = await fetch(`${base}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      logger.debug(
        { status: r.status },
        'contacts-harvester: ms365 sent-items fetch failed',
      );
      return [];
    }
    const body = (await r.json()) as {
      value?: Array<{
        toRecipients?: Array<{ emailAddress?: { address?: string } }>;
        ccRecipients?: Array<{ emailAddress?: { address?: string } }>;
        bccRecipients?: Array<{ emailAddress?: { address?: string } }>;
      }>;
    };
    for (const m of body.value || []) {
      const all = [
        ...(m.toRecipients || []),
        ...(m.ccRecipients || []),
        ...(m.bccRecipients || []),
      ];
      for (const r of all) {
        const addr = r.emailAddress?.address?.toLowerCase();
        if (addr && addr !== own) out.add(addr);
      }
    }
  } catch (err) {
    logger.debug({ err }, 'contacts-harvester: ms365 fetch threw');
    return [];
  }
  return [...out];
}

async function harvestOnce(mainFolder: string): Promise<void> {
  const accounts = loadAccounts(mainFolder);
  if (accounts.length === 0) {
    logger.debug('contacts-harvester: no accounts configured');
    return;
  }
  const state = loadState(mainFolder);
  const sinceIso = state.lastHarvested;

  const discovered = new Set<string>();
  for (const acc of accounts) {
    const own = ownAddress(acc.address);
    if (acc.type === 'gws') {
      for (const e of harvestGmail(sinceIso, own)) discovered.add(e);
    } else if (acc.type === 'ms365') {
      for (const e of await harvestMs365(sinceIso, own)) discovered.add(e);
    }
  }
  const before = state.known.size;
  const merged = new Set([...state.known, ...discovered]);
  const added = merged.size - before;
  writeState(mainFolder, [...merged], new Date().toISOString());
  logger.info(
    { before, added, total: merged.size, sinceIso },
    'contacts-harvester: run complete',
  );
}

export function startContactsHarvester(deps: ContactsHarvesterDeps): void {
  const tick = async (): Promise<void> => {
    try {
      const main = findMainGroup(deps.registeredGroups());
      if (main) await harvestOnce(main.folder);
    } catch (err) {
      logger.warn({ err }, 'contacts-harvester: tick failed');
    }
  };
  setTimeout(tick, STARTUP_DELAY_MS);
  setInterval(tick, DAILY_MS);
  logger.info('contacts-harvester: armed (24h cadence)');
}
