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
import { getChatRunsInWindow, getTaskRunsInWindow } from './db.js';
import { computeRunCost, getPricingFilePath } from './pricing.js';

export interface CostReport {
  windowStart: string;
  windowEnd: string;
  /** Grand total — scheduled + interactive. */
  totalUsd: number;
  cacheSavedUsd: number;
  /** Scheduled-task slice only. */
  scheduledUsd: number;
  scheduledRunCount: number;
  /** Interactive-chat slice only. */
  interactiveUsd: number;
  interactiveTurnCount: number;
  interactiveInputTokens: number;
  interactiveCachedInputTokens: number;
  interactiveOutputTokens: number;
  interactiveModels: string[];
  /** Per-task rollup, scheduled runs only. */
  byTask: Array<{
    task_id: string;
    prompt: string;
    runs: number;
    totalUsd: number;
    cacheSavedUsd: number;
    totalInputTokens: number;
    totalCachedInputTokens: number;
    totalOutputTokens: number;
    totalReasoningOutputTokens: number;
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
      cacheSavedUsd: number;
      totalInputTokens: number;
      totalCachedInputTokens: number;
      totalOutputTokens: number;
      totalReasoningOutputTokens: number;
      models: Set<string>;
    }
  >();

  let unpricedRuns = 0;

  for (const r of runs) {
    const cost = computeRunCost({
      model: r.model_used,
      inputTokens: r.input_tokens,
      cachedInputTokens: r.cached_input_tokens,
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
        cacheSavedUsd: 0,
        totalInputTokens: 0,
        totalCachedInputTokens: 0,
        totalOutputTokens: 0,
        totalReasoningOutputTokens: 0,
        models: new Set<string>(),
      };
      byTaskMap.set(r.task_id, bucket);
    }
    bucket.runs += 1;
    bucket.totalUsd += cost.totalUsd;
    bucket.cacheSavedUsd += cost.cacheSavedUsd;
    bucket.totalInputTokens += r.input_tokens || 0;
    bucket.totalCachedInputTokens += r.cached_input_tokens || 0;
    bucket.totalOutputTokens += r.output_tokens || 0;
    bucket.totalReasoningOutputTokens += r.reasoning_output_tokens || 0;
    if (r.model_used) bucket.models.add(r.model_used);
  }

