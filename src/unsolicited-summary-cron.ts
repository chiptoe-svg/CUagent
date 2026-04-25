/**
 * Daily unsolicited-summary report.
 *
 * Reads the last 24h of /email-taskfinder decisions (decisions.jsonl) and
 * sends a one-message summary of what landed in the unsolicited bucket
 * (labeled `triage:archived`, still in inbox). Purpose: give Chip a chance
 * to flag misses via `/fix-triage` BEFORE graduating to auto-archive.
 *
 * Host-side, zero-LLM, zero-agent. Same setTimeout re-arming pattern as
 * cost-report-cron.ts — no external cron daemon needed.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const LOOKBACK_HOURS = 24;
const MAX_SENDER_ROWS = 12; // cap list length so the Telegram message stays readable
const MAX_SUBJECT_EXAMPLES = 2;

export interface UnsolicitedSummaryDeps {
  cronExpr: string;
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

interface DecisionEntry {
  ts?: string;
  sender?: string | null;
  subject?: string | null;
  decision?: string;
  pass?: string;
  sort_folder?: string | null;
}

interface SenderAgg {
  sender: string;
  count: number;
  sampleSubjects: string[];
}

function findMainJid(groups: Record<string, RegisteredGroup>): string | null {
  for (const [jid, g] of Object.entries(groups)) if (g.isMain) return jid;
  return null;
}

function findMainFolder(
  groups: Record<string, RegisteredGroup>,
): string | null {
  for (const g of Object.values(groups)) if (g.isMain) return g.folder;
  return null;
}

async function loadLast24h(
  decisionsPath: string,
  cutoffIso: string,
): Promise<DecisionEntry[]> {
  if (!fs.existsSync(decisionsPath)) return [];
  const out: DecisionEntry[] = [];
  const stream = fs.createReadStream(decisionsPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as DecisionEntry;
      if (!entry.ts) continue;
      if (entry.ts < cutoffIso) continue;
      out.push(entry);
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

function aggregateBySender(entries: DecisionEntry[]): SenderAgg[] {
  const bySender = new Map<string, SenderAgg>();
  for (const e of entries) {
    const key = (e.sender || 'unknown').toLowerCase();
    const existing = bySender.get(key);
    const subject = e.subject?.trim();
    if (existing) {
      existing.count += 1;
      if (
        subject &&
        existing.sampleSubjects.length < MAX_SUBJECT_EXAMPLES &&
        !existing.sampleSubjects.includes(subject)
      ) {
        existing.sampleSubjects.push(subject);
      }
    } else {
      bySender.set(key, {
        sender: key,
        count: 1,
        sampleSubjects: subject ? [subject] : [],
      });
    }
  }
  return [...bySender.values()].sort((a, b) => b.count - a.count);
}

function formatReport(
  mainFolder: string,
  entries: DecisionEntry[],
  lookbackHours: number,
): string {
  if (entries.length === 0) {
    return `*Unsolicited summary* — last ${lookbackHours}h\n\nNothing landed in the unsolicited bucket. All new mail matched a rule or was classified as solicited.`;
  }
  const agg = aggregateBySender(entries);
  const shown = agg.slice(0, MAX_SENDER_ROWS);
  const overflow = agg.length - shown.length;

  const lines: string[] = [
    `*Unsolicited summary* — last ${lookbackHours}h  (group: ${mainFolder})`,
    '',
    `${entries.length} email(s) from ${agg.length} sender(s) labeled \`triage:archived\`.`,
    'All are still in inbox. Use `/fix-triage <subject-fragment>` to correct any miss.',
    '',
  ];
  for (const row of shown) {
    const examples =
      row.sampleSubjects.length > 0
        ? ' — ' +
          row.sampleSubjects
            .map((s) => `"${s.length > 60 ? s.slice(0, 57) + '…' : s}"`)
            .join(', ')
        : '';
    lines.push(`  • ${row.sender}  (${row.count})${examples}`);
  }
  if (overflow > 0) {
    lines.push(`  …and ${overflow} more sender(s) not shown.`);
  }
  return lines.join('\n');
}

export function startUnsolicitedSummary(deps: UnsolicitedSummaryDeps): void {
  const schedule = (): void => {
    let nextMs: number;
    try {
      const interval = CronExpressionParser.parse(deps.cronExpr, {
        tz: TIMEZONE,
      });
      nextMs = interval.next().getTime() - Date.now();
    } catch (err) {
      logger.warn(
        { cronExpr: deps.cronExpr, err },
        'Invalid unsolicited-summary cron expr — disabling',
      );
      return;
    }
    nextMs = Math.max(1_000, Math.min(nextMs, 25 * 60 * 60 * 1000));
    logger.info(
      {
        cronExpr: deps.cronExpr,
        nextAt: new Date(Date.now() + nextMs).toISOString(),
      },
      'Unsolicited summary armed',
    );
    setTimeout(async () => {
      try {
        const groups = deps.registeredGroups();
        const mainFolder = findMainFolder(groups);
        const mainJid = findMainJid(groups);
        if (!mainFolder || !mainJid) {
          logger.warn(
            'Unsolicited summary: no main group — skipping this fire',
          );
        } else {
          const decisionsPath = path.join(
            GROUPS_DIR,
            mainFolder,
            'email-triage',
            'state',
            'decisions.jsonl',
          );
          const cutoff = new Date(
            Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000,
          ).toISOString();
          const all = await loadLast24h(decisionsPath, cutoff);
          const unsolicited = all.filter(
            (e) => e.decision === 'label-only' || e.pass === 'unsolicited',
          );
          const text = formatReport(mainFolder, unsolicited, LOOKBACK_HOURS);
          await deps.sendMessage(mainJid, text);
          logger.info(
            { count: unsolicited.length, total: all.length },
            'Unsolicited summary sent',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Unsolicited summary fire failed');
      }
      schedule();
    }, nextMs);
  };
  schedule();
}
