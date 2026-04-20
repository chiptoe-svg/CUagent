/**
 * Fetch live pricing from provider pages and rewrite
 * `~/.config/nanoclaw/model-pricing.json`.
 *
 * Host-side command — no agent involvement, zero token cost. Called from
 * the `/refresh-pricing` Telegram handler. Since HTML-scraping is brittle,
 * the implementation is defensive: it parses the small number of rows we
 * actually care about and leaves any existing unrecognised entries in the
 * user's pricing file alone so manual overrides survive a refresh.
 *
 * Sources:
 *   OpenAI   → https://developers.openai.com/api/docs/pricing
 *   Anthropic → https://claude.com/pricing
 *
 * Parses the structured pricing tables on each page. If the page layout
 * changes enough that parsing fails for a given row, we skip that row and
 * report the skip count back to the caller — the old value remains in the
 * file so cost reports don't break.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';
import { resetPricingCache, type ModelPrice } from './pricing.js';

const PRICING_FILE_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'model-pricing.json',
);

export interface PricingRefreshResult {
  ok: boolean;
  openaiCount: number;
  anthropicCount: number;
  skippedRows: string[];
  error?: string;
  writtenPath?: string;
}

function parseMoney(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Pull text content for every HTML table row on a page. Deliberately
 * tolerant — we just want the 3–5 numeric cells per row. Returns rows as
 * arrays of string cells.
 */
function extractTableRows(html: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    const inner = rowMatch[1];
    while ((cellMatch = cellRe.exec(inner)) !== null) {
      const txt = cellMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
      cells.push(txt);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'NanoClaw/1.0 pricing-refresh' },
  });
  if (!resp.ok) throw new Error(`${url} returned ${resp.status}`);
  return resp.text();
}

async function fetchOpenAiPrices(
  skipped: string[],
): Promise<Record<string, ModelPrice>> {
  const html = await fetchText('https://developers.openai.com/api/docs/pricing');
  const rows = extractTableRows(html);
  const prices: Record<string, ModelPrice> = {};

  for (const row of rows) {
    if (row.length < 3) continue;
    // Typical row: [model, input $, cached input $, output $] or similar.
    const model = row[0];
    if (!/^gpt-|^o[0-9]/i.test(model)) continue;
    // Last cell is usually output; first money-looking cell is input.
    const moneyCells = row.slice(1).map(parseMoney);
    const inputIdx = moneyCells.findIndex((v) => v !== null);
    if (inputIdx < 0) {
      skipped.push(`openai: no input price for "${model}"`);
      continue;
    }
    const input = moneyCells[inputIdx]!;
    // Cached = next money cell, output = last money cell (if distinct).
    const later = moneyCells.slice(inputIdx + 1).filter((v) => v !== null) as number[];
    const output = later.length > 0 ? later[later.length - 1] : null;
    const cached = later.length >= 2 ? later[0] : null;
    if (output === null) {
      skipped.push(`openai: no output price for "${model}"`);
      continue;
    }
    const entry: ModelPrice = { input, output };
    if (cached !== null && cached < input) entry.cached_input = cached;
    prices[model] = entry;
  }
  return prices;
}

async function fetchAnthropicPrices(
  skipped: string[],
): Promise<Record<string, ModelPrice>> {
  const html = await fetchText('https://claude.com/pricing');
  const rows = extractTableRows(html);
  const prices: Record<string, ModelPrice> = {};

  // Map marketing names to our canonical IDs. Anthropic's pricing table
  // labels by tier ("Opus 4.7"); API uses ids like claude-opus-4-7.
  const aliases: Array<[RegExp, string]> = [
    [/opus\s*4\.?7/i, 'claude-opus-4-7'],
    [/opus\s*4\.?6/i, 'claude-opus-4-6'],
    [/sonnet\s*4\.?6/i, 'claude-sonnet-4-6'],
    [/sonnet\s*4\.?5/i, 'claude-sonnet-4-5'],
    [/haiku\s*4\.?5/i, 'claude-haiku-4-5'],
  ];

  for (const row of rows) {
    if (row.length < 3) continue;
    const label = row[0];
    const match = aliases.find(([re]) => re.test(label));
    if (!match) continue;
    const moneyCells = row.slice(1).map(parseMoney);
    const nums = moneyCells.filter((v) => v !== null) as number[];
    if (nums.length < 2) {
      skipped.push(`anthropic: not enough price cells for "${label}"`);
      continue;
    }
    // Anthropic ordering: input, cache-read, cache-write-5m, (cache-write-1h), output.
    // We take: first = input, second = cache-read, last = output.
    const input = nums[0];
    const cached = nums[1];
    const output = nums[nums.length - 1];
    prices[match[1]] = { input, cached_input: cached, output };
  }
  return prices;
}

export async function refreshPricing(): Promise<PricingRefreshResult> {
  const skipped: string[] = [];
  try {
    const [openai, anthropic] = await Promise.all([
      fetchOpenAiPrices(skipped),
      fetchAnthropicPrices(skipped),
    ]);

    const openaiCount = Object.keys(openai).length;
    const anthropicCount = Object.keys(anthropic).length;
    if (openaiCount === 0 && anthropicCount === 0) {
      return {
        ok: false,
        openaiCount,
        anthropicCount,
        skippedRows: skipped,
        error: 'Both pages returned zero parseable rows — refresh aborted.',
      };
    }

    // Merge over existing file so manual entries (local models, legacy
    // rates) survive. Provider-fetched rows overwrite.
    let existing: { prices?: Record<string, ModelPrice>; fallback?: ModelPrice } =
      {};
    try {
      existing = JSON.parse(fs.readFileSync(PRICING_FILE_PATH, 'utf-8'));
    } catch {
      /* first run or unreadable — start fresh */
    }

    const merged = {
      _comment:
        'Per-million-token USD prices. Refreshed by /refresh-pricing on this date. Edit freely — manual entries are preserved on next refresh.',
      _verified: `${new Date().toISOString().slice(0, 10)} via /refresh-pricing`,
      lastUpdated: new Date().toISOString().slice(0, 10),
      prices: {
        ...(existing.prices || {}),
        ...openai,
        ...anthropic,
      },
      fallback: existing.fallback || {
        input: 1.25,
        cached_input: 0.125,
        output: 10.0,
      },
    };

    fs.mkdirSync(path.dirname(PRICING_FILE_PATH), { recursive: true });
    fs.writeFileSync(
      PRICING_FILE_PATH,
      JSON.stringify(merged, null, 2) + '\n',
    );
    resetPricingCache();

    logger.info(
      { openaiCount, anthropicCount, skipped: skipped.length },
      'Pricing refreshed from live pages',
    );

    return {
      ok: true,
      openaiCount,
      anthropicCount,
      skippedRows: skipped,
      writtenPath: PRICING_FILE_PATH,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Pricing refresh failed');
    return {
      ok: false,
      openaiCount: 0,
      anthropicCount: 0,
      skippedRows: skipped,
      error,
    };
  }
}
