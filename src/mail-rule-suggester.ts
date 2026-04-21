/**
 * Mail-rule suggester.
 *
 * Reads `email-archive/rules.yaml` (built during archive calibration) and
 * proposes equivalent server-side filters/rules:
 *
 *   - **Gmail** — auto-creatable via `gws gmail users settings filters create`
 *     because the `gws` OAuth scope covers `gmail.settings.basic`. This
 *     module shells out to the host `gws` CLI and POSTs one filter per
 *     rule that isn't already present.
 *   - **Outlook / MS365** — the "GCassistant Office 365" Azure app
 *     doesn't have `MailboxSettings.ReadWrite` consented in the Clemson
 *     tenant. Instead of creating rules programmatically, we emit
 *     copy-paste-ready instructions for the user to enter into Outlook
 *     Web (outlook.office.com → Settings → Mail → Rules).
 *
 * Host-side, zero-LLM — the suggestions come from a deterministic read of
 * the archive's sender rules, not from model reasoning.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const GWS_BIN = process.env.GWS_BIN || '/opt/homebrew/bin/gws';

interface ArchiveRule {
  from_address?: string;
  from_domain?: string;
  folder: string;
  note?: string;
}

interface ArchiveConfig {
  gmailLabels: Record<string, string>; // "Sorted/X" → "Label_XX"
  outlookFolders: Record<string, string>; // "Sorted/X" → Graph folder ID (display only)
}

export interface RuleSuggestion {
  matchType: 'from_address' | 'from_domain';
  matchValue: string;
  targetFolder: string; // e.g. "To Delete", "Sorted/Newsletters"
  // Gmail side
  gmailLabelId: string | null; // resolved from archive config
  gmailCriteria: { from?: string; query?: string };
  gmailAlreadyExists: boolean; // true if an equivalent filter is already in the account
  // Outlook side
  owaInstruction: string; // "From address: X → Move to: Y"
}

function loadArchiveRules(mainFolder: string): ArchiveRule[] {
  const p = path.join(GROUPS_DIR, mainFolder, 'email-archive', 'rules.yaml');
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf-8');
  const rules: ArchiveRule[] = [];
  let cur: Partial<ArchiveRule> | null = null;
  // Tiny YAML subset parser — the file is flat "rules: [list]" with nested
  // `match:` objects; we walk lines.
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line) continue;
    if (/^\s*-\s+match:\s*$/.test(line)) {
      if (cur && cur.folder) rules.push(cur as ArchiveRule);
      cur = {};
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^\s+([a-z_]+):\s*"?([^"#]*?)"?\s*$/i);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'from_address') cur.from_address = val;
    else if (key === 'from_domain') cur.from_domain = val;
    else if (key === 'folder') cur.folder = val;
    else if (key === 'note') cur.note = val;
  }
  if (cur && cur.folder) rules.push(cur as ArchiveRule);
  return rules;
}

function loadArchiveConfig(mainFolder: string): ArchiveConfig {
  const p = path.join(GROUPS_DIR, mainFolder, 'email-archive', 'config.yaml');
  const out: ArchiveConfig = { gmailLabels: {}, outlookFolders: {} };
  if (!fs.existsSync(p)) return out;
  const raw = fs.readFileSync(p, 'utf-8');
  // Walk the archive_accounts section. Look for the gmail/outlook ids and
  // their folder_ids maps.
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
    // Any top-level key resets
    if (/^[a-z_]+:/.test(line)) {
      currentAccount = null;
      inFolderIds = false;
    }
    if (!currentAccount || !inFolderIds) continue;
    const m = line.match(/^\s+"([^"]+)":\s*"([^"]+)"\s*$/);
    if (!m) continue;
    const [, folder, id] = m;
    if (currentAccount === 'gmail') out.gmailLabels[folder] = id;
    else out.outlookFolders[folder] = id;
  }
  return out;
}

function runGws(args: string[]): unknown | null {
  try {
    const out = execFileSync(GWS_BIN, args, {
      encoding: 'utf-8',
      env: { ...process.env, GWS_CREDENTIAL_STORE: 'plaintext' },
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const trimmed = out.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (err) {
    logger.warn({ err, args }, 'mail-rule-suggester: gws call failed');
    return null;
  }
}

interface GmailFilter {
  id: string;
  criteria?: { from?: string; query?: string };
  action?: { addLabelIds?: string[]; removeLabelIds?: string[] };
}

function listGmailFilters(): GmailFilter[] {
  const resp = runGws([
    'gmail',
    'users',
    'settings',
    'filters',
    'list',
    '--params',
    JSON.stringify({ userId: 'me' }),
    '--format',
    'json',
  ]) as { filter?: GmailFilter[] } | null;
  return resp?.filter || [];
}

/** Return true if there is already a Gmail filter that moves this criteria
 *  to the target label. We consider it a match if `from` matches AND
 *  addLabelIds includes the target label id. */
function gmailHasEquivalent(
  existing: GmailFilter[],
  criteria: { from?: string; query?: string },
  targetLabelId: string | null,
): boolean {
  if (!targetLabelId) return false;
  return existing.some((f) => {
    const sameFrom =
      (f.criteria?.from || '').toLowerCase() ===
      (criteria.from || '').toLowerCase();
    if (!sameFrom) return false;
    const labels = f.action?.addLabelIds || [];
    return labels.includes(targetLabelId);
  });
}

