/**
 * Host-side email pre-classifier.
 *
 * Replaces the old "wake the agent and let it decide everything" flow for
 * /email-taskfinder. Fires on a cron schedule, walks new inbox mail, resolves
 * bucket 1 (action_templates) and bucket 2 (skip_senders) deterministically
 * without ever spawning a container. Only the residual emails — solicited /
 * personal-outreach / unsolicited — get enqueued as an agent-driven once-task
 * with the candidate list embedded in the prompt.
 *
 * Side effects done host-side: MS365 task creation (Graph REST), sidecar
 * write, decisions.jsonl append, progress.yaml update. Zero LLM tokens until
 * we hand off to the agent (and then only for the residual).
 */
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import YAML from 'yaml';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { createTask } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { getMs365AccessToken } from './ms365-reconciler.js';
import { RegisteredGroup } from './types.js';

export interface EmailPreclassifierDeps {
  cronExpressions: string[]; // one cron expr per scheduled fire (e.g., 7am, 4:30pm)
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

// ===== Config types =====

interface ActionTemplate {
  name: string;
  match: {
    from_address?: string;
    from_domain?: string;
    subject_contains?: string[];
  };
  create_task?: {
    title: string;
    folder: string;
    due_offset_days?: number;
  };
  skip?: boolean;
}

interface SkipSender {
  from_address?: string;
  from_domain?: string;
  folder: string;
}

interface Override {
  email_id: string;
  decision: 'task' | 'skip' | 'label-only';
  sort_folder?: string;
  reasoning?: string;
}

interface Classification {
  action_templates: ActionTemplate[];
  skip_senders: SkipSender[];
  overrides: Override[];
}

// ===== Email types =====

interface EmailMinimal {
  id: string;
  account: 'gmail' | 'outlook';
  from: string;
  subject: string;
  conversationId?: string;
  receivedIso?: string;
}

interface LlmCandidate extends EmailMinimal {
  bucket_hint: 'solicited' | 'outreach_check' | 'unsolicited_check';
  /** Pre-fetched plain-text body (capped to MAX_BODY_CHARS, HTML stripped).
   *  Inlined in the residual agent prompt so the agent doesn't spend tool
   *  calls on body fetches. */
  body?: string;
}

const MAX_BODY_CHARS = 3000;

interface ScanOutcome {
  scan_run_id: string;
  scanned: number;
  template_tasks: number;
  template_skips: number;
  skip_sender_count: number;
  llm_candidates: LlmCandidate[];
  errors: string[];
}

// ===== Parse helpers =====

function loadYamlFile<T>(p: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = YAML.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function loadClassification(mainFolder: string): Classification {
  const p = path.join(
    GROUPS_DIR,
    mainFolder,
    'email-archive',
    'classification.yaml',
  );
  const data = loadYamlFile<Partial<Classification>>(p, {});
  return {
    action_templates: Array.isArray(data.action_templates)
      ? data.action_templates
      : [],
    skip_senders: Array.isArray(data.skip_senders) ? data.skip_senders : [],
    overrides: Array.isArray(data.overrides) ? data.overrides : [],
  };
}

function loadInstitutions(mainFolder: string): Set<string> {
  const p = path.join(
    GROUPS_DIR,
    mainFolder,
    'email-archive',
    'institutions.yaml',
  );
  const data = loadYamlFile<{ institutions?: string[] }>(p, {});
  return new Set(
    (data.institutions || []).map((s) => String(s).toLowerCase().trim()),
  );
}

function loadKnownContacts(mainFolder: string): Set<string> {
  const p = path.join(
    GROUPS_DIR,
    mainFolder,
    'email-archive',
    'known_contacts.yaml',
  );
  const data = loadYamlFile<{ known_contacts?: string[] }>(p, {});
  return new Set(
    (data.known_contacts || []).map((s) => String(s).toLowerCase().trim()),
  );
}

interface Progress {
  last_scan_date?: { gmail?: string; outlook?: string };
  last_scan_run_id?: string;
}

function loadProgress(mainFolder: string): Progress {
  const p = path.join(
    GROUPS_DIR,
    mainFolder,
    'email-triage',
    'state',
    'progress.yaml',
  );
  return loadYamlFile<Progress>(p, {});
}

function writeProgress(mainFolder: string, prog: Progress): void {
  const dir = path.join(GROUPS_DIR, mainFolder, 'email-triage', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'progress.yaml'),
    YAML.stringify(prog, { lineWidth: 0 }),
  );
}

// ===== Pending-residuals carryover =====
//
// Candidates that the preclassifier hands off to the agent are recorded
// here so that if a batch times out, errors, or otherwise fails to log a
// decision, the orphaned entries get carried into the NEXT scan and
// reclassified. The file is rewritten on every scan — entries with a
// matching decision in decisions.jsonl are dropped, unresolved entries
// stay, and this scan's residuals are appended.

interface PendingResidual {
  scan_run_id: string;
  email_id: string;
  account: 'gmail' | 'outlook';
  from: string;
  subject: string;
  handoff_ts: string;
}

function pendingResidualsPath(mainFolder: string): string {
  return path.join(
    GROUPS_DIR,
    mainFolder,
    'email-triage',
    'state',
    'pending_residuals.jsonl',
  );
}

function loadPendingResiduals(mainFolder: string): PendingResidual[] {
  const p = pendingResidualsPath(mainFolder);
  if (!fs.existsSync(p)) return [];
  const out: PendingResidual[] = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as PendingResidual);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function writePendingResiduals(
  mainFolder: string,
  entries: PendingResidual[],
): void {
  const p = pendingResidualsPath(mainFolder);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body =
    entries.map((e) => JSON.stringify(e)).join('\n') +
    (entries.length > 0 ? '\n' : '');
  fs.writeFileSync(p, body);
}

/**
 * Collect every `email_id` that has a decision logged in the last `daysBack`
 * days. Cheap because decisions.jsonl is append-only and small relative to
 * the scan workload.
 */
function loadResolvedEmailIds(mainFolder: string, daysBack = 30): Set<string> {
  const p = path.join(
    GROUPS_DIR,
    mainFolder,
    'email-triage',
    'state',
    'decisions.jsonl',
  );
  const out = new Set<string>();
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
      /* skip */
    }
  }
  return out;
}

