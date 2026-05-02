import path from 'path';
import fs from 'fs';

function loadDotEnv(): void {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    if (m[0].trimStart().startsWith('#')) continue;
    const [, key, raw] = m;
    if (key in process.env) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
}
loadDotEnv();

export const MODE = (process.env.MODE || 'preclassifier') as
  | 'preclassifier'
  | 'agent'
  | 'hybrid';

export const DRY_RUN = process.env.DRY_RUN === '1';

export const CONFIG_DIR = path.resolve(
  process.env.CONFIG_DIR || path.join(process.cwd(), 'config'),
);
export const STATE_DIR = path.resolve(
  process.env.STATE_DIR || path.join(process.cwd(), 'state'),
);

export const TIMEZONE = process.env.TZ || 'America/New_York';

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

export const CODEX_BIN = process.env.CODEX_BIN || 'codex';
export const CODEX_MODEL = process.env.CODEX_MODEL || OPENAI_MODEL;

export const MS365_CLIENT_ID = process.env.MS365_CLIENT_ID || '';
export const MS365_TENANT_ID = process.env.MS365_TENANT_ID || 'common';
export const MS365_REFRESH_TOKEN = process.env.MS365_REFRESH_TOKEN || '';

export const GWS_BIN = process.env.GWS_BIN || '';