export function buildSuggestions(mainFolder: string): RuleSuggestion[] {
  const rules = loadArchiveRules(mainFolder);
  const cfg = loadArchiveConfig(mainFolder);

  let existingGmail: GmailFilter[] = [];
  try {
    existingGmail = listGmailFilters();
  } catch {
    /* gws might be unavailable; keep empty — all suggestions will show as
     *  "not yet present", user may see duplicates on apply. */
  }

  return rules.map<RuleSuggestion>((r) => {
    const matchType: 'from_address' | 'from_domain' = r.from_address
      ? 'from_address'
      : 'from_domain';
    const matchValue = r.from_address || r.from_domain || '';
    const gmailLabelId = cfg.gmailLabels[r.folder] || null;
    const gmailCriteria: { from?: string; query?: string } =
      matchType === 'from_address'
        ? { from: matchValue }
        : { from: '*@' + matchValue, query: `from:*@${matchValue}` };
    return {
      matchType,
      matchValue,
      targetFolder: r.folder,
      gmailLabelId,
      gmailCriteria,
      gmailAlreadyExists: gmailHasEquivalent(
        existingGmail,
        gmailCriteria,
        gmailLabelId,
      ),
      owaInstruction:
        `From ${matchType === 'from_address' ? 'address' : 'domain'}: ${matchValue}` +
        `  →  Move to: ${r.folder}`,
    };
  });
}

export interface ApplyResult {
  attempted: number;
  created: number;
  skipped: number;
  errors: string[];
}

/** Create all Gmail filters from the supplied suggestions that aren't
 *  already present and have a resolvable label id. */
export function applyGmailFilters(suggestions: RuleSuggestion[]): ApplyResult {
  let created = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const s of suggestions) {
    if (s.gmailAlreadyExists) {
      skipped += 1;
      continue;
    }
    if (!s.gmailLabelId) {
      errors.push(
        `no Gmail label id for "${s.targetFolder}" (check email-archive/config.yaml)`,
      );
      skipped += 1;
      continue;
    }
    // Gmail filter: move OUT of inbox (removeLabelIds: INBOX) and add the
    // target label. For "To Delete" we also add TRASH is wrong — it's a
    // user-visible label, so just add the label; user can empty periodically.
    const body = {
      criteria:
        s.matchType === 'from_address'
          ? { from: s.matchValue }
          : { from: '*@' + s.matchValue },
      action: {
        addLabelIds: [s.gmailLabelId],
        removeLabelIds: ['INBOX'],
      },
    };
    const resp = runGws([
      'gmail',
      'users',
      'settings',
      'filters',
      'create',
      '--params',
      JSON.stringify({ userId: 'me' }),
      '--json',
      JSON.stringify(body),
      '--format',
      'json',
    ]) as { id?: string } | null;
    if (resp?.id) {
      created += 1;
      logger.info(
        {
          matchValue: s.matchValue,
          targetFolder: s.targetFolder,
          filterId: resp.id,
        },
        'mail-rule-suggester: created Gmail filter',
      );
    } else {
      errors.push(`create failed for ${s.matchValue} → ${s.targetFolder}`);
    }
  }
  return { attempted: suggestions.length, created, skipped, errors };
}

function fmtSuggestion(s: RuleSuggestion, i: number): string {
  const check = s.gmailAlreadyExists ? '✓' : s.gmailLabelId ? '·' : '?';
  return `#${i + 1} ${check} ${s.matchValue}  →  ${s.targetFolder}`;
}

export function formatSuggestionsReport(suggestions: RuleSuggestion[]): string {
  if (suggestions.length === 0) {
    return 'No rules found in email-archive/rules.yaml. Run `/add-email-archive` calibration first.';
  }

  const total = suggestions.length;
  const alreadyGmail = suggestions.filter((s) => s.gmailAlreadyExists).length;
  const creatableGmail = suggestions.filter(
    (s) => !s.gmailAlreadyExists && s.gmailLabelId,
  ).length;
  const noLabel = suggestions.filter((s) => !s.gmailLabelId).length;

  const lines: string[] = [
    `*Mail rule suggestions* (from ${total} archive rule(s))`,
    '',
    `Gmail: ${alreadyGmail} already present, ${creatableGmail} can be auto-created, ${noLabel} missing a label mapping`,
    `Outlook: ${total} instructions below (apply manually in OWA — MailboxSettings scope not consented in Clemson tenant)`,
    '',
    '*Rules:*',
    ...suggestions.map(fmtSuggestion),
    '',
    '_Legend: ✓ = Gmail filter already exists; · = can be created; ? = missing label mapping._',
    '',
    '*To apply Gmail filters:* `/apply-gmail-filters`',
    '',
    '*OWA instructions — paste these into outlook.office.com → Settings → Mail → Rules:*',
    '```',
    ...suggestions.map((s) => s.owaInstruction),
    '```',
  ];
  return lines.join('\n');
}

export function formatApplyReport(r: ApplyResult): string {
  const lines = [
    `*Gmail filters applied.*`,
    `  Attempted: ${r.attempted}`,
    `  Created: ${r.created}`,
    `  Skipped (already present or unresolvable): ${r.skipped}`,
  ];
  if (r.errors.length > 0) {
    lines.push('', '*Errors:*');
    for (const e of r.errors.slice(0, 5)) lines.push(`  - ${e}`);
    if (r.errors.length > 5) lines.push(`  …and ${r.errors.length - 5} more`);
  }
  return lines.join('\n');
}
