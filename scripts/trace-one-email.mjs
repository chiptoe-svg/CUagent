// One-shot: pick the first pending residual, fetch its body via Graph,
// build the real residual-handoff prompt (matching buildAgentPrompt), and
// enqueue it as a scheduled once-task so we can trace a single-email scan
// through the existing pipeline.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const PROJECT = '/Users/tonkin/Documents/ClaudeWorkingFolder/Projects/CUagent';
const pendingPath = path.join(
  PROJECT,
  'groups/telegram_main/email-triage/state/pending_residuals.jsonl',
);
const line = fs.readFileSync(pendingPath, 'utf-8').split('\n').filter(Boolean)[0];
const entry = JSON.parse(line);
console.log('Picked:', entry.from, '—', entry.subject);

// --- Read MS365 token ---
function readMsal() {
  const p = `${process.env.HOME}/.nanoclaw/.ms365-tokens/.token-cache.json`;
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const inner = raw._cacheEnvelope ? JSON.parse(raw.data) : raw;
  return inner;
}
async function getToken() {
  const cache = readMsal();
  const now = Date.now();
  for (const t of Object.values(cache.AccessToken || {})) {
    if (!t.expiresOn) continue;
    const exp = parseInt(t.expiresOn, 10) * 1000;
    if (exp > now + 60_000) return t.secret;
  }
  // Refresh
  const providerCfg = JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.nanoclaw/providers/ms365.json`, 'utf-8'),
  );
  const env = providerCfg.mcp.env;
  const refresh = Object.values(cache.RefreshToken || {})[0];
  const r = await fetch(
    `https://login.microsoftonline.com/${env.MS365_MCP_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.MS365_MCP_CLIENT_ID,
        refresh_token: refresh.secret,
        scope:
          'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Tasks.ReadWrite',
      }).toString(),
    },
  );
  const data = await r.json();
  return data.access_token;
}

const token = await getToken();
console.log('Token acquired:', token ? token.slice(0, 10) + '…' : 'FAIL');

// --- Fetch body ---
const r = await fetch(
  `https://graph.microsoft.com/v1.0/me/messages/${entry.email_id}?$select=body,bodyPreview,conversationId`,
  { headers: { Authorization: `Bearer ${token}` } },
);
if (!r.ok) {
  console.error('Body fetch failed', r.status);
  process.exit(1);
}
const msg = await r.json();
const raw = msg.body?.content || msg.bodyPreview || '';
// Normalize (match email-preclassifier's normalizeBody)
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
const body = decoded.replace(/\s+/g, ' ').trim().slice(0, 3000);
console.log('Body length (after normalize):', body.length);

// --- Build prompt (matches buildAgentPrompt with 1 candidate, 1 batch) ---
const scanRunId = new Date().toISOString();
const prompt = [
  `/email-taskfinder scan`,
  ``,
  `Host-side pre-classification already handled bucket 1 (action_templates)`,
  `and bucket 2 (skip_senders) for this scan. YOUR job is only buckets 3/4/5`,
  `(solicited / personal-outreach / unsolicited) on the candidates below.`,
  ``,
  `scan_run_id: ${scanRunId}`,
  `pre_resolved (whole scan): 0`,
  `llm_candidates in THIS batch: 1`,
  ``,
  `Candidates (bucket_hint is what the host thinks — verify, don't trust blindly):`,
  `1. [${entry.account}] from=${entry.from}  subject="${entry.subject}"  id=${entry.email_id}  hint=unsolicited_check`,
  `    body: ${body}`,
  ``,
  `TREAT EACH EMAIL INDEPENDENTLY. Classification of one email must not`,
  `influence another — each is a standalone decision. Do not batch reasoning`,
  `across them. Do not carry narrative from one email into the next.`,
  ``,
  `Bodies are already inlined above (plain text, capped ~3000 chars). DO NOT`,
  `call ms365/get-mail-message or gws gmail get to re-fetch them unless the`,
  `body says "(host body-fetch failed …)".`,
  ``,
  `Fetch bodies ONE AT A TIME for the candidates you decide to classify.`,
  `Skip bucket 1/2 work — the host already did it. DO NOT re-check skip_senders`,
  `or action_templates. DO NOT re-list inbox mail.`,
  ``,
  `Log one log_triage_decision per candidate (scan_run_id=${scanRunId}).`,
  ``,
  `Write ONE final summary via send_message (this is the LAST batch). Format:`,
  `  📬 Email Taskfinder — ${scanRunId}`,
  ``,
  `  Scanned: 1   Tasks created: <N>`,
  `  TRACE RUN — single-email diagnostic. Include in your summary the decision`,
  `  plus one short sentence describing what happened.`,
].join('\n');

// --- Find main group + JID ---
const db = new Database(`${PROJECT}/store/messages.db`);
const mainGroup = db
  .prepare(
    `SELECT folder AS group_folder, jid FROM registered_groups WHERE is_main = 1 LIMIT 1`,
  )
  .get();
console.log('Main group:', mainGroup);

// --- Enqueue ---
const taskId = `taskfinder-residual-trace-${Date.now()}`;
const nextIso = new Date(Date.now() + 10_000).toISOString();
db.prepare(
  `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
   VALUES (?, ?, ?, ?, NULL, 'once', ?, 'isolated', ?, 'active', ?)`,
).run(
  taskId,
  mainGroup.group_folder,
  mainGroup.jid,
  prompt,
  nextIso,
  nextIso,
  new Date().toISOString(),
);
console.log('Enqueued:', taskId);
console.log('Fires at:', nextIso);
console.log('Prompt length:', prompt.length, 'chars');
