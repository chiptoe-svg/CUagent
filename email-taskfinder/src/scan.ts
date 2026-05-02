// Main scan orchestrator. Walks new + carryover mail through the cascade,
// emits decisions, creates MS365 tasks. Returns a summary string for the
// caller to print.

import crypto from 'crypto';

import { DRY_RUN, MODE } from './config.js';
import {
  bucketHintFor,
  buildCleanTitle,
  matchActionTemplate,
  matchSkipSender,
  sanitizeTaskTitle,
  substituteTitle,
  validateSortFolder,
} from './cascade.js';
import { classifyBatchWithCodex } from './codex-agent.js';
import { fetchGmailBody, listGmail } from './gmail.js';
import {
  loadAccounts,
  loadClassification,
  loadInstitutions,
  loadKnownContacts,
  loadTaxonomy,
} from './loaders.js';
import { log } from './log.js';
import {
  computeDueIsoLocal,
  createMs365Task,
  fetchOutlookBody,
  getDefaultTodoListId,
  listOutlook,
} from './ms365.js';
import { classifyEmailWithApi, openAiConfigured } from './openai-classifier.js';
import {
  appendDecision,
  loadPendingResiduals,
  loadProgress,
  loadResolvedEmailIds,
  writePendingResiduals,
  writeProgress,
} from './state.js';
import {
  ClassificationResult,
  EmailMinimal,
  LlmCandidate,
  PendingResidual,
  ScanOutcome,
} from './types.js';

const MAX_PENDING_ATTEMPTS = 5;

async function listAllNewMail(progress: {
  gmail?: string;
  outlook?: string;
}): Promise<EmailMinimal[]> {
  const accounts = loadAccounts();
  const out: EmailMinimal[] = [];
  for (const acc of accounts) {
    if (acc.type === 'gws') {
      out.push(...listGmail(progress.gmail ?? null));
    } else if (acc.type === 'ms365') {
      out.push(...(await listOutlook(progress.outlook ?? null)));
    }
  }
  return out;
}

async function fetchBodies(candidates: LlmCandidate[]): Promise<void> {
  for (const c of candidates) {
    if (c.account === 'gmail') {
      c.body = fetchGmailBody(c.id);
    } else if (c.account === 'outlook') {
      c.body = await fetchOutlookBody(c.id);
    }
  }
}

export interface ApiOutcome {
  apiTaskCount: number;
  apiSkipCount: number;
  apiFailureCount: number;
  tasksCreated: Array<{ title: string; folder: string }>;
}

async function applyClassification(
  email: LlmCandidate,
  result: ClassificationResult,
  scanRunId: string,
  modelLabel: string,
  ms365ListId: string | null,
  out: ApiOutcome,
): Promise<void> {
  const taxonomy = loadTaxonomy();
  const validatedFolder = validateSortFolder(result.sort_folder, taxonomy);
  const bodyChars = (email.body || '').length;
  const bodySha256 = crypto
    .createHash('sha256')
    .update(email.body || '')
    .digest('hex');

  if (result.needs_task) {
    if (!ms365ListId || DRY_RUN) {
      if (DRY_RUN) {
        log.info('[dry-run] would create task', {
          subject: email.subject,
          folder: validatedFolder,
          title: result.task_title,
        });
      } else {
        log.warn('no MS365 list — leaving email in pending for retry', {
          emailId: email.id,
        });
        out.apiFailureCount += 1;
        return;
      }
    }
    const rawTitle =
      result.task_title ||
      result.reasoning.split('.')[0].slice(0, 80) ||
      `Review: ${email.subject}`;
    const sanitizedTitle = sanitizeTaskTitle(rawTitle, email.subject || '');
    const cleanTitle = buildCleanTitle(
      sanitizedTitle,
      email.account,
      validatedFolder,
    );
    let taskId: string | null = null;
    if (!DRY_RUN && ms365ListId) {
      taskId = await createMs365Task(ms365ListId, cleanTitle);
      if (!taskId) {
        out.apiFailureCount += 1;
        return;
      }
    }
    out.apiTaskCount += 1;
    out.tasksCreated.push({ title: cleanTitle, folder: validatedFolder });
    appendDecision({
      scan_run_id: scanRunId,
      email_id: email.id,
      account: email.account,
      sender: email.from,
      subject: (email.subject || '').slice(0, 120),
      pass: 'classifier',
      decision: 'task',
      sort_folder: validatedFolder,
      rule_matched: email.bucket_hint,
      reasoning: result.reasoning,
      task_id_created: taskId,
      model_used: modelLabel,
      body_sha256: bodySha256,
      body_chars_sent: bodyChars,
      dry_run: DRY_RUN || undefined,
    });
  } else {
    out.apiSkipCount += 1;
    appendDecision({
      scan_run_id: scanRunId,
      email_id: email.id,
      account: email.account,
      sender: email.from,
      subject: (email.subject || '').slice(0, 120),
      pass: 'classifier',
      decision: 'skip',
      sort_folder: validatedFolder,
      rule_matched: email.bucket_hint,
      reasoning: result.reasoning,
      task_id_created: null,
      model_used: modelLabel,
      body_sha256: bodySha256,
      body_chars_sent: bodyChars,
      dry_run: DRY_RUN || undefined,
    });
  }
}