interface EmailAccount {
  id: string;
  type: 'gws' | 'ms365' | 'imap';
  address?: string;
  enabled?: boolean;
}

function loadAccounts(mainFolder: string): EmailAccount[] {
  const p = path.join(GROUPS_DIR, mainFolder, 'email-accounts.yaml');
  const data = loadYamlFile<{ accounts?: EmailAccount[] }>(p, {});
  return (data.accounts || []).filter((a) => a.enabled !== false);
}

interface Taxonomy {
  folders: string[];
  context: Record<string, string>;
}

function loadTaxonomy(mainFolder: string): Taxonomy {
  const p = path.join(GROUPS_DIR, mainFolder, 'email-archive', 'config.yaml');
  const data = loadYamlFile<{
    taxonomy?: string[];
    taxonomy_context?: Record<string, string>;
  }>(p, {});
  return {
    folders: data.taxonomy || [],
    context: data.taxonomy_context || {},
  };
}

// ===== Email listing =====

import { execFileSync } from 'child_process';
const GWS_BIN = process.env.GWS_BIN || '/opt/homebrew/bin/gws';

function listGmail(sinceIso: string | null): EmailMinimal[] {
  const q = sinceIso
    ? `in:inbox after:${Math.floor(new Date(sinceIso).getTime() / 1000)}`
    : 'in:inbox newer_than:1d';
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
        JSON.stringify({ userId: 'me', q, maxResults: 50 }),
        '--format',
        'json',
      ],
      {
        encoding: 'utf-8',
        env: { ...process.env, GWS_CREDENTIAL_STORE: 'plaintext' },
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const parsed = JSON.parse(listOut) as { messages?: Array<{ id: string }> };
    ids = (parsed.messages || []).map((m) => m.id);
  } catch (err) {
    logger.debug({ err }, 'email-preclassifier: gmail list failed');
    return [];
  }

  const out: EmailMinimal[] = [];
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
            metadataHeaders: ['From', 'Subject', 'Date'],
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
        threadId?: string;
        internalDate?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      };
      const headers = msg.payload?.headers || [];
      const header = (n: string): string =>
        headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ||
        '';
      out.push({
        id,
        account: 'gmail',
        from: header('From'),
        subject: header('Subject'),
        conversationId: msg.threadId,
        receivedIso: msg.internalDate
          ? new Date(parseInt(msg.internalDate, 10)).toISOString()
          : undefined,
      });
    } catch {
      /* per-message failure is fine */
    }
  }
  return out;
}

/** Strip HTML tags, decode common entities, collapse whitespace, cap length. */
function normalizeBody(raw: string): string {
  const noTags = raw
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const decoded = noTags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const collapsed = decoded.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_BODY_CHARS
    ? collapsed.slice(0, MAX_BODY_CHARS) + '…'
    : collapsed;
}

/** Gmail body fetch via gws (format=full). Prefers text/plain; falls back
 *  to HTML-stripped text/html. */
