/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// --- Todo list tools (DEPRECATED) ---
// Simple file-backed todo list. Stored as JSON in the group folder.
// SUPERSEDED by the reminders MCP (mcp__reminders__reminder_*) which writes to
// Apple Reminders via the host-side Swift app and syncs to iPhone via iCloud.
//
// Kept alive as a fallback when the reminders provider isn't installed or the
// Mac mini's host service is unreachable. Each mutating tool logs a deprecation
// warning on use; the one-shot todo_migrate_to_reminders tool moves existing
// items into Apple Reminders.
//
// Removal target: after all active deployments have migrated and at least one
// release with the deprecation warnings has shipped.

const DEPRECATION_NOTICE =
  '[deprecated] todo_* tools are superseded by mcp__reminders__reminder_*. Run todo_migrate_to_reminders to move existing items, then prefer the reminders tools going forward.';

const TODO_FILE = path.join('/workspace/group', 'todos.json');

interface TodoItem {
  id: string;
  title: string;
  notes: string | null;
  due: string | null;
  priority: 'high' | 'medium' | 'low';
  list: string;
  completed: boolean;
  created: string;
  completed_at: string | null;
}

function readTodos(): TodoItem[] {
  try {
    if (fs.existsSync(TODO_FILE)) {
      return JSON.parse(fs.readFileSync(TODO_FILE, 'utf-8'));
    }
  } catch { /* ignore parse errors */ }
  return [];
}

function writeTodos(todos: TodoItem[]): void {
  fs.writeFileSync(TODO_FILE, JSON.stringify(todos, null, 2));
}

server.tool(
  'todo_create',
  'Create a todo item. Use for email action items, reminders, or any task to track. Returns the new item ID.',
  {
    title: z.string().describe('Short action description (e.g., "Reply to Dr. Smith re: budget meeting")'),
    notes: z.string().optional().describe('Additional context — for email todos, include email ID, account, sender, subject, proposed folder as JSON'),
    due: z.string().optional().describe('Due date in ISO format (e.g., "2026-04-16T17:00:00"). Omit for no deadline.'),
    priority: z.enum(['high', 'medium', 'low']).default('medium').describe('Priority level'),
    list: z.string().default('General').describe('List name (e.g., "Email Actions", "General")'),
  },
  async (args) => {
    console.warn(DEPRECATION_NOTICE);
    const todos = readTodos();
    const item: TodoItem = {
      id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: args.title,
      notes: args.notes || null,
      due: args.due || null,
      priority: args.priority,
      list: args.list,
      completed: false,
      created: new Date().toISOString(),
      completed_at: null,
    };
    todos.push(item);
    writeTodos(todos);
    return { content: [{ type: 'text' as const, text: `Created: ${item.id} — "${item.title}"` }] };
  },
);