async function classifyResidualsOpenAi(
  outcome: ScanOutcome,
  scanRunId: string,
  ms365ListId: string | null,
): Promise<ApiOutcome> {
  const taxonomy = loadTaxonomy();
  const out: ApiOutcome = {
    apiTaskCount: 0,
    apiSkipCount: 0,
    apiFailureCount: 0,
    tasksCreated: [],
  };
  for (const email of outcome.llm_candidates) {
    const result = await classifyEmailWithApi(email, taxonomy);
    if (!result) {
      out.apiFailureCount += 1;
      continue;
    }
    await applyClassification(
      email,
      result,
      scanRunId,
      'openai-direct',
      ms365ListId,
      out,
    );
  }
  return out;
}

async function classifyResidualsCodex(
  outcome: ScanOutcome,
  scanRunId: string,
  ms365ListId: string | null,
): Promise<ApiOutcome> {
  const taxonomy = loadTaxonomy();
  const out: ApiOutcome = {
    apiTaskCount: 0,
    apiSkipCount: 0,
    apiFailureCount: 0,
    tasksCreated: [],
  };
  const decisions = await classifyBatchWithCodex(
    outcome.llm_candidates,
    taxonomy,
  );
  for (const email of outcome.llm_candidates) {
    const result = decisions.get(email.id);
    if (!result) {
      out.apiFailureCount += 1;
      continue;
    }
    await applyClassification(
      email,
      result,
      scanRunId,
      'codex-cli',
      ms365ListId,
      out,
    );
  }
  return out;
}

