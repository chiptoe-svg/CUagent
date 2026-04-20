/**
 * Daily-cost report for scheduled-task runs.
 *
 * Reads the last-24h slice of `task_run_logs`, costs each run via
 * `src/pricing.ts`, aggregates by task, and returns a Telegram-ready
 * summary. Used by both the on-demand `/cost-report` command and the
 * 9pm daily auto-report.
 *
 * Scheduled-tasks only — interactive-chat runs don't land in
 * `task_run_logs` today. The report notes this so the user isn't
 * surprised by the gap.
 */
import { getTaskRunsInWindow } from './db.js';
import { computeRunCostUsd, getPricingFilePath } from './pricing.js';

export interface CostReport {
  windowStart: string;
  windowEnd: string;
  totalUsd: number;
  runCount: number;
  byTask: Array<{
    task_id: string;
    prompt: string;
    runs: number;
    totalUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    models: string[];
  }>;
  unpricedRuns: number;
  pricingSource: string | null;
}

export function buildCostReport(windowHours = 24): CostReport {
  const end = new Date();
  const start = new Date(end.getTime() - windowHours * 60 * 60 * 1000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const runs = getTaskRunsInWindow(startIso, endIso);
  const byTaskMap = new Map<
    string,
    {
      task_id: string;
      prompt: string;
      runs: number;
      totalUsd: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      models: Set<string>;
    }
  >();

  let unpricedRuns = 0;

  for (const r of runs) {
    const cost = computeRunCostUsd({
      model: r.model_used,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    });
    if (r.input_tokens == null && r.output_tokens == null) unpricedRuns++;

    let bucket = byTaskMap.get(r.task_id);
    if (!bucket) {
      bucket = {
        task_id: r.task_id,
        prompt: r.prompt,
        runs: 0,
        totalUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        models: new Set<string>(),
      };
      byTaskMap.set(r.task_id, bucket);
    }
    bucket.runs += 1;
    bucket.totalUsd += cost;
    bucket.totalInputTokens += r.input_tokens || 0;
    bucket.totalOutputTokens += r.output_tokens || 0;
    if (r.model_used) bucket.models.add(r.model_used);
  }

  const byTask = Array.from(byTaskMap.values())
    .map((b) => ({
      task_id: b.task_id,
      prompt: b.prompt,
      runs: b.runs,
      totalUsd: b.totalUsd,
      totalInputTokens: b.totalInputTokens,
      totalOutputTokens: b.totalOutputTokens,
      models: Array.from(b.models),
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd);

  const totalUsd = byTask.reduce((s, t) => s + t.totalUsd, 0);

  return {
    windowStart: startIso,
    windowEnd: endIso,
    totalUsd,
    runCount: runs.length,
    byTask,
    unpricedRuns,
    pricingSource: getPricingFilePath(),
  };
}

function fmtUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCostReport(r: CostReport, windowHours = 24): string {
  const header = `*Cost report — last ${windowHours}h*\n${r.windowStart.slice(0, 16)} → ${r.windowEnd.slice(0, 16)} UTC`;
  if (r.runCount === 0) {
    return `${header}\n\nNo scheduled-task runs in the window.\n\nNote: interactive chat turns are not yet tracked in this report.`;
  }

  const lines = [header, '', `*Total: ${fmtUsd(r.totalUsd)}* across ${r.runCount} run(s)`, ''];

  r.byTask.forEach((t, i) => {
    const prompt = t.prompt.replace(/\n/g, ' ').slice(0, 40);
    const models = t.models.length ? t.models.join(', ') : 'unknown';
    lines.push(
      `#${i + 1} ${prompt}`,
      `  ${t.runs} run(s) · ${fmtUsd(t.totalUsd)} · ${fmtTokens(t.totalInputTokens)}in / ${fmtTokens(t.totalOutputTokens)}out · ${models}`,
    );
  });

  if (r.unpricedRuns > 0) {
    lines.push('', `_${r.unpricedRuns} run(s) missing token data — not priced._`);
  }
  lines.push('', `_Pricing: ${r.pricingSource ?? 'embedded defaults'}_`);
  lines.push(`_Interactive chat turns not included (future work)._`);

  return lines.join('\n');
}
