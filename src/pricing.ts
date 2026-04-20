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
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
}

interface PricingFile {
  prices?: Record<string, ModelPrice>;
  fallback?: ModelPrice;
  lastUpdated?: string;
}

const EMBEDDED_DEFAULTS: PricingFile = {
  lastUpdated: '2026-04-20 (embedded baseline — verify before relying on)',
  prices: {
    'gpt-5.4-mini': { input: 0.25, output: 2.0 },
    'gpt-5.4': { input: 1.25, output: 10.0 },
    'gpt-5.3-codex': { input: 1.25, output: 10.0 },
    'gpt-5.3-mini': { input: 0.25, output: 2.0 },
    'gpt-5.3': { input: 5.0, output: 40.0 },
    'claude-opus-4-7': { input: 15.0, output: 75.0 },
    'claude-opus-4-6': { input: 15.0, output: 75.0 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
    'claude-haiku-4-5': { input: 0.8, output: 4.0 },
  },
  fallback: { input: 1.25, output: 10.0 },
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

/**
 * Compute USD cost for a single run. Returns 0 if we don't have token
 * counts (can't price an unmeasured run).
 */
export function computeRunCostUsd(params: {
  model: string | null | undefined;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
}): number {
  const { inputTokens, outputTokens } = params;
  if (inputTokens == null && outputTokens == null) return 0;
  const price = lookupPrice(params.model);
  const inCost = ((inputTokens || 0) / 1_000_000) * price.input;
  const outCost = ((outputTokens || 0) / 1_000_000) * price.output;
  return inCost + outCost;
}