export async function runScan(): Promise<string> {
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

  const accounts = loadAccounts();
  if (accounts.length === 0) {
    return 'No accounts configured. Edit config/accounts.yaml.';
  }

  const classification = loadClassification();
  const institutions = loadInstitutions();
  const contacts = loadKnownContacts();
  const progress = loadProgress();

  // Carryover from prior scan: any pending residual whose email_id has a
  // logged decision is dropped; entries past MAX_PENDING_ATTEMPTS get a
  // synthetic skip and are dropped; the rest carry forward.
  const pendingPrev = loadPendingResiduals();
  const resolvedIds = loadResolvedEmailIds(30);
  const unresolved = pendingPrev.filter((e) => !resolvedIds.has(e.email_id));
  const exhausted = unresolved.filter(
    (e) => e.attempt_count >= MAX_PENDING_ATTEMPTS,
  );
  const carryover = unresolved.filter(
    (e) => e.attempt_count < MAX_PENDING_ATTEMPTS,
  );
  for (const e of exhausted) {
    appendDecision({
      scan_run_id: scanRunId,
      email_id: e.email_id,
      account: e.account,
      sender: e.from,
      subject: (e.subject || '').slice(0, 120),
      pass: 'classify-failed',
      decision: 'skip',
      sort_folder: 'To Delete',
      rule_matched: `pending_attempts_exhausted:${e.attempt_count}`,
      reasoning: `Classifier failed ${e.attempt_count} times since ${e.first_handoff_ts}`,
      task_id_created: null,
      model_used: null,
    });
  }
  if (exhausted.length > 0) {
    log.warn('gave up on emails after max retries', {
      exhausted: exhausted.length,
    });
  }
  const carryoverByEmailId = new Map(carryover.map((e) => [e.email_id, e]));

  const freshEmails = await listAllNewMail(progress.last_scan_date ?? {});
  const freshIds = new Set(freshEmails.map((e) => e.id));
  const carryoverAsEmails: EmailMinimal[] = carryover
    .filter((c) => !freshIds.has(c.email_id))
    .map((c) => ({
      id: c.email_id,
      account: c.account,
      from: c.from,
      subject: c.subject,
    }));
  const emails = [...carryoverAsEmails, ...freshEmails];
  outcome.scanned = emails.length;

  if (emails.length === 0) {
    if (!DRY_RUN) {
      writeProgress({
        ...progress,
        last_scan_date: {
          gmail: new Date().toISOString(),
          outlook: new Date().toISOString(),
        },
        last_scan_run_id: scanRunId,
      });
      writePendingResiduals([]);
    }
    return formatSummary(outcome, null);
  }

  // MODE selects who classifies bucket 3/4/5. In all modes, host runs
  // bucket 1 + 2 deterministically.
  const wantsAgent = MODE === 'agent';
  const wantsHybrid = MODE === 'hybrid';

  const ms365ListId = DRY_RUN ? 'dry-run' : await getDefaultTodoListId();

  const overrideById = new Map(
    classification.overrides.map((o) => [o.email_id, o]),
  );

  for (const email of emails) {
    const override = overrideById.get(email.id);
    if (override) {
      appendDecision({
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

    // MODE=agent: don't run buckets 1+2 host-side, hand the whole stream
    // to the agent. Useful for sanity-checking the cascade end-to-end.
    if (wantsAgent) {
      outcome.llm_candidates.push({
        ...email,
        bucket_hint: bucketHintFor(email, institutions, contacts),
      });
      continue;
    }

    const tpl = matchActionTemplate(email, classification.action_templates);
    if (tpl) {
      if (tpl.skip) {
        outcome.template_skips += 1;
        appendDecision({
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
        let taskId: string | null = null;
        if (!DRY_RUN && ms365ListId) {
          taskId = await createMs365Task(ms365ListId, cleanTitle, due);
          if (!taskId) {
            outcome.errors.push(
              `template_${tpl.name}: create-task failed for "${email.subject}"`,
            );
            outcome.llm_candidates.push({
              ...email,
              bucket_hint: 'solicited',
            });
            continue;
          }
        }
        outcome.template_tasks += 1;
        appendDecision({
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

    const skip = matchSkipSender(email, classification.skip_senders);
    if (skip) {
      outcome.skip_sender_count += 1;
      appendDecision({
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

    outcome.llm_candidates.push({
      ...email,
      bucket_hint: bucketHintFor(email, institutions, contacts),
    });
  }

  if (!DRY_RUN) {
    writeProgress({
      ...progress,
      last_scan_date: {
        gmail: new Date().toISOString(),
        outlook: new Date().toISOString(),
      },
      last_scan_run_id: scanRunId,
    });
  }

  if (outcome.llm_candidates.length === 0) {
    if (!DRY_RUN) writePendingResiduals([]);
    return formatSummary(outcome, null);
  }

  await fetchBodies(outcome.llm_candidates);

  // Pick the residual classifier. MODE=agent and MODE=hybrid always go to
  // codex. MODE=preclassifier prefers the direct OpenAI call but falls back
  // to codex automatically when OPENAI_API_KEY is missing — that makes
  // OpenAI-key optional for users who already have a ChatGPT subscription
  // configured for the codex CLI.
  let api: ApiOutcome;
  if (wantsAgent || wantsHybrid) {
    api = await classifyResidualsCodex(outcome, scanRunId, ms365ListId);
  } else if (openAiConfigured()) {
    api = await classifyResidualsOpenAi(outcome, scanRunId, ms365ListId);
  } else {
    log.info(
      'OPENAI_API_KEY not set — falling back to codex CLI for residual classification',
    );
    api = await classifyResidualsCodex(outcome, scanRunId, ms365ListId);
  }

  if (!DRY_RUN) {
    const nowIso = new Date().toISOString();
    const pendingThisScan: PendingResidual[] = outcome.llm_candidates.map(
      (c) => {
        const prior = carryoverByEmailId.get(c.id);
        return {
          scan_run_id: scanRunId,
          email_id: c.id,
          account: c.account,
          from: c.from,
          subject: c.subject,
          handoff_ts: nowIso,
          first_handoff_ts: prior?.first_handoff_ts ?? nowIso,
          attempt_count: (prior?.attempt_count ?? 0) + 1,
        };
      },
    );
    writePendingResiduals(pendingThisScan);
  }

  return formatSummary(outcome, api);
}

function formatSummary(o: ScanOutcome, api: ApiOutcome | null): string {
  if (o.scanned === 0) return 'No new mail since last scan.';
  const preResolved =
    o.template_tasks + o.template_skips + o.skip_sender_count;
  const totalTasks = o.template_tasks + (api?.apiTaskCount ?? 0);
  const parts = [
    `📬 Email Taskfinder — ${o.scan_run_id}${DRY_RUN ? ' [dry-run]' : ''}`,
    '',
    `Scanned: ${o.scanned}   Tasks created: ${totalTasks}`,
    `Pre-resolved: ${preResolved}  (templated→task=${o.template_tasks}, templated→skip=${o.template_skips}, skip-rule=${o.skip_sender_count})`,
  ];
  if (api) {
    parts.push(
      `LLM-classified: ${o.llm_candidates.length}  (task=${api.apiTaskCount}, skip=${api.apiSkipCount}${api.apiFailureCount ? `, failed=${api.apiFailureCount}` : ''})`,
    );
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
  }
  if (o.errors.length > 0) {
    parts.push('', 'Errors:');
    for (const e of o.errors.slice(0, 5)) parts.push(`  • ${e}`);
  }
  return parts.join('\n');
}
