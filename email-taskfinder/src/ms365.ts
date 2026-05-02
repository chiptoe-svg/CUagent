// Minimal MS365 helpers — token refresh, Outlook listing, body fetch, and
// To Do task creation. The original CUagent reads tokens from an MSAL cache
// owned by the in-container MCP server; here we go simpler: refresh token
// in .env, fetched on demand, cached in-process for ~50 minutes.

import {
  MS365_CLIENT_ID,
  MS365_REFRESH_TOKEN,
  MS365_TENANT_ID,
  TIMEZONE,
} from './config.js';
import { log } from './log.js';
import { normalizeBody } from './normalize.js';
import { assertGraphScope } from './permissions.js';
import { EmailMinimal } from './types.js';

let cachedToken: { value: string; expiresAtMs: number } | null = null;

export async function getMs365AccessToken(): Promise<string | null> {
  if (!MS365_CLIENT_ID || !MS365_REFRESH_TOKEN) {
    log.debug('ms365: not configured (missing client id or refresh token)');
    return null;
  }
  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 60_000) {
    return cachedToken.value;
  }
  try {
    const resp = await fetch(
      `https://login.microsoftonline.com/${MS365_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: MS365_CLIENT_ID,
          refresh_token: MS365_REFRESH_TOKEN,
          scope:
            'https://graph.microsoft.com/Mail.ReadWrite ' +
            'https://graph.microsoft.com/Tasks.ReadWrite',
        }).toString(),
      },
    );
    if (!resp.ok) {
      log.warn('ms365: token refresh failed', {
        status: resp.status,
        body: (await resp.text()).slice(0, 200),
      });
      return null;
    }
    const data = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) return null;
    cachedToken = {
      value: data.access_token,
      expiresAtMs: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return cachedToken.value;
  } catch (err) {
    log.warn('ms365: token endpoint unreachable', { err: String(err) });
    return null;
  }
}

export async function listOutlook(
  sinceIso: string | null,
): Promise<EmailMinimal[]> {
  assertGraphScope('Mail.Read');
  const token = await getMs365AccessToken();
  if (!token) return [];
  const params = new URLSearchParams({
    $select: 'id,subject,from,conversationId,receivedDateTime',
    $top: '50',
    $orderby: 'receivedDateTime desc',
  });
  if (sinceIso) params.set('$filter', `receivedDateTime ge ${sinceIso}`);
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?${params}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      log.debug('outlook list failed', { status: r.status });
      return [];
    }
    const body = (await r.json()) as {
      value?: Array<{
        id: string;
        subject?: string;
        from?: { emailAddress?: { address?: string } };
        conversationId?: string;
        receivedDateTime?: string;
      }>;
    };
    return (body.value || []).map((m) => ({
      id: m.id,
      account: 'outlook' as const,
      from: m.from?.emailAddress?.address || '',
      subject: m.subject || '',
      conversationId: m.conversationId,
      receivedIso: m.receivedDateTime,
    }));
  } catch (err) {
    log.debug('outlook fetch threw', { err: String(err) });
    return [];
  }
}

export async function fetchOutlookBody(id: string): Promise<string> {
  assertGraphScope('Mail.Read');
  const token = await getMs365AccessToken();
  if (!token) return '';
  try {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${id}?$select=body,bodyPreview`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return '';
    const body = (await r.json()) as {
      body?: { contentType?: string; content?: string };
      bodyPreview?: string;
    };
    const raw = body.body?.content || body.bodyPreview || '';
    return normalizeBody(raw);
  } catch (err) {
    log.debug('outlook body fetch failed', { id, err: String(err) });
    return '';
  }
}

export async function getDefaultTodoListId(): Promise<string | null> {
  assertGraphScope('Tasks.ReadWrite');
  const token = await getMs365AccessToken();
  if (!token) return null;
  try {
    const r = await fetch('https://graph.microsoft.com/v1.0/me/todo/lists', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as {
      value?: Array<{
        id: string;
        displayName?: string;
        wellknownListName?: string;
      }>;
    };
    const lists = body.value || [];
    const preferred =
      lists.find((l) => l.wellknownListName === 'defaultList') ||
      lists.find((l) => l.displayName === 'Tasks') ||
      lists[0];
    return preferred?.id ?? null;
  } catch {
    return null;
  }
}

export async function createMs365Task(
  listId: string,
  title: string,
  dueIsoLocal?: string,
): Promise<string | null> {
  assertGraphScope('Tasks.ReadWrite');
  const token = await getMs365AccessToken();
  if (!token) return null;
  const body: Record<string, unknown> = {
    title,
    body: { content: '', contentType: 'text' },
    importance: 'normal',
  };
  if (dueIsoLocal) {
    body.dueDateTime = { dateTime: dueIsoLocal, timeZone: TIMEZONE };
  }
  try {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      log.warn('todo task creation failed', { status: r.status, title });
      return null;
    }
    const created = (await r.json()) as { id?: string };
    return created.id ?? null;
  } catch (err) {
    log.warn('todo task creation threw', { err: String(err) });
    return null;
  }
}

export function computeDueIsoLocal(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 19);
}