  const byTask = Array.from(byTaskMap.values())
    .map((b) => ({
      task_id: b.task_id,
      prompt: b.prompt,
      runs: b.runs,
      totalUsd: b.totalUsd,
      cacheSavedUsd: b.cacheSavedUsd,
      totalInputTokens: b.totalInputTokens,
      totalCachedInputTokens: b.totalCachedInputTokens,
      totalOutputTokens: b.totalOutputTokens,
      totalReasoningOutputTokens: b.totalReasoningOutputTokens,
      models: Array.from(b.models),
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd);

  const scheduledUsd = byTask.reduce((s, t) => s + t.totalUsd, 0);
  const scheduledCacheSaved = byTask.reduce((s, t) => s + t.cacheSavedUsd, 0);

  // Interactive-chat rollup — aggregated, not per-turn, per user preference.
  const chatRuns = getChatRunsInWindow(startIso, endIso);
  let interactiveUsd = 0;
  let interactiveCacheSaved = 0;
  let interactiveInputTokens = 0;
  let interactiveCachedInputTokens = 0;
  let interactiveOutputTokens = 0;
  const interactiveModels = new Set<string>();

  for (const c of chatRuns) {
    const cost = computeRunCost({
      model: c.model_used,
      inputTokens: c.input_tokens,
      cachedInputTokens: c.cached_input_tokens,
      outputTokens: c.output_tokens,
    });
    if (c.input_tokens == null && c.output_tokens == null) unpricedRuns++;
    interactiveUsd += cost.totalUsd;
    interactiveCacheSaved += cost.cacheSavedUsd;
    interactiveInputTokens += c.input_tokens || 0;
    interactiveCachedInputTokens += c.cached_input_tokens || 0;
    interactiveOutputTokens += c.output_tokens || 0;
    if (c.model_used) interactiveModels.add(c.model_used);
  }

  return {
    windowStart: startIso,
    windowEnd: endIso,
    totalUsd: scheduledUsd + interactiveUsd,
    cacheSavedUsd: scheduledCacheSaved + interactiveCacheSaved,
    scheduledUsd,
    scheduledRunCount: runs.length,
    interactiveUsd,
    interactiveTurnCount: chatRuns.length,
    interactiveInputTokens,
    interactiveCachedInputTokens,
    interactiveOutputTokens,
    interactiveModels: Array.from(interactiveModels),
    byTask,
    unpricedRuns,
    pricingSource: getPricingFilePath(),
  };
}

function fmtUsdShort(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * One-liner for the 9pm daily auto-fire. User wants a single figure in the
 * push — details live behind /cost-report.
 */
export function formatDailyCostOneLiner(r: CostReport): string {
  const cache =
    r.cacheSavedUsd > 0 ? ` · cache saved ${fmtUsdShort(r.cacheSavedUsd)}` : '';
  return `Daily cost: ${fmtUsdShort(r.totalUsd)}${cache} · /cost-report for breakdown`;
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
  const totalRuns = r.scheduledRunCount + r.interactiveTurnCount;
  if (totalRuns === 0) {
    return `${header}\n\nNo agent runs in the window.`;
  }

  const cacheLine =
    r.cacheSavedUsd > 0 ? ` (cache saved ~${fmtUsd(r.cacheSavedUsd)})` : '';
  const lines = [
    header,
    '',
    `*Total: ${fmtUsd(r.totalUsd)}*${cacheLine}`,
    `  · Scheduled: ${fmtUsd(r.scheduledUsd)} across ${r.scheduledRunCount} run(s)`,
    `  · Interactive: ${fmtUsd(r.interactiveUsd)} across ${r.interactiveTurnCount} turn(s)`,
    '',
  ];

  if (r.byTask.length > 0) {
    lines.push('*Scheduled tasks:*');
    r.byTask.forEach((t, i) => {
      const prompt = t.prompt.replace(/\n/g, ' ').slice(0, 40);
      const models = t.models.length ? t.models.join(', ') : 'unknown';
      const cachedPct =
        t.totalInputTokens > 0
          ? Math.round((t.totalCachedInputTokens / t.totalInputTokens) * 100)
          : 0;
      const cacheSuffix =
        t.totalCachedInputTokens > 0
          ? ` (${cachedPct}% cached, saved ${fmtUsd(t.cacheSavedUsd)})`
          : '';
      lines.push(
        `#${i + 1} ${prompt}`,
        `  ${t.runs} run(s) · ${fmtUsd(t.totalUsd)} · ${fmtTokens(t.totalInputTokens)}in / ${fmtTokens(t.totalOutputTokens)}out · ${models}${cacheSuffix}`,
      );
    });
  }

  if (r.interactiveTurnCount > 0) {
    const models =
      r.interactiveModels.length > 0
        ? r.interactiveModels.join(', ')
        : 'unknown';
    const cachedPct =
      r.interactiveInputTokens > 0
        ? Math.round(
            (r.interactiveCachedInputTokens / r.interactiveInputTokens) * 100,
          )
        : 0;
    const cacheSuffix = cachedPct > 0 ? ` (${cachedPct}% cached)` : '';
    lines.push(
      '',
      '*Interactive chat:*',
      `${r.interactiveTurnCount} turn(s) · ${fmtUsd(r.interactiveUsd)} · ${fmtTokens(r.interactiveInputTokens)}in / ${fmtTokens(r.interactiveOutputTokens)}out · ${models}${cacheSuffix}`,
    );
  }

  if (r.unpricedRuns > 0) {
    lines.push(
      '',
      `_${r.unpricedRuns} run(s) missing token data — not priced._`,
    );
  }
  lines.push('', `_Pricing: ${r.pricingSource ?? 'embedded defaults'}_`);

  return lines.join('\n');
}
