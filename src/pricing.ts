/**
 * Per-model pricing table.
 *
 * Loaded lazily from `~/.config/nanoclaw/model-pricing.json` (or
 * `~/.nanoclaw/model-pricing.json` as a fallback for older installs). If
 * neither file exists we fall back to an embedded baseline that's roughly
 * right as of 2026-04-20 — good enough to keep cost reports from crashing
 * but the user should drop in a current copy and edit when prices move.
 *
 * Prices are USD per million tokens.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

export interface ModelPrice {
  input: number; // USD per 1M input tokens (uncached)
  output: number; // USD per 1M output tokens
  /**
   * Optional override for cached-input pricing. If unset, cached tokens
   * are billed at 10% of the `input` rate (the 90% cache discount both
   * OpenAI and Anthropic apply to prompt-cache reads). Set this per-model
   * if a provider publishes a different ratio.
   */
  cached_input?: number;
}

interface PricingFile {
  prices?: Record<string, ModelPrice>;
  fallback?: ModelPrice;
  lastUpdated?: string;
}

const EMBEDDED_DEFAULTS: PricingFile = {
  lastUpdated: '2026-04-20 (embedded baseline — verify before relying on)',
  prices: {
    // OpenAI gpt-5.4 family — published rates per developers.openai.com
    'gpt-5.4-pro': { input: 30.0, output: 180.0 },
    'gpt-5.4': { input: 2.5, cached_input: 0.25, output: 15.0 },
    'gpt-5.4-mini': { input: 0.75, cached_input: 0.08, output: 4.5 },
    'gpt-5.4-nano': { input: 0.2, cached_input: 0.02, output: 1.25 },
    // Older / estimated — adjust to your tenant's actual pricing
    'gpt-5.3-codex': { input: 1.25, cached_input: 0.125, output: 10.0 },
    'gpt-5.3-mini': { input: 0.25, cached_input: 0.025, output: 2.0 },
    'gpt-5.3': { input: 5.0, cached_input: 0.5, output: 40.0 },
    // Anthropic — 90% cache-read discount on all cache-eligible tiers
    'claude-opus-4-7': { input: 15.0, cached_input: 1.5, output: 75.0 },
    'claude-opus-4-6': { input: 15.0, cached_input: 1.5, output: 75.0 },
    'claude-sonnet-4-6': { input: 3.0, cached_input: 0.3, output: 15.0 },
    'claude-haiku-4-5': { input: 0.8, cached_input: 0.08, output: 4.0 },
  },
  fallback: { input: 1.25, cached_input: 0.125, output: 10.0 },
};

const CANDIDATE_PATHS = [
  path.join(os.homedir(), '.config', 'nanoclaw', 'model-pricing.json'),
  path.join(os.homedir(), '.nanoclaw', 'model-pricing.json'),
];

let cached: PricingFile | null = null;
let cachePath: string | null = null;

function loadPricing(): PricingFile {
  if (cached) return cached;
  for (const p of CANDIDATE_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as PricingFile;
      cached = parsed;
      cachePath = p;
      logger.info(
        {
          path: p,
          models: Object.keys(parsed.prices || {}).length,
          lastUpdated: parsed.lastUpdated,
        },
        'Model pricing table loaded',
      );
      return cached;
    } catch (err) {
      logger.warn(
        { path: p, err: err instanceof Error ? err.message : String(err) },
        'Failed to parse pricing file — trying next / falling back to embedded',
      );
    }
  }
  cached = EMBEDDED_DEFAULTS;
  return cached;
}

/** Force a re-read on next lookup (for tests, or after user edits). */
export function resetPricingCache(): void {
  cached = null;
  cachePath = null;
}

export function getPricingFilePath(): string | null {
  loadPricing();
  return cachePath;
}

export function lookupPrice(model: string | null | undefined): ModelPrice {
  const table = loadPricing();
  if (model && table.prices && table.prices[model]) return table.prices[model];
  return table.fallback || EMBEDDED_DEFAULTS.fallback!;
}

export interface RunCostBreakdown {
  /** Total billed USD for the run. */
  totalUsd: number;
  /** USD paid for uncached input tokens. */
  uncachedInputUsd: number;
  /** USD paid for cached input tokens (discounted). */
  cachedInputUsd: number;
  /** USD paid for output tokens (includes reasoning — same rate). */
  outputUsd: number;
  /** USD that WOULD have been charged if these cached tokens were uncached. */
  cacheSavedUsd: number;
  /** Effective cached-rate used (USD per 1M). */
  cachedRate: number;
}

/**
 * Compute USD cost for a single run with cached-token awareness.
 *
 * inputTokens is the raw model-side total (INCLUDES cached). We split it
 * into cached and uncached portions and bill each at its own rate. If
 * cachedInputTokens is unknown (legacy rows), we treat all input as
 * uncached — slightly over-bills, but safely on the conservative side.
 * Returns a zeroed breakdown when token counts are missing entirely.
 */
export function computeRunCost(params: {
  model: string | null | undefined;
  inputTokens: number | null | undefined;
  cachedInputTokens?: number | null;
  outputTokens: number | null | undefined;
}): RunCostBreakdown {
  const { inputTokens, outputTokens } = params;
  const cached = params.cachedInputTokens ?? 0;

  const price = lookupPrice(params.model);
  const cachedRate =
    price.cached_input !== undefined ? price.cached_input : price.input * 0.1;

  const zero: RunCostBreakdown = {
    totalUsd: 0,
    uncachedInputUsd: 0,
    cachedInputUsd: 0,
    outputUsd: 0,
    cacheSavedUsd: 0,
    cachedRate,
  };
  if (inputTokens == null && outputTokens == null) return zero;

  const inp = inputTokens || 0;
  const out = outputTokens || 0;
  const uncached = Math.max(inp - cached, 0);

  const uncachedInputUsd = (uncached / 1_000_000) * price.input;
  const cachedInputUsd = (cached / 1_000_000) * cachedRate;
  const outputUsd = (out / 1_000_000) * price.output;
  const cacheSavedUsd = (cached / 1_000_000) * (price.input - cachedRate);

  return {
    totalUsd: uncachedInputUsd + cachedInputUsd + outputUsd,
    uncachedInputUsd,
    cachedInputUsd,
    outputUsd,
    cacheSavedUsd,
    cachedRate,
  };
}

/** Back-compat alias. Returns the single total USD. */
export function computeRunCostUsd(params: {
  model: string | null | undefined;
  inputTokens: number | null | undefined;
  cachedInputTokens?: number | null;
  outputTokens: number | null | undefined;
}): number {
  return computeRunCost(params).totalUsd;
}
