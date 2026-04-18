/**
 * Stdio MCP Server: Apple Reminders proxy.
 *
 * Thin proxy over HTTP to scripts/reminders-host/ (a Swift app running on the
 * Mac mini). Every tool here is a fetch() to host.docker.internal:3002.
 *
 * Contract: docs/apple-reminders-mcp.md
 * Provider: container/providers/reminders.json
 *
 * Launched by the agent runner via the provider registry — same lifecycle
 * as other per-provider MCP servers (ms365, gws_mcp).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { hostFetch as rawHostFetch, remindersHost } from './host-fetch.js';

const HOST = remindersHost();

function hostFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  return rawHostFetch<T>(HOST, path, init);
}

interface ListInfo {
  id: string;
  name: string;
  isDefault: boolean;
  source: string;
}

interface ReminderInfo {
  id: string;
  title: string;
  notes: string | null;
  due: string | null;
  priority: 'high' | 'medium' | 'low' | 'none';
  completed: boolean;
  completedAt: string | null;
  listId: string;
  listName: string;
  parentId: string | null;
  alert: string | null;
  alertBeforeDue: string | null;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

async function safeCall<T>(fn: () => Promise<T>): Promise<
  { ok: true; value: T } | { ok: false; message: string }
> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

const server = new McpServer({ name: 'reminders', version: '1.0.0' });

// ---- reminder_list_available ---------------------------------------------

server.tool(
  'reminder_list_available',
  'Enumerate the user\'s Apple Reminders lists. Call this before creating reminders in an unfamiliar list, or to surface the list taxonomy to the user.',
  {},
  async () => {
    const r = await safeCall(() => hostFetch<ListInfo[]>('/lists'));
    if (!r.ok) return err(r.message);
    const lists = r.value ?? [];
    if (lists.length === 0) return ok('No reminder lists found.');
    const lines = ['Available lists:'];
    for (const l of lists) {
      const def = l.isDefault ? ' (default)' : '';
      lines.push(`  - ${l.name}${def} [id=${l.id}] (source: ${l.source})`);
    }
    return ok(lines.join('\n'));
  },
);

// ---- reminder_list_create -------------------------------------------------

server.tool(
  'reminder_list_create',
  'Create a new reminders list. Only use when the user has explicitly asked for a new list; routine item adds belong in existing lists.',
  {
    name: z
      .string()
      .describe('User-visible title of the new list (e.g. "Conference Trip").'),
    source: z
      .string()
      .optional()
      .describe(
        'Optional EventKit source ("iCloud", "Local", etc.). Omit for the user\'s default source — recommended unless you have a reason to pick.',
      ),
  },
  async (args) => {
    const r = await safeCall(() =>
      hostFetch<ListInfo>('/lists', {
        method: 'POST',
        body: JSON.stringify({ name: args.name, source: args.source }),
      }),
    );
    if (!r.ok) return err(r.message);
    const l = r.value!;
    return ok(`Created list: ${l.id} — "${l.name}"`);
  },
);

// ---- reminder_create ------------------------------------------------------

server.tool(
  'reminder_create',
  'Create a reminder. For email-triage todos, encode email metadata in notes as JSON (same convention as the legacy todo_create tool). For time-sensitive nudges, set alert or alert_before_due so iOS actually notifies.',
  {
    title: z.string().describe('Short action description.'),
    notes: z.string().optional(),
    due: z
      .string()
      .optional()
      .describe('ISO-8601. Omit for no due date.'),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    list: z
      .string()
      .optional()
      .describe('List name or id. Omit for the default list.'),
    parent_id: z
      .string()
      .optional()
      .describe('If set, create as subtask of this reminder (same list required).'),
    alert: z
      .string()
      .optional()
      .describe('Absolute ISO-8601 time at which iOS should notify.'),
    alert_before_due: z
      .string()
      .optional()
      .describe('Relative alert: "15min", "1h", or "1d". Requires due to be set; cannot combine with alert.'),
  },
  async (args: {
    title: string;
    notes?: string;
    due?: string;
    priority?: 'high' | 'medium' | 'low';
    list?: string;
    parent_id?: string;
    alert?: string;
    alert_before_due?: string;
  }) => {
    const body = {
      title: args.title,
      notes: args.notes,
      due: args.due,
      priority: args.priority,
      list: args.list,
      parentId: args.parent_id,
      alert: args.alert,
      alertBeforeDue: args.alert_before_due,
    };
    const r = await safeCall(() =>
      hostFetch<{ id: string }>('/reminders', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
    if (!r.ok) return err(r.message);
    return ok(`Created: ${r.value!.id} — "${args.title}"`);
  },
);

// ---- reminder_list --------------------------------------------------------

function formatReminders(reminders: ReminderInfo[]): string {
  if (reminders.length === 0) return 'No reminders found.';

  // Sort: overdue first, then by due date (null last), then by priority.
  const priOrder: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
  const now = new Date().toISOString();
  reminders.sort((a, b) => {
    const aOver = a.due && a.due < now && !a.completed ? 0 : 1;
    const bOver = b.due && b.due < now && !b.completed ? 0 : 1;
    if (aOver !== bOver) return aOver - bOver;
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return priOrder[a.priority] - priOrder[b.priority];
  });

  // Group by listName
  const byList = new Map<string, ReminderInfo[]>();
  for (const r of reminders) {
    const arr = byList.get(r.listName) ?? [];
    arr.push(r);
    byList.set(r.listName, arr);
  }

  const out: string[] = [];
  for (const [listName, items] of byList) {
    out.push(`**${listName}** (${items.length})`);
    for (const r of items) {
      const check = r.completed ? '[x]' : '[ ]';
      const due = r.due ? ` (due ${r.due.slice(0, 16).replace('T', ' ')})` : '';
      const pri = r.priority !== 'medium' && r.priority !== 'none' ? ` [${r.priority}]` : '';
      const overdue = r.due && r.due < now && !r.completed ? ' ⚠️ OVERDUE' : '';
      const doneAt = r.completed && r.completedAt
        ? `  ✓ ${r.completedAt.slice(0, 16).replace('T', ' ')}`
        : '';
      const alert = r.alert
        ? ` 🔔 ${r.alert.slice(0, 16).replace('T', ' ')}`
        : r.alertBeforeDue
          ? ` 🔔 ${r.alertBeforeDue} before`
          : '';
      out.push(`${check} ${r.id}: ${r.title}${due}${pri}${alert}${overdue}${doneAt}`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

server.tool(
  'reminder_list',
  'Query reminders. Use status="recently_completed" for reconciliation (things the user tap-completed on iPhone in the last 24h).',
  {
    list: z.string().optional().describe('Filter by list name or id. Omit for all lists.'),
    status: z
      .enum(['pending', 'completed', 'recently_completed', 'all'])
      .optional()
      .describe('Default: pending.'),
    include_notes: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args: {
    list?: string;
    status?: 'pending' | 'completed' | 'recently_completed' | 'all';
    include_notes?: boolean;
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    if (args.list) params.set('list', args.list);
    params.set('status', args.status ?? 'pending');
    if (args.limit) params.set('limit', String(args.limit));

    const r = await safeCall(() =>
      hostFetch<ReminderInfo[]>(`/reminders?${params.toString()}`),
    );
    if (!r.ok) return err(r.message);
    const reminders = r.value ?? [];

    // Strip notes unless include_notes. Default false to keep tool output tight.
    const trimmed = args.include_notes
      ? reminders
      : reminders.map((x) => ({ ...x, notes: null }));
    return ok(formatReminders(trimmed));
  },
);

// ---- reminder_update ------------------------------------------------------

server.tool(
  'reminder_update',
  'Edit fields of an existing reminder.',
  {
    id: z.string(),
    title: z.string().optional(),
    notes: z.string().optional().describe('Empty string clears notes.'),
    due: z.string().optional().describe('ISO-8601.'),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    list: z.string().optional(),
    parent_id: z.string().optional(),
    alert: z.string().optional(),
    alert_before_due: z.string().optional(),
  },
  async (args: {
    id: string;
    title?: string;
    notes?: string;
    due?: string;
    priority?: 'high' | 'medium' | 'low';
    list?: string;
    parent_id?: string;
    alert?: string;
    alert_before_due?: string;
  }) => {
    const { id, ...rest } = args;
    const body = {
      title: rest.title,
      notes: rest.notes,
      due: rest.due,
      priority: rest.priority,
      list: rest.list,
      parentId: rest.parent_id,
      alert: rest.alert,
      alertBeforeDue: rest.alert_before_due,
    };
    const r = await safeCall(() =>
      hostFetch<{ ok: boolean }>(`/reminders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    );
    if (!r.ok) return err(r.message);
    return ok(`Updated: ${id}`);
  },
);

// ---- reminder_complete / uncomplete --------------------------------------

server.tool(
  'reminder_complete',
  'Mark a reminder as completed. iCloud syncs the check to iPhone.',
  { id: z.string() },
  async (args: { id: string }) => {
    const r = await safeCall(() =>
      hostFetch(`/reminders/${encodeURIComponent(args.id)}/complete`, {
        method: 'POST',
      }),
    );
    if (!r.ok) return err(r.message);
    return ok(`Completed: ${args.id}`);
  },
);

server.tool(
  'reminder_uncomplete',
  'Reopen a completed reminder.',
  { id: z.string() },
  async (args: { id: string }) => {
    const r = await safeCall(() =>
      hostFetch(`/reminders/${encodeURIComponent(args.id)}/uncomplete`, {
        method: 'POST',
      }),
    );
    if (!r.ok) return err(r.message);
    return ok(`Reopened: ${args.id}`);
  },
);

// ---- reminder_delete ------------------------------------------------------

server.tool(
  'reminder_delete',
  'Delete a reminder permanently. iCloud syncs the delete; no undo.',
  { id: z.string() },
  async (args: { id: string }) => {
    const r = await safeCall(() =>
      hostFetch(`/reminders/${encodeURIComponent(args.id)}`, {
        method: 'DELETE',
      }),
    );
    if (!r.ok) return err(r.message);
    return ok(`Deleted: ${args.id}`);
  },
);

// --- Boot ------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('reminders-mcp failed to start:', e);
  process.exit(1);
});