function fetchGmailBody(id: string): string {
  try {
    const out = execFileSync(
      GWS_BIN,
      [
        'gmail',
        'users',
        'messages',
        'get',
        '--params',
        JSON.stringify({ userId: 'me', id, format: 'full' }),
        '--format',
        'json',
      ],
      {
        encoding: 'utf-8',
        env: { ...process.env, GWS_CREDENTIAL_STORE: 'plaintext' },
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const msg = JSON.parse(out) as {
      payload?: {
        mimeType?: string;
        body?: { data?: string };
        parts?: Array<{
          mimeType?: string;
          body?: { data?: string };
          parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
        }>;
      };
      snippet?: string;
    };
    const decodePart = (d?: string): string => {
      if (!d) return '';
      try {
        return Buffer.from(
          d.replace(/-/g, '+').replace(/_/g, '/'),
          'base64',
        ).toString('utf-8');
      } catch {
        return '';
      }
    };
    const walk = (
      node:
        | { mimeType?: string; body?: { data?: string }; parts?: unknown }
        | undefined,
      type: 'text/plain' | 'text/html',
    ): string => {
      if (!node) return '';
      const n = node as {
        mimeType?: string;
        body?: { data?: string };
        parts?: Array<unknown>;
      };
      if (n.mimeType === type && n.body?.data) return decodePart(n.body.data);
      if (Array.isArray(n.parts)) {
        for (const part of n.parts) {
          const found = walk(part as typeof n, type);
          if (found) return found;
        }
      }
      return '';
    };
    const plain = walk(msg.payload, 'text/plain');
    if (plain) return normalizeBody(plain);
    const html = walk(msg.payload, 'text/html');
    if (html) return normalizeBody(html);
    return (msg.snippet || '').slice(0, MAX_BODY_CHARS);
  } catch (err) {
    logger.debug({ err, id }, 'email-preclassifier: gmail body fetch failed');
    return '';
  }
}

async function fetchOutlookBody(token: string, id: string): Promise<string> {
  try {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${id}?$select=body,bodyPreview`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return '';
    const body = (await r.json()) as {
      body?: { contentType?: string; content?: string };
      bodyPreview?: string;
    };
    const raw = body.body?.content || body.bodyPreview || '';
    return normalizeBody(raw);
  } catch (err) {
    logger.debug({ err, id }, 'email-preclassifier: outlook body fetch failed');
    return '';
  }
}

async function listOutlook(sinceIso: string | null): Promise<EmailMinimal[]> {
  const token = await getMs365AccessToken();
  if (!token) return [];
  const filter = sinceIso ? `receivedDateTime ge ${sinceIso}` : undefined;
  const params = new URLSearchParams({
    $select: 'id,subject,from,conversationId,receivedDateTime',
    $top: '50',
    $orderby: 'receivedDateTime desc',
  });
  if (filter) params.set('$filter', filter);
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?${params}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      logger.debug(
        { status: r.status },
        'email-preclassifier: outlook list failed',
      );
      return [];
    }
    const body = (await r.json()) as {
      value?: Array<{
        id: string;
        subject?: string;
        from?: { emailAddress?: { address?: string } };
        conversationId?: string;
        receivedDateTime?: string;
      }>;
    };
    return (body.value || []).map((m) => ({
      id: m.id,
      account: 'outlook' as const,
      from: m.from?.emailAddress?.address || '',
      subject: m.subject || '',
      conversationId: m.conversationId,
      receivedIso: m.receivedDateTime,
    }));
  } catch (err) {
    logger.debug({ err }, 'email-preclassifier: outlook fetch threw');
    return [];
  }
}

// ===== Classification =====

function senderMatches(
  from: string,
  matchAddress?: string,
  matchDomain?: string,
): boolean {
  const f = from.toLowerCase();
  if (matchAddress && f.includes(matchAddress.toLowerCase())) return true;
  if (matchDomain) {
    const at = f.lastIndexOf('@');
    if (at >= 0) {
      const domain = f.slice(at + 1).replace(/[>\s].*$/, '');
      if (domain.endsWith(matchDomain.toLowerCase())) return true;
    }
  }
  return false;
}

function matchActionTemplate(
  email: EmailMinimal,
  templates: ActionTemplate[],
): ActionTemplate | null {
  const subjectLower = (email.subject || '').toLowerCase();
  for (const t of templates) {
    const senderHit = senderMatches(
      email.from,
      t.match.from_address,
      t.match.from_domain,
    );
    if (!senderHit) continue;
    const needles = t.match.subject_contains || [];
    if (needles.length === 0) return t; // sender-only template
    for (const needle of needles) {
      if (subjectLower.includes(String(needle).toLowerCase())) return t;
    }
  }
  return null;
}

function matchSkipSender(
  email: EmailMinimal,
  rules: SkipSender[],
): SkipSender | null {
  for (const r of rules) {
    if (senderMatches(email.from, r.from_address, r.from_domain)) return r;
  }
  return null;
}

function bucketHintFor(
  email: EmailMinimal,
  institutions: Set<string>,
  contacts: Set<string>,
): LlmCandidate['bucket_hint'] {
  const from = email.from.toLowerCase();
  const bareAddr = from.match(/[a-z0-9._%+-]+@[a-z0-9.-]+/)?.[0] || from;
  if (contacts.has(bareAddr)) return 'solicited';
  const at = bareAddr.lastIndexOf('@');
  if (at >= 0) {
    const domain = bareAddr.slice(at + 1);
    if (institutions.has(domain)) return 'solicited';
    // Match on parent domain too (e.g., foo.clemson.edu → clemson.edu)
    const parts = domain.split('.');
    for (let i = 1; i < parts.length; i++) {
      if (institutions.has(parts.slice(i).join('.'))) return 'solicited';
    }
  }
  return 'outreach_check';
}

// ===== Side effects =====

async function getDefaultTodoListId(token: string): Promise<string | null> {
  try {
    const r = await fetch('https://graph.microsoft.com/v1.0/me/todo/lists', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as {
      value?: Array<{
        id: string;
        displayName?: string;
        wellknownListName?: string;
      }>;
    };
    const lists = body.value || [];
    const preferred =
      lists.find((l) => l.wellknownListName === 'defaultList') ||
      lists.find((l) => l.displayName === 'Tasks') ||
      lists[0];
    return preferred?.id ?? null;
  } catch {
    return null;
  }
}

async function createMs365Task(
  token: string,
  listId: string,
  title: string,
  dueIsoLocal?: string,
): Promise<string | null> {
  const body: Record<string, unknown> = {
    title,
    body: { content: '', contentType: 'text' },
    importance: 'normal',
  };
  if (dueIsoLocal) {
    body.dueDateTime = { dateTime: dueIsoLocal, timeZone: TIMEZONE };
  }
  try {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      logger.warn(
        { status: r.status, title },
        'email-preclassifier: todo task creation failed',
      );
      return null;
    }
    const created = (await r.json()) as { id?: string };
    return created.id ?? null;
  } catch (err) {
    logger.warn({ err }, 'email-preclassifier: todo task creation threw');
    return null;
  }
}

function computeDueIsoLocal(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  // Skip weekends — Sat → Mon, Sun → Mon
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  // Graph wants "YYYY-MM-DDTHH:mm:ss" without trailing Z when a timezone is set
  return d.toISOString().slice(0, 19);
}

function writeSidecar(
  mainFolder: string,
  taskId: string,
  meta: Record<string, string | undefined>,
): void {
  const dir = path.join(GROUPS_DIR, mainFolder, 'email-triage', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'tasks.json');
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

function appendDecision(
  mainFolder: string,
  entry: Record<string, unknown>,
): void {
  const dir = path.join(GROUPS_DIR, mainFolder, 'email-triage', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, 'decisions.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
  );
}

function substituteTitle(template: string, email: EmailMinimal): string {
  return template.replace(/\{subject\}/g, email.subject);
}

function buildCleanTitle(
  raw: string,
  account: 'gmail' | 'outlook',
  folder: string,
): string {
  const shortAccount = account === 'gmail' ? 'gmail' : 'outlook';
  return `${raw} → /${shortAccount}/${folder}`;
}

// ===== Main pass =====

async function runPreclassification(mainFolder: string): Promise<ScanOutcome> {
  const scanRunId = new Date().toISOString();
  const outcome: ScanOutcome = {
    scan_run_id: scanRunId,
    scanned: 0,
    template_tasks: 0,
    template_skips: 0,
    skip_sender_count: 0,
    llm_candidates: [],
    errors: [],
  };

  const accounts = loadAccounts(mainFolder);
  if (accounts.length === 0) return outcome;
  const classification = loadClassification(mainFolder);
  const institutions = loadInstitutions(mainFolder);
  const contacts = loadKnownContacts(mainFolder);
  const progress = loadProgress(mainFolder);

  // Carryover: unresolved residuals from prior scans. These live in
  // pending_residuals.jsonl. Any entry whose email_id now has a decision
  // logged is considered resolved and dropped; the remainder come forward.
  const pendingPrev = loadPendingResiduals(mainFolder);
  const resolvedIds = loadResolvedEmailIds(mainFolder, 30);
  const carryover = pendingPrev.filter((e) => !resolvedIds.has(e.email_id));

  // Collect new mail
  const freshEmails: EmailMinimal[] = [];
  for (const acc of accounts) {
    if (acc.type === 'gws') {
      freshEmails.push(...listGmail(progress.last_scan_date?.gmail ?? null));
    } else if (acc.type === 'ms365') {
      freshEmails.push(
        ...(await listOutlook(progress.last_scan_date?.outlook ?? null)),
      );
    }
  }

  // De-dupe: if the same id is in both carryover and fresh (e.g., a thread
  // reply reappeared within the scan window), the fresh version wins.
  const freshIds = new Set(freshEmails.map((e) => e.id));
  const carryoverAsEmails: EmailMinimal[] = carryover
    .filter((c) => !freshIds.has(c.email_id))
    .map((c) => ({
      id: c.email_id,
      account: c.account,
      from: c.from,
      subject: c.subject,
    }));
  const emails: EmailMinimal[] = [...carryoverAsEmails, ...freshEmails];

  outcome.scanned = emails.length;
  if (emails.length === 0) {
    writeProgress(mainFolder, {
      ...progress,
      last_scan_date: {
        gmail: new Date().toISOString(),
        outlook: new Date().toISOString(),
      },
      last_scan_run_id: scanRunId,
    });
    // No new mail AND no carryover — clear the pending file.
    writePendingResiduals(mainFolder, []);
    return outcome;
  }
  if (carryoverAsEmails.length > 0) {
    logger.info(
      {
        carryover: carryoverAsEmails.length,
        fresh: freshEmails.length,
      },
      'email-preclassifier: carried unresolved residuals into this scan',
    );
  }

  // Only fetch the MS365 token + list id once, and only if we're going to
  // need to create any MS365 tasks.
  let ms365Token: string | null = null;
  let ms365ListId: string | null = null;
  const ensureMs365 = async (): Promise<boolean> => {
    if (ms365Token && ms365ListId) return true;
    ms365Token = await getMs365AccessToken();
    if (!ms365Token) return false;
    ms365ListId = await getDefaultTodoListId(ms365Token);
    return Boolean(ms365ListId);
  };

  const overrideById = new Map(
    classification.overrides.map((o) => [o.email_id, o]),
  );

  for (const email of emails) {
    // Override first
    const override = overrideById.get(email.id);
    if (override) {
      appendDecision(mainFolder, {
        scan_run_id: scanRunId,
        email_id: email.id,
        account: email.account,
        sender: email.from,
        subject: (email.subject || '').slice(0, 120),
        pass: 'override',
        decision: override.decision,
        sort_folder: override.sort_folder ?? null,
        rule_matched: `override:${email.id}`,
        reasoning: override.reasoning ?? null,
        task_id_created: null,
        model_used: null,
      });
      continue;
    }

    // Bucket 1 — action_templates
    const tpl = matchActionTemplate(email, classification.action_templates);
    if (tpl) {
      if (tpl.skip) {
        outcome.template_skips += 1;
        appendDecision(mainFolder, {
          scan_run_id: scanRunId,
          email_id: email.id,
          account: email.account,
          sender: email.from,
          subject: (email.subject || '').slice(0, 120),
          pass: 'template',
          decision: 'skip',
          sort_folder: null,
          rule_matched: tpl.name,
          reasoning: 'action_template skip rule',
          task_id_created: null,
          model_used: null,
        });
        continue;
      }
      if (tpl.create_task) {
        if (!(await ensureMs365())) {
          outcome.errors.push(
            `template_${tpl.name}: MS365 token unavailable — falling back to LLM path`,
          );
          outcome.llm_candidates.push({
            ...email,
            bucket_hint: 'solicited',
          });
          continue;
        }
        const rawTitle = substituteTitle(tpl.create_task.title, email);
        const cleanTitle = buildCleanTitle(
          rawTitle,
          email.account,
          tpl.create_task.folder,
        );
        const due =
          typeof tpl.create_task.due_offset_days === 'number'
            ? computeDueIsoLocal(tpl.create_task.due_offset_days)
            : undefined;
        const taskId = await createMs365Task(
          ms365Token!,
          ms365ListId!,
          cleanTitle,
          due,
        );
        if (!taskId) {
          outcome.errors.push(
            `template_${tpl.name}: create-task failed for ${email.subject}`,
          );
          // Don't drop the email on the floor — let LLM handle it
          outcome.llm_candidates.push({
            ...email,
            bucket_hint: 'solicited',
          });
          continue;
        }
        writeSidecar(mainFolder, taskId, {
          email_id: email.id,
          account: email.account,
          from: email.from,
          subject: email.subject,
          folder: tpl.create_task.folder,
        });
        outcome.template_tasks += 1;
        appendDecision(mainFolder, {
          scan_run_id: scanRunId,
          email_id: email.id,
          account: email.account,
          sender: email.from,
          subject: (email.subject || '').slice(0, 120),
          pass: 'template',
          decision: 'task',
          sort_folder: tpl.create_task.folder,
          rule_matched: tpl.name,
          reasoning: `action_template create_task (${tpl.name})`,
          task_id_created: taskId,
          model_used: null,
        });
        continue;
      }
    }

    // Bucket 2 — skip_senders
    const skip = matchSkipSender(email, classification.skip_senders);
    if (skip) {
      outcome.skip_sender_count += 1;
      appendDecision(mainFolder, {
        scan_run_id: scanRunId,
        email_id: email.id,
        account: email.account,
        sender: email.from,
        subject: (email.subject || '').slice(0, 120),
        pass: 'skip',
        decision: 'skip',
        sort_folder: skip.folder,
        rule_matched: `skip_senders:${skip.from_address || skip.from_domain}`,
        reasoning: null,
        task_id_created: null,
        model_used: null,
      });
      continue;
    }

    // Residual — LLM candidate
    outcome.llm_candidates.push({
      ...email,
      bucket_hint: bucketHintFor(email, institutions, contacts),
    });
  }

  writeProgress(mainFolder, {
    ...progress,
    last_scan_date: {
      gmail: new Date().toISOString(),
      outlook: new Date().toISOString(),
    },
    last_scan_run_id: scanRunId,
  });

  // Pre-fetch bodies for every residual and embed them in the handoff
  // prompt. Saves one `get-mail-message` / `gws gmail get` tool call per
  // email inside the agent — those were eating minutes per batch. Bodies
  // are host-fetched host-side (gws CLI for Gmail, Graph REST for Outlook),
  // normalized, and capped to MAX_BODY_CHARS.
  if (outcome.llm_candidates.length > 0) {
    const outlookToken = outcome.llm_candidates.some(
      (c) => c.account === 'outlook',
    )
      ? await getMs365AccessToken()
      : null;
    for (const c of outcome.llm_candidates) {
      if (c.account === 'gmail') {
        c.body = fetchGmailBody(c.id);
      } else if (c.account === 'outlook' && outlookToken) {
        c.body = await fetchOutlookBody(outlookToken, c.id);
      }
    }
    const bodiesFetched = outcome.llm_candidates.filter((c) => c.body).length;
    logger.info(
      {
        candidates: outcome.llm_candidates.length,
        bodiesFetched,
        totalBodyChars: outcome.llm_candidates.reduce(
          (n, c) => n + (c.body?.length || 0),
          0,
        ),
      },
      'email-preclassifier: pre-fetched bodies for residual handoff',
    );
  }

  // Record this scan's residuals as pending. If the agent handles them
  // cleanly, decisions.jsonl will catch up and the next scan's resolved-ids
  // filter will drop them. If the agent fails mid-batch, whatever is
  // unresolved rides into the next scan as carryover.
  const pendingThisScan: PendingResidual[] = outcome.llm_candidates.map(
    (c) => ({
      scan_run_id: scanRunId,
      email_id: c.id,
      account: c.account,
      from: c.from,
      subject: c.subject,
      handoff_ts: new Date().toISOString(),
    }),
  );
  writePendingResiduals(mainFolder, pendingThisScan);

  return outcome;
}

// ===== Presentation =====

function formatPreHandoffSummary(o: ScanOutcome): string {
  if (o.scanned === 0) return 'No new mail since last scan.';
  const parts = [`📬 Email Taskfinder — ${o.scan_run_id}`, ''];
  parts.push(
    `Scanned: ${o.scanned}   Pre-resolved: ${o.template_tasks + o.template_skips + o.skip_sender_count}   LLM queue: ${o.llm_candidates.length}`,
  );
  const line: string[] = [];
  if (o.template_tasks) line.push(`Templated→task: ${o.template_tasks}`);
  if (o.template_skips) line.push(`Templated→skip: ${o.template_skips}`);
  if (o.skip_sender_count) line.push(`Skip-rule: ${o.skip_sender_count}`);
  if (line.length) parts.push(line.join('   '));
  if (o.errors.length) {
    parts.push('', 'Errors:');
    for (const e of o.errors.slice(0, 5)) parts.push(`  • ${e}`);
  }
  return parts.join('\n');
}

function formatNoCandidatesFinal(o: ScanOutcome): string {
  return formatPreHandoffSummary(o);
}

// ===== Hand-off to agent =====

// Cap per agent-turn to stay under Codex 300s timeout. 14 in one turn blew
// the budget even with bodies pre-fetched; 8 leaves headroom for reasoning
// and tool calls per email. If this too proves too tight, drop to 5.
const RESIDUAL_BATCH_SIZE = 8;

function buildAgentPrompt(
  o: ScanOutcome,
  candidates: LlmCandidate[],
  batchIndex: number,
  batchCount: number,
): string {
  const batchLabel =
    batchCount > 1 ? ` (batch ${batchIndex + 1}/${batchCount})` : '';
  const isLastBatch = batchIndex === batchCount - 1;
  const header = [
    `/email-taskfinder scan${batchLabel}`,
    ``,
    `Host-side pre-classification already handled bucket 1 (action_templates)`,
    `and bucket 2 (skip_senders) for this scan. YOUR job is only buckets 3/4/5`,
    `(solicited / personal-outreach / unsolicited) on the candidates below.`,
    ``,
    `scan_run_id: ${o.scan_run_id}${batchCount > 1 ? `  batch: ${batchIndex + 1}/${batchCount}` : ''}`,
    `pre_resolved (whole scan): ${o.template_tasks + o.template_skips + o.skip_sender_count}`,
    `llm_candidates in THIS batch: ${candidates.length}${batchCount > 1 ? ` of ${o.llm_candidates.length} total` : ''}`,
    ``,
    `Candidates (bucket_hint is what the host thinks — verify, don't trust blindly):`,
  ].join('\n');
  const rows = candidates
    .map((c, i) => {
      const header = `${i + 1}. [${c.account}] from=${c.from}  subject="${(c.subject || '').slice(0, 120)}"  id=${c.id}  hint=${c.bucket_hint}`;
      const bodyBlock = c.body
        ? `\n    body: ${c.body}`
        : `\n    body: (host body-fetch failed — fetch via MCP if needed)`;
      return header + bodyBlock;
    })
    .join('\n\n');
  const perEmailRule = [
    ``,
    `TREAT EACH EMAIL INDEPENDENTLY. Classification of one email must not`,
    `influence another — each is a standalone decision. Do not batch reasoning`,
    `across them. Do not carry narrative from one email into the next.`,
    ``,
    `Bodies are already inlined above (plain text, capped ~3000 chars). DO NOT`,
    `call ms365/get-mail-message or gws gmail get to re-fetch them unless the`,
    `body says "(host body-fetch failed …)".`,
  ].join('\n');
  const summaryInstruction = isLastBatch
    ? [
        ``,
        `Write ONE final summary via send_message (this is the LAST batch). Format:`,
        `  📬 Email Taskfinder — ${o.scan_run_id}`,
        ``,
        `  Scanned: ${o.scanned}   Tasks created: <total including pre-resolved>`,
        `  Pre-resolved: ${o.template_tasks + o.template_skips + o.skip_sender_count}  (templated→task=${o.template_tasks}, templated→skip=${o.template_skips}, skip-rule=${o.skip_sender_count})`,
        `  LLM buckets: solicited→task/skip: N/N   outreach→task/skip: N/N   unsolicited(labeled): N`,
      ].join('\n')
    : [
        ``,
        `This is batch ${batchIndex + 1}/${batchCount}. DO NOT send a chat summary.`,
        `The final batch will post one summary covering all batches. Just process`,
        `your candidates, log decisions, create tasks, and exit silently.`,
      ].join('\n');
  const footer = [
    ``,
    `Fetch bodies ONE AT A TIME for the candidates you decide to classify.`,
    `Skip bucket 1/2 work — the host already did it. DO NOT re-check skip_senders`,
    `or action_templates. DO NOT re-list inbox mail.`,
    ``,
    `Log one log_triage_decision per candidate (scan_run_id=${o.scan_run_id}).`,
    summaryInstruction,
  ].join('\n');
  return `${header}\n${rows}${perEmailRule}\n${footer}`;
}

function chunkCandidates(all: LlmCandidate[]): LlmCandidate[][] {
  if (all.length === 0) return [];
  const chunks: LlmCandidate[][] = [];
  for (let i = 0; i < all.length; i += RESIDUAL_BATCH_SIZE) {
    chunks.push(all.slice(i, i + RESIDUAL_BATCH_SIZE));
  }
  return chunks;
}

// ===== Direct-API classification (host-side, one call per email) =====

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const CLASSIFIER_MODEL = process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-5.4-mini';

interface ClassificationResult {
  needs_task: boolean;
  sort_folder: string;
  task_title: string; // concise, MUST include sender's first name or org
  reasoning: string;
}

function getOpenAiApiKey(): string | null {
  // Prefer .env (canonical) then process.env fallback.
  const fromFile = readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY;
  return fromFile || process.env.OPENAI_API_KEY || null;
}

async function classifyEmailWithApi(
  email: LlmCandidate,
  taxonomy: Taxonomy,
): Promise<ClassificationResult | null> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;

  const folderBullets = taxonomy.folders
    .map((f) => {
      const hint = taxonomy.context[f];
      return hint ? `  ${f} — ${hint}` : `  ${f}`;
    })
    .join('\n');

  const systemMsg = [
    "You classify email for Chip's inbox. For each email decide three things:",
    '',
    '1) needs_task (bool): true ONLY if the email creates a real obligation,',
    '   concrete deadline, action from someone with standing authority,',
    '   contract/billing/legal/payroll/benefits/school/medical/government',
    '   consequence, calendar/date-dependent ask, or is tied to an existing',
    '   project/account/application. Default: false. Test: "Will anything bad',
    '   happen if Chip does nothing?" If no → false.',
    '',
    '2) sort_folder (string): which archive folder this email will eventually',
    '   be filed into. REQUIRED even when needs_task=false. Pick EXACTLY one',
    '   value from the taxonomy below.',
    '',
    '3) task_title (string): a short title for the to-do list, 4–10 words,',
    "   that starts with an action verb AND includes the sender's first name",
    '   (or their organization when no person is named). NEVER use generic',
    '   language like "The student is requesting…" or "A vendor is asking…"',
    '   — always name the person or org. Examples:',
    '     "Reply to Tyne about summer proposal"',
    '     "Review Bronwyn course substitution request"',
    '     "Approve Tyson invoice #12345"',
    '   Even when needs_task=false, still emit a title so the log is useful.',
    '',
    'Taxonomy:',
    folderBullets,
    '',
    'Return JSON only: {"needs_task": <bool>, "sort_folder": "<exact folder>", "task_title": "<named, action-verb-first>", "reasoning": "<one concise sentence, also naming the sender>"}',
  ].join('\n');

  const userMsg = [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Hint: ${email.bucket_hint}`,
    `Body: ${email.body || '(no body; classify from sender+subject)'}`,
  ].join('\n');

  try {
    const r = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userMsg },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 300,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      logger.warn(
        { status: r.status, body: body.slice(0, 200), emailId: email.id },
        'classify-api: non-200',
      );
      return null;
    }
    const resp = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = resp.choices?.[0]?.message?.content;
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<ClassificationResult>;
    return {
      needs_task: Boolean(parsed.needs_task),
      sort_folder: String(parsed.sort_folder || 'To Delete'),
      task_title: String(parsed.task_title || '').slice(0, 120),
      reasoning: String(parsed.reasoning || '').slice(0, 500),
    };
  } catch (err) {
    logger.warn({ err, emailId: email.id }, 'classify-api: threw');
    return null;
  }
}

/** Run each residual through the direct-API classifier, create MS365 tasks
 *  for needs_task=true, and append decisions. Returns counts for the summary.
 *  Any email whose API call fails stays in pending_residuals.jsonl for the
 *  next scan to retry. */
async function processResidualsWithApi(
  mainFolder: string,
  outcome: ScanOutcome,
  scanRunId: string,
): Promise<{
  apiTaskCount: number;
  apiSkipCount: number;
  apiFailureCount: number;
  tasksCreated: Array<{ title: string; folder: string }>;
}> {
  const taxonomy = loadTaxonomy(mainFolder);
  let ms365Token: string | null = null;
  let ms365ListId: string | null = null;
  const ensureMs365 = async (): Promise<boolean> => {
    if (ms365Token && ms365ListId) return true;
    ms365Token = await getMs365AccessToken();
    if (!ms365Token) return false;
    ms365ListId = await getDefaultTodoListId(ms365Token);
    return Boolean(ms365ListId);
  };

  let apiTaskCount = 0;
  let apiSkipCount = 0;
  let apiFailureCount = 0;
  const tasksCreated: Array<{ title: string; folder: string }> = [];

  for (const email of outcome.llm_candidates) {
    const result = await classifyEmailWithApi(email, taxonomy);
    if (!result) {
      apiFailureCount += 1;
      // Don't log a decision — that would mark the email resolved and
      // exclude it from carryover. Leave it in pending_residuals for retry.
      continue;
    }

    if (result.needs_task) {
      if (!(await ensureMs365())) {
        logger.warn(
          { emailId: email.id },
          'classify-api: no MS365 token — leaving email in pending for retry',
        );
        apiFailureCount += 1;
        continue;
      }
      // Prefer the LLM's task_title (which is required to include the
      // sender's name). Fall back to reasoning → subject if absent.
      const rawTitle =
        result.task_title ||
        result.reasoning.split('.')[0].slice(0, 80) ||
        `Review: ${email.subject}`;
      const cleanTitle = buildCleanTitle(
        rawTitle,
        email.account,
        result.sort_folder,
      );
      const taskId = await createMs365Task(
        ms365Token!,
        ms365ListId!,
        cleanTitle,
      );
      if (!taskId) {
        apiFailureCount += 1;
        continue;
      }
      writeSidecar(mainFolder, taskId, {
        email_id: email.id,
        account: email.account,
        from: email.from,
        subject: email.subject,
        folder: result.sort_folder,
      });
      apiTaskCount += 1;
      tasksCreated.push({ title: cleanTitle, folder: result.sort_folder });
      appendDecision(mainFolder, {
        scan_run_id: scanRunId,
        email_id: email.id,
        account: email.account,
        sender: email.from,
        subject: (email.subject || '').slice(0, 120),
        pass: 'api-classifier',
        decision: 'task',
        sort_folder: result.sort_folder,
        rule_matched: email.bucket_hint,
        reasoning: result.reasoning,
        task_id_created: taskId,
        model_used: CLASSIFIER_MODEL,
      });
    } else {
      apiSkipCount += 1;
      appendDecision(mainFolder, {
        scan_run_id: scanRunId,
        email_id: email.id,
        account: email.account,
        sender: email.from,
        subject: (email.subject || '').slice(0, 120),
        pass: 'api-classifier',
        decision: 'skip',
        sort_folder: result.sort_folder,
        rule_matched: email.bucket_hint,
        reasoning: result.reasoning,
        task_id_created: null,
        model_used: CLASSIFIER_MODEL,
      });
    }
  }

  return { apiTaskCount, apiSkipCount, apiFailureCount, tasksCreated };
}

function formatFullSummary(
  outcome: ScanOutcome,
  api: {
    apiTaskCount: number;
    apiSkipCount: number;
    apiFailureCount: number;
    tasksCreated: Array<{ title: string; folder: string }>;
  },
): string {
  const preResolved =
    outcome.template_tasks + outcome.template_skips + outcome.skip_sender_count;
  const totalTasks = outcome.template_tasks + api.apiTaskCount;
  const parts = [
    `📬 Email Taskfinder — ${outcome.scan_run_id}`,
    '',
    `Scanned: ${outcome.scanned}   Tasks created: ${totalTasks}`,
    `Pre-resolved: ${preResolved}  (templated→task=${outcome.template_tasks}, templated→skip=${outcome.template_skips}, skip-rule=${outcome.skip_sender_count})`,
    `LLM-classified: ${outcome.llm_candidates.length}  (task=${api.apiTaskCount}, skip=${api.apiSkipCount}${api.apiFailureCount > 0 ? `, failed=${api.apiFailureCount}` : ''})`,
  ];
  if (api.tasksCreated.length > 0) {
    parts.push('');
    for (const t of api.tasksCreated.slice(0, 20)) {
      parts.push(`• ${t.title}`);
    }
    if (api.tasksCreated.length > 20) {
      parts.push(`…and ${api.tasksCreated.length - 20} more`);
    }
  }
  if (api.apiFailureCount > 0) {
    parts.push(
      '',
      `${api.apiFailureCount} email(s) couldn't be classified this scan — they stay in carryover for the next run.`,
    );
  }
  return parts.join('\n');
}

// ===== Cron wake loop =====

function nextFireMsForAny(
  exprs: string[],
): { ms: number; expr: string } | null {
  let earliest: { ms: number; expr: string } | null = null;
  for (const expr of exprs) {
    try {
      const interval = CronExpressionParser.parse(expr, { tz: TIMEZONE });
      const ms = interval.next().getTime() - Date.now();
      if (ms > 0 && (!earliest || ms < earliest.ms)) {
        earliest = { ms, expr };
      }
    } catch (err) {
      logger.warn(
        { expr, err },
        'email-preclassifier: invalid cron expr, skipping',
      );
    }
  }
  return earliest;
}

function findMainEntry(
  groups: Record<string, RegisteredGroup>,
): { jid: string; group: RegisteredGroup } | null {
  for (const [jid, g] of Object.entries(groups)) {
    if (g.isMain) return { jid, group: g };
  }
  return null;
}

/**
 * Single entry point used by BOTH the cron wake loop and the chat-triggered
 * `/email-taskfinder` handler. Runs the deterministic pre-classification,
 * and either sends a final summary (if zero residual) or enqueues a
 * residual-only agent task. Returns the outcome so callers can react.
 */
export async function triggerEmailPreclassifier(deps: {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  ackMessage?: string; // optional one-liner sent before scanning (chat trigger)
}): Promise<{ outcome: ScanOutcome | null; candidatesHandedOff: boolean }> {
  const main = findMainEntry(deps.registeredGroups());
  if (!main) {
    logger.warn('email-preclassifier: no main group registered — skipping');
    return { outcome: null, candidatesHandedOff: false };
  }
  if (deps.ackMessage) {
    try {
      await deps.sendMessage(main.jid, deps.ackMessage);
    } catch {
      /* non-fatal */
    }
  }
  const outcome = await runPreclassification(main.group.folder);
  if (outcome.llm_candidates.length === 0) {
    await deps.sendMessage(main.jid, formatNoCandidatesFinal(outcome));
    logger.info(
      {
        scanned: outcome.scanned,
        preResolved:
          outcome.template_tasks +
          outcome.template_skips +
          outcome.skip_sender_count,
      },
      'email-preclassifier: fully resolved host-side, no container spawned',
    );
    return { outcome, candidatesHandedOff: false };
  }

  // When OPENAI_API_KEY is present, classify residuals inline via direct API
  // calls (one per email, ~300ms each, no container spawn). This is the
  // preferred path — see scripts/trace-one-email.mjs for the reason Codex
  // containers aren't used here. If the key is missing we fall through to
  // the legacy agent-batch path.
  if (getOpenAiApiKey()) {
    const apiOutcome = await processResidualsWithApi(
      main.group.folder,
      outcome,
      outcome.scan_run_id,
    );
    await deps.sendMessage(main.jid, formatFullSummary(outcome, apiOutcome));
    logger.info(
      {
        scanned: outcome.scanned,
        preResolved:
          outcome.template_tasks +
          outcome.template_skips +
          outcome.skip_sender_count,
        apiTasks: apiOutcome.apiTaskCount,
        apiSkips: apiOutcome.apiSkipCount,
        apiFailures: apiOutcome.apiFailureCount,
        model: CLASSIFIER_MODEL,
      },
      'email-preclassifier: classified residuals via direct API',
    );
    return { outcome, candidatesHandedOff: false };
  }

  // Legacy agent-batch fallback (no OPENAI_API_KEY configured).
  const batches = chunkCandidates(outcome.llm_candidates);
  const fireBaseSec = 15;
  const perBatchSpacingSec = 30; // stagger so batches don't collide
  const scanBase = Date.now();
  batches.forEach((batch, idx) => {
    const prompt = buildAgentPrompt(outcome, batch, idx, batches.length);
    const fireAt = scanBase + (fireBaseSec + idx * perBatchSpacingSec) * 1000;
    const nextIso = new Date(fireAt).toISOString();
    createTask({
      id: `taskfinder-residual-${scanBase}-${idx + 1}of${batches.length}`,
      group_folder: main.group.folder,
      chat_jid: main.jid,
      prompt,
      schedule_type: 'once',
      schedule_value: nextIso,
      context_mode: 'isolated',
      next_run: nextIso,
      status: 'active',
      created_at: new Date().toISOString(),
    });
  });
  logger.info(
    {
      scanned: outcome.scanned,
      candidates: outcome.llm_candidates.length,
      batches: batches.length,
      batchSize: RESIDUAL_BATCH_SIZE,
      preResolved:
        outcome.template_tasks +
        outcome.template_skips +
        outcome.skip_sender_count,
    },
    'email-preclassifier: handed residual to agent in batches',
  );
  return { outcome, candidatesHandedOff: true };
}

export function startEmailPreclassifier(deps: EmailPreclassifierDeps): void {
  const fire = async (): Promise<void> => {
    try {
      await triggerEmailPreclassifier(deps);
    } catch (err) {
      logger.error({ err }, 'email-preclassifier: fire threw');
    }
  };

  const schedule = (): void => {
    const next = nextFireMsForAny(deps.cronExpressions);
    if (!next) {
      logger.warn('email-preclassifier: no valid cron expressions — disabling');
      return;
    }
    const nextMs = Math.max(1_000, Math.min(next.ms, 25 * 60 * 60 * 1000));
    logger.info(
      {
        expr: next.expr,
        nextAt: new Date(Date.now() + nextMs).toISOString(),
      },
      'email-preclassifier armed',
    );
    setTimeout(async () => {
      await fire();
      schedule();
    }, nextMs);
  };

  schedule();
}