server.tool(
  'todo_list',
  'List todo items. Filter by list, status, or get everything.',
  {
    list: z.string().optional().describe('Filter by list name (e.g., "Email Actions"). Omit for all lists.'),
    status: z.enum(['pending', 'completed', 'all']).default('pending').describe('Filter by status'),
    include_notes: z.boolean().default(false).describe('Include notes field in output'),
  },
  async (args) => {
    console.warn(DEPRECATION_NOTICE);
    let todos = readTodos();
    if (args.list) {
      todos = todos.filter(t => t.list === args.list);
    }
    if (args.status === 'pending') {
      todos = todos.filter(t => !t.completed);
    } else if (args.status === 'completed') {
      todos = todos.filter(t => t.completed);
    }

    if (todos.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No items found.' }] };
    }

    // Sort: overdue first, then by due date, then by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const now = new Date().toISOString();
    todos.sort((a, b) => {
      // Overdue items first
      const aOverdue = a.due && a.due < now && !a.completed ? 0 : 1;
      const bOverdue = b.due && b.due < now && !b.completed ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;
      // Then by due date (earliest first, null last)
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      // Then by priority
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    const lines = todos.map(t => {
      const check = t.completed ? '[x]' : '[ ]';
      const overdue = t.due && t.due < now && !t.completed ? ' ⚠️ OVERDUE' : '';
      const due = t.due ? ` (due ${t.due.slice(0, 10)})` : '';
      const pri = t.priority !== 'medium' ? ` [${t.priority}]` : '';
      let line = `${check} ${t.id}: ${t.title}${due}${pri}${overdue}`;
      if (args.include_notes && t.notes) {
        line += `\n    Notes: ${t.notes}`;
      }
      return line;
    });

    // Group by list
    const lists = new Map<string, string[]>();
    todos.forEach((t, i) => {
      const group = lists.get(t.list) || [];
      group.push(lines[i]);
      lists.set(t.list, group);
    });

    let output = '';
    for (const [listName, items] of lists) {
      output += `**${listName}** (${items.length})\n${items.join('\n')}\n\n`;
    }

    return { content: [{ type: 'text' as const, text: output.trim() }] };
  },
);

server.tool(
  'todo_complete',
  'Mark a todo item as completed. For email todos, this signals that the action is done and the email can be filed.',
  {
    id: z.string().describe('The todo item ID'),
  },
  async (args) => {
    console.warn(DEPRECATION_NOTICE);
    const todos = readTodos();
    const item = todos.find(t => t.id === args.id);
    if (!item) {
      return { content: [{ type: 'text' as const, text: `Not found: ${args.id}` }], isError: true };
    }
    if (item.completed) {
      return { content: [{ type: 'text' as const, text: `Already completed: "${item.title}"` }] };
    }
    item.completed = true;
    item.completed_at = new Date().toISOString();
    writeTodos(todos);
    return { content: [{ type: 'text' as const, text: `Completed: "${item.title}"` }] };
  },
);

server.tool(
  'todo_delete',
  'Delete a todo item permanently.',
  {
    id: z.string().describe('The todo item ID'),
  },
  async (args) => {
    console.warn(DEPRECATION_NOTICE);
    const todos = readTodos();
    const idx = todos.findIndex(t => t.id === args.id);
    if (idx === -1) {
      return { content: [{ type: 'text' as const, text: `Not found: ${args.id}` }], isError: true };
    }
    const removed = todos.splice(idx, 1)[0];
    writeTodos(todos);
    return { content: [{ type: 'text' as const, text: `Deleted: "${removed.title}"` }] };
  },
);

// --- One-shot todo → reminders migration ----------------------------------

import { hostFetch, remindersHost } from './host-fetch.js';

server.tool(
  'todo_migrate_to_reminders',
  'One-shot migration: move every open item in the file-backed todo list into Apple Reminders. Completed items are skipped. The todos file is renamed to todos.json.migrated when the migration finishes cleanly. Safe to re-run — if it runs again after a successful migration there will be no open items to move. Requires the reminders host service to be reachable.',
  {
    list: z.string().optional().describe('Apple Reminders list to write into (name or id). Defaults to the user\'s default list. Falls back to per-todo t.list when set on the original item.'),
    dry_run: z.boolean().default(false).describe('When true, report what would be migrated without creating reminders or archiving the file.'),
  },
  async (args) => {
    const todos = readTodos();
    const open = todos.filter(t => !t.completed);
    if (open.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No open todos to migrate.' }] };
    }

    const HOST = remindersHost();
    const results: string[] = [];
    let created = 0;
    let failed = 0;

    for (const t of open) {
      const targetList = args.list || t.list || undefined;
      if (args.dry_run) {
        results.push(`would migrate: ${t.id} → "${t.title}"${targetList ? ` (list: ${targetList})` : ''}`);
        continue;
      }
      try {
        const body = {
          title: t.title,
          notes: t.notes || undefined,
          due: t.due || undefined,
          priority: t.priority,
          list: targetList,
        };
        const r = await hostFetch<{ id: string }>(HOST, '/reminders', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        created += 1;
        results.push(`migrated: ${t.id} → reminder ${r?.id ?? '(unknown id)'}`);
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`FAILED: ${t.id} — ${msg}`);
      }
    }

    if (!args.dry_run && failed === 0 && created > 0) {
      // Archive the todos file so the next run is a no-op.
      try {
        fs.renameSync(TODO_FILE, `${TODO_FILE}.migrated`);
        results.push(`archived ${TODO_FILE} → ${TODO_FILE}.migrated`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`WARNING: migration succeeded but failed to archive todos file — ${msg}`);
      }
    }

    const header = args.dry_run
      ? `Dry run: ${open.length} open todo(s) would be migrated.`
      : `Migrated ${created}/${open.length} open todo(s). Failed: ${failed}.`;
    return {
      content: [{ type: 'text' as const, text: `${header}\n\n${results.join('\n')}` }],
      isError: failed > 0,
    };
  },
);

// --- File operation tools ---
// These provide Claude-like file tools (Read, Write, Edit, Glob, Grep) as MCP tools.
// Codex SDK only has bash — these eliminate API round-trips for file operations.

import { execSync } from 'child_process';

server.tool(
  'file_read',
  'Read a file and return its contents with line numbers. More efficient than using cat/head/tail via bash.',
  {
    path: z.string().describe('Absolute or workspace-relative file path'),
    offset: z.number().optional().describe('Start line (1-based). Omit to read from beginning.'),
    limit: z.number().optional().describe('Max lines to return. Omit to read entire file (up to 2000 lines).'),
  },
  async (args) => {
    try {
      const filePath = args.path.startsWith('/') ? args.path : path.join('/workspace/group', args.path);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, (args.offset || 1) - 1);
      const end = args.limit ? start + args.limit : Math.min(lines.length, start + 2000);
      const numbered = lines.slice(start, end).map((line, i) => `${start + i + 1}\t${line}`).join('\n');
      return { content: [{ type: 'text' as const, text: numbered || '(empty file)' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'file_write',
  'Write content to a file (creates or overwrites). More efficient than echo/cat heredoc via bash.',
  {
    path: z.string().describe('Absolute or workspace-relative file path'),
    content: z.string().describe('The full content to write'),
  },
  async (args) => {
    try {
      const filePath = args.path.startsWith('/') ? args.path : path.join('/workspace/group', args.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content);
      return { content: [{ type: 'text' as const, text: `Written ${args.content.length} bytes to ${filePath}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'file_edit',
  'Replace a specific string in a file. Fails if old_string is not found or not unique. More efficient than sed/awk via bash.',
  {
    path: z.string().describe('Absolute or workspace-relative file path'),
    old_string: z.string().describe('The exact text to find and replace'),
    new_string: z.string().describe('The replacement text'),
  },
  async (args) => {
    try {
      const filePath = args.path.startsWith('/') ? args.path : path.join('/workspace/group', args.path);
      const content = fs.readFileSync(filePath, 'utf-8');
      const count = content.split(args.old_string).length - 1;
      if (count === 0) return { content: [{ type: 'text' as const, text: `Error: old_string not found in ${filePath}` }], isError: true };
      if (count > 1) return { content: [{ type: 'text' as const, text: `Error: old_string found ${count} times — must be unique. Add more context.` }], isError: true };
      fs.writeFileSync(filePath, content.replace(args.old_string, args.new_string));
      return { content: [{ type: 'text' as const, text: `Edited ${filePath}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'file_glob',
  'Find files matching a glob pattern. More efficient than find/ls via bash.',
  {
    pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "config.*")'),
    cwd: z.string().optional().describe('Directory to search in (default: /workspace/group)'),
  },
  async (args) => {
    try {
      const dir = args.cwd || '/workspace/group';
      // Use find with -name for simple patterns, or bash globstar for complex ones
      const result = execSync(
        `find ${dir} -path '*/node_modules' -prune -o -path '*/.git' -prune -o -name '${args.pattern.replace(/\*\*\//g, '')}' -print | head -100`,
        { encoding: 'utf-8', timeout: 10000 },
      ).trim();
      return { content: [{ type: 'text' as const, text: result || '(no matches)' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'file_grep',
  'Search file contents with a regex pattern. More efficient than grep/rg via bash.',
  {
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().optional().describe('File or directory to search (default: /workspace/group)'),
    glob: z.string().optional().describe('Filter to specific file types (e.g. "*.ts", "*.yaml")'),
  },
  async (args) => {
    try {
      const searchPath = args.path || '/workspace/group';
      let cmd = `grep -rn --include='${args.glob || '*'}' '${args.pattern.replace(/'/g, "'\\''")}' ${searchPath} | head -50`;
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
      return { content: [{ type: 'text' as const, text: result || '(no matches)' }] };
    } catch (err) {
      // grep returns exit code 1 for no matches
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 1) {
        return { content: [{ type: 'text' as const, text: '(no matches)' }] };
      }
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
