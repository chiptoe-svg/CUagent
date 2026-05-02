// Gmail listing + body fetch via the `gws` CLI
// (https://github.com/google/google-workspace-cli or equivalent).
// If GWS_BIN is unset, listGmail() returns []; this lets the repo run
// MS365-only without a Gmail toolchain installed.

import { execFileSync } from 'child_process';

import { GWS_BIN } from './config.js';
import { log } from './log.js';
import { MAX_BODY_CHARS, normalizeBody } from './normalize.js';
import { EmailMinimal } from './types.js';

function gwsAvailable(): boolean {
  return Boolean(GWS_BIN);
}

export function listGmail(sinceIso: string | null): EmailMinimal[] {
  if (!gwsAvailable()) return [];
  const q = sinceIso
    ? `in:inbox after:${Math.floor(new Date(sinceIso).getTime() / 1000)}`
    : 'in:inbox newer_than:1d';
  let ids: string[] = [];
  try {
    const listOut = execFileSync(
      GWS_BIN,
      [
        'gmail',
        'users',
        'messages',
        'list',
        '--params',
        JSON.stringify({ userId: 'me', q, maxResults: 50 }),
        '--format',
        'json',
      ],
      {
        encoding: 'utf-8',
        env: { ...process.env, GWS_CREDENTIAL_STORE: 'plaintext' },
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const parsed = JSON.parse(listOut) as { messages?: Array<{ id: string }> };
    ids = (parsed.messages || []).map((m) => m.id);
  } catch (err) {
    log.debug('gmail list failed', { err: String(err) });
    return [];
  }

  const out: EmailMinimal[] = [];
  for (const id of ids) {
    try {
      const getOut = execFileSync(
        GWS_BIN,
        [
          'gmail',
          'users',
          'messages',
          'get',
          '--params',
          JSON.stringify({
            userId: 'me',
            id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          }),
          '--format',
          'json',
        ],
        {
          encoding: 'utf-8',
          env: { ...process.env, GWS_CREDENTIAL_STORE: 'plaintext' },
          timeout: 15_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const msg = JSON.parse(getOut) as {
        threadId?: string;
        internalDate?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      };
      const headers = msg.payload?.headers || [];
      const header = (n: string): string =>
        headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ||
        '';
      out.push({
        id,
        account: 'gmail',
        from: header('From'),
        subject: header('Subject'),
        conversationId: msg.threadId,
        receivedIso: msg.internalDate
          ? new Date(parseInt(msg.internalDate, 10)).toISOString()
          : undefined,
      });
    } catch {
      /* per-message failure is fine */
    }
  }
  return out;
}

export function fetchGmailBody(id: string): string {
  if (!gwsAvailable()) return '';
  try {
    const out = execFileSync(
      GWS_BIN,
      [
        'gmail',
        'users',
        'messages',
        'get',
        '--params',
        JSON.stringify({ userId: 'me', id, format: 'full' }),
        '--format',
        'json',
      ],
      {
        encoding: 'utf-8',
        env: { ...process.env, GWS_CREDENTIAL_STORE: 'plaintext' },
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const msg = JSON.parse(out) as {
      payload?: {
        mimeType?: string;
        body?: { data?: string };
        parts?: unknown;
      };
      snippet?: string;
    };
    const decodePart = (d?: string): string => {
      if (!d) return '';
      try {
        return Buffer.from(
          d.replace(/-/g, '+').replace(/_/g, '/'),
          'base64',
        ).toString('utf-8');
      } catch {
        return '';
      }
    };
    const walk = (
      node:
        | { mimeType?: string; body?: { data?: string }; parts?: unknown }
        | undefined,
      type: 'text/plain' | 'text/html',
    ): string => {
      if (!node) return '';
      const n = node as {
        mimeType?: string;
        body?: { data?: string };
        parts?: Array<unknown>;
      };
      if (n.mimeType === type && n.body?.data) return decodePart(n.body.data);
      if (Array.isArray(n.parts)) {
        for (const part of n.parts) {
          const found = walk(part as typeof n, type);
          if (found) return found;
        }
      }
      return '';
    };
    const plain = walk(msg.payload, 'text/plain');
    if (plain) return normalizeBody(plain);
    const html = walk(msg.payload, 'text/html');
    if (html) return normalizeBody(html);
    return (msg.snippet || '').slice(0, MAX_BODY_CHARS);
  } catch (err) {
    log.debug('gmail body fetch failed', { id, err: String(err) });
    return '';
  }
}
