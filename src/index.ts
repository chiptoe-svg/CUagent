import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_RUNTIME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
// Trigger agent SDK self-registration (barrel import)
import './runtime/index.js';
import {
  getAgentSdkFactory,
  getRegisteredAgentSdkNames,
} from './runtime/registry.js';
import { DefaultContainerManager } from './runtime/container-manager.js';
import {
  writeTasksSnapshot,
  writeGroupsSnapshot,
} from './runtime/container-manager.js';
import type { AgentRuntime, ContainerOutput } from './runtime/types.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  logChatRun,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { evaluateChannel } from './policy/activation.js';
import { ensureDefaultProviders } from './provider-registry.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startActionFolderWatcher } from './action-folder-watcher.js';
import { startContactsHarvester } from './contacts-harvester.js';
import { startDailyCostReport } from './cost-report-cron.js';
import {
  startEmailPreclassifier,
  triggerEmailPreclassifier,
} from './email-preclassifier.js';
import { fetchOpenTasks, startMs365Reconciler } from './ms365-reconciler.js';
import { startUnsolicitedSummary } from './unsolicited-summary-cron.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// Dedup hashes for messages already sent to the user during a failed run.
// Keyed by chatJid. Cleared when the cursor successfully advances.
// Prevents duplicate delivery when a partial-failure run is retried.
const recentSentHashes: Record<string, Set<string>> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy AGENT.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  // AGENT.md is runtime-agnostic; container runtimes convert it to
  // CLAUDE.md / AGENTS.md / GEMINI.md as needed.
  const groupMdFile = path.join(groupDir, 'AGENT.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateDir = path.join(GROUPS_DIR, group.isMain ? 'main' : 'global');
    const templateFile = fs.existsSync(path.join(templateDir, 'AGENT.md'))
      ? path.join(templateDir, 'AGENT.md')
      : path.join(templateDir, 'CLAUDE.md'); // fallback for legacy groups
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created AGENT.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const newCursor = missedMessages[missedMessages.length - 1].timestamp;

  // Cursor is NOT advanced until the run reaches a terminal state.
  // This prevents silent message loss when the agent crashes mid-reply.
  // Duplicate delivery is avoided by tracking sent message hashes.

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Track sent message hashes so retries after partial failure don't
  // duplicate output the user already received. Persists across retries.
  if (!recentSentHashes[chatJid]) recentSentHashes[chatJid] = new Set();
  const sentHashes = recentSentHashes[chatJid];

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        // Simple hash for dedup on retry — first 200 chars is enough to
        // distinguish distinct messages while being collision-tolerant.
        const hash = text.slice(0, 200);
        if (!sentHashes.has(hash)) {
          await channel.sendMessage(chatJid, text);
          sentHashes.add(hash);
          outputSentToUser = true;
        } else {
          logger.debug(
            { group: group.name },
            'Skipped duplicate output on retry',
          );
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // Always roll back the cursor on error so the messages can be retried.
    // Sent message hashes prevent duplicate delivery on the next attempt.
    logger.warn(
      {
        group: group.name,
        outputSentToUser,
        sentCount: sentHashes.size,
      },
      'Agent error, cursor not advanced — messages eligible for retry',
    );
    return false;
  }

  // Success: commit the cursor now that the run completed cleanly.
  lastAgentTimestamp[chatJid] = newCursor;
  saveState();
  delete recentSentHashes[chatJid];

  return true;
}

// Singletons — shared across all runtimes
const containerManager = new DefaultContainerManager();

function createRuntime(group: RegisteredGroup): AgentRuntime {
  const sdk = group.containerConfig?.runtime || DEFAULT_RUNTIME;
  const factory = getAgentSdkFactory(sdk);
  if (!factory) {
    const installed = getRegisteredAgentSdkNames().join(', ');
    throw new Error(
      `Agent SDK '${sdk}' not installed. Available: ${installed || 'none'}. Run /add-agentSDK-${sdk}`,
    );
  }
  return factory();
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  const runtime = createRuntime(group);

  // Wrap onOutput to track session ID and detect errors from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        // Check for stale sessions in streamed errors (before final event)
        if (
          output.status === 'error' &&
          output.error &&
          sessionId &&
          runtime.shouldClearSession?.(output.error)
        ) {
          logger.warn(
            { group: group.name, error: output.error },
            'Stale session detected in streamed output — clearing',
          );
          delete sessions[group.folder];
          deleteSession(group.folder);
        }
        await onOutput(output);
      }
    : undefined;

  const turnStartedAt = Date.now();
  let turnMetrics:
    | import('./runtime/types.js').ContainerOutput['metrics']
    | undefined;

  try {
    let lastError: string | undefined;

    for await (const event of runtime.run(prompt, {
      group,
      chatJid,
      isMain,
      assistantName: ASSISTANT_NAME,
      sessionId,
      containerManager,
      onProcess: (proc, containerName, groupFolder) =>
        queue.registerProcess(chatJid, proc, containerName, groupFolder),
      _onStreamedOutput: wrappedOnOutput,
    })) {
      if (event.sessionId) {
        sessions[group.folder] = event.sessionId;
        setSession(group.folder, event.sessionId);
      }
      if (event.metrics) {
        turnMetrics = event.metrics;
      }

      // For runtimes that yield results via AgentEvent (e.g. OpenAI),
      // forward the result through the onOutput callback so the message
      // gets sent to the user. Claude uses _onStreamedOutput instead.
      if (event.type === 'result' && event.result && onOutput) {
        await onOutput({
          status: 'success',
          result: event.result,
          newSessionId: event.sessionId,
        });
      }

      if (event.type === 'error') {
        lastError = event.error;

        // Ask the runtime if this error means the session is stale
        if (
          sessionId &&
          event.error &&
          runtime.shouldClearSession?.(event.error)
        ) {
          logger.warn(
            {
              group: group.name,
              staleSessionId: sessionId,
              error: event.error,
            },
            'Stale session detected — clearing for next retry',
          );
          delete sessions[group.folder];
          deleteSession(group.folder);
        }
      }
    }

    if (turnMetrics) {
      // Persist cost telemetry for this interactive turn. No per-turn audit
      // surface — this table exists only so /cost-report and the 9pm daily
      // can sum in the interactive share alongside scheduled tasks.
      logChatRun({
        group_folder: group.folder,
        chat_jid: chatJid,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - turnStartedAt,
        model_used: group.containerConfig?.model ?? null,
        input_tokens: turnMetrics.inputTokens,
        cached_input_tokens: turnMetrics.cachedInputTokens,
        output_tokens: turnMetrics.outputTokens,
        reasoning_output_tokens: turnMetrics.reasoningOutputTokens,
        tool_call_count: turnMetrics.toolCallCount,
      });
    }

    if (lastError) {
      logger.error(
        { group: group.name, error: lastError, runtime: runtime.id },
        'Agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error(
      { group: group.name, err, runtime: runtime.id },
      'Agent error',
    );
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.info(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container via IPC',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            logger.info(
              { chatJid, count: messagesToSend.length },
              'No active container, enqueueing message check',
            );
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();

  // Copy default provider configs to ~/.nanoclaw/providers/ if not present
  ensureDefaultProviders(process.cwd());

  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy for Claude runtime
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /clear (reset agent session for this group)
  async function handleClearSession(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn({ chatJid }, 'Clear session rejected: not main group');
      return;
    }
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    // Drop the session row — next container spawn starts with no resumed thread.
    delete sessions[group.folder];
    deleteSession(group.folder);

    // Close the running container's stdin so it idles out; no hard kill.
    queue.closeStdin(chatJid);

    logger.info(
      { chatJid, folder: group.folder },
      'Session cleared via /clear',
    );
    await channel.sendMessage(
      chatJid,
      'Context cleared. Next message starts a fresh session.',
    );
  }

  // Handle /info — report session health (tokens, compactions, message count)
  async function handleSessionInfo(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const sessionId = sessions[group.folder];
    const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');

    // Find the running container (if any) and read its cumulative log
    let containerName: string | null = null;
    let containerLogs = '';
    let containerAgeMs: number | null = null;
    try {
      const ps = execSync(
        `docker ps --filter "name=nanoclaw-${safeName}-" --format "{{.Names}}|{{.CreatedAt}}"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      if (ps) {
        const [name, createdAt] = ps.split('\n')[0].split('|');
        containerName = name;
        const created = new Date(createdAt.replace(/ [A-Z]{3,4}$/, ''));
        if (!isNaN(created.getTime())) {
          containerAgeMs = Date.now() - created.getTime();
        }
        containerLogs = execSync(`docker logs ${name} 2>&1`, {
          encoding: 'utf-8',
          maxBuffer: 20 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    } catch {
      /* no container or docker unreachable — report what we can */
    }

    // Parse tokens from the most recent "Token usage: N in, M out" line
    const tokenMatches = [
      ...containerLogs.matchAll(/Token usage: (\d+) in, (\d+) out/g),
    ];
    const last = tokenMatches[tokenMatches.length - 1];
    const tokensIn = last ? parseInt(last[1], 10) : 0;
    const tokensOut = last ? parseInt(last[2], 10) : 0;

    // Compaction count + turn count from log markers
    const compactions = (
      containerLogs.match(/Compaction threshold reached/g) || []
    ).length;
    const turns = (containerLogs.match(/Turn complete\./g) || []).length;

    // Health thresholds tuned from observed drift patterns
    let health = '💚 healthy';
    if (tokensIn > 5_000_000) health = '🔴 should /clear';
    else if (tokensIn > 2_000_000) health = '🟡 consider /clear';

    const fmt = (n: number): string =>
      n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(1)}M`
        : n >= 1_000
          ? `${(n / 1_000).toFixed(1)}k`
          : String(n);

    const fmtAge = (ms: number): string => {
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      const rem = m % 60;
      return rem > 0 ? `${h}h${rem}m` : `${h}h`;
    };

    const lines = [
      `Group: ${group.folder}`,
      `Session: ${sessionId ? sessionId.slice(0, 8) + '…' : '(none — next message starts fresh)'}`,
      containerName
        ? `Container: ${containerName} (up ${containerAgeMs != null ? fmtAge(containerAgeMs) : '?'})`
        : 'Container: not running',
      `Turns completed: ${turns}`,
      `Compactions: ${compactions}`,
      `Tokens: ${fmt(tokensIn)} in / ${fmt(tokensOut)} out`,
      `Health: ${health}`,
    ];
    await channel.sendMessage(chatJid, lines.join('\n'));
  }

  // Handle /health — show last-run snapshot for each scheduled task.
  async function handleHealthCommand(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const { getTaskHealthSnapshot } = await import('./db.js');
    const rows = getTaskHealthSnapshot(10);
    if (rows.length === 0) {
      await channel.sendMessage(chatJid, 'No scheduled tasks.');
      return;
    }

    const fmtK = (n: number | null): string =>
      n == null
        ? '?'
        : n >= 1_000_000
          ? `${(n / 1_000_000).toFixed(1)}M`
          : n >= 1_000
            ? `${(n / 1_000).toFixed(0)}k`
            : String(n);
    const fmtMs = (ms: number | null): string => {
      if (ms == null) return '?';
      const s = Math.round(ms / 1000);
      return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
    };

    const lines = ['*Scheduled task health*', ''];
    rows.forEach((r, i) => {
      const prompt = r.prompt.replace(/\n/g, ' ').slice(0, 42);
      const statusIcon =
        r.status === 'paused'
          ? '⏸️'
          : r.exit_code === 137
            ? '💀'
            : r.run_status === 'error'
              ? '❌'
              : r.run_status === 'success'
                ? '✅'
                : '·';
      const meta =
        r.run_at == null
          ? '(never run)'
          : `${fmtK(r.input_tokens)}in ${r.tool_call_count ?? '?'}tools ${fmtMs(r.duration_ms)}`;
      lines.push(`#${i + 1} ${statusIcon} ${prompt} — ${meta}`);
    });

    await channel.sendMessage(chatJid, lines.join('\n'));
  }

  // Handle /cost-report — compute USD cost of scheduled-task runs in last 24h.
  async function handleCostReportCommand(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    const { buildCostReport, formatCostReport } =
      await import('./cost-report.js');
    const report = buildCostReport(24);
    await channel.sendMessage(chatJid, formatCostReport(report, 24));
  }

  // Handle /suggest-mail-rules — show rule proposals built from the archive.
  async function handleSuggestMailRulesCommand(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    const { buildSuggestions, formatSuggestionsReport } =
      await import('./mail-rule-suggester.js');
    const suggestions = buildSuggestions(group.folder);
    await channel.sendMessage(chatJid, formatSuggestionsReport(suggestions));
  }

  // Handle /apply-gmail-filters — create all missing Gmail filters.
  async function handleApplyGmailFiltersCommand(
    chatJid: string,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    const { buildSuggestions, applyGmailFilters, formatApplyReport } =
      await import('./mail-rule-suggester.js');
    await channel.sendMessage(chatJid, 'Creating Gmail filters…');
    const suggestions = buildSuggestions(group.folder);
    const report = applyGmailFilters(suggestions);
    await channel.sendMessage(chatJid, formatApplyReport(report));
  }

  // Handle /refresh-pricing — re-fetch live pricing from provider pages.
  async function handleRefreshPricingCommand(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    await channel.sendMessage(chatJid, 'Fetching live pricing…');
    const { refreshPricing } = await import('./pricing-refresh.js');
    const result = await refreshPricing();
    if (!result.ok) {
      await channel.sendMessage(
        chatJid,
        `Pricing refresh failed: ${result.error || 'unknown error'}`,
      );
      return;
    }
    const lines = [
      `*Pricing refreshed.*`,
      `  OpenAI: ${result.openaiCount} model(s)`,
      `  Anthropic: ${result.anthropicCount} model(s)`,
      `  Written: \`${result.writtenPath}\``,
    ];
    if (result.skippedRows.length > 0) {
      lines.push('', `_Skipped:_ ${result.skippedRows.slice(0, 3).join('; ')}`);
    }
    await channel.sendMessage(chatJid, lines.join('\n'));
  }

  // Handle /tasks — fetch open MS365 To Do tasks directly from Graph (no agent).
  async function handleTasksCommand(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    let tasks;
    try {
      tasks = await fetchOpenTasks();
    } catch (err) {
      logger.warn({ err, chatJid }, '/tasks: Graph fetch threw');
      await channel.sendMessage(
        chatJid,
        'Could not reach Microsoft 365 — check connectivity or re-run `/auth`.',
      );
      return;
    }

    if (tasks === null) {
      await channel.sendMessage(
        chatJid,
        'Microsoft 365 is not connected on this install, or the token has expired. Re-run `/auth` to reconnect.',
      );
      return;
    }

    if (tasks.length === 0) {
      await channel.sendMessage(chatJid, 'No open tasks. 🎉');
      return;
    }

    const now = Date.now();
    const fmtDue = (d: Date | null): string => {
      if (!d) return '';
      const diffDays = Math.round((d.getTime() - now) / 86400_000);
      const datePart = d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      if (diffDays < 0) return ` (due ${datePart}) ⚠️ OVERDUE`;
      if (diffDays === 0) return ` (due today)`;
      if (diffDays === 1) return ` (due tomorrow)`;
      if (diffDays <= 7) return ` (due ${datePart})`;
      return ` (due ${datePart})`;
    };

    const lines = [
      `*MS365 Tasks* (${tasks.length})`,
      ...tasks.map((t, i) => `#${i + 1} ${t.title}${fmtDue(t.dueDate)}`),
    ];
    await channel.sendMessage(chatJid, lines.join('\n'));
  }

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    // Remote Control grants interactive Claude Code access (file, shell, etc.)
    // Only real interactive channels should be able to start it. The HTTP API
    // channel delivers inbound messages as sender='http-user'; reject those
    // so a leaked HTTP_API_KEY can't be escalated into a remote shell URL.
    if (command === '/remote-control' && msg.sender === 'http-user') {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: synthetic sender (HTTP channel)',
      );
      await channel.sendMessage(
        chatJid,
        'Remote Control is not available over the HTTP API.',
      );
      return;
    }

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        const who = msg.sender_name || msg.sender;
        const when = new Date().toLocaleString('en-US', {
          timeZone: TIMEZONE,
          dateStyle: 'short',
          timeStyle: 'short',
        });
        await channel.sendMessage(
          chatJid,
          `Remote Control started by ${who} at ${when}\n\n${result.url}\n\nEnd with /remote-control-end`,
        );
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      if (trimmed === '/clear' || trimmed === '/reset') {
        handleClearSession(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Clear session command error'),
        );
        return;
      }

      if (trimmed === '/info' || trimmed === '/session-info') {
        handleSessionInfo(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Session info command error'),
        );
        return;
      }

      if (trimmed === '/tasks') {
        handleTasksCommand(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Tasks command error'),
        );
        return;
      }

      if (trimmed === '/health') {
        handleHealthCommand(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Health command error'),
        );
        return;
      }

      if (trimmed === '/cost-report' || trimmed === '/cost') {
        handleCostReportCommand(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Cost report command error'),
        );
        return;
      }

      if (trimmed === '/refresh-pricing') {
        handleRefreshPricingCommand(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Refresh pricing command error'),
        );
        return;
      }

      if (trimmed === '/suggest-mail-rules') {
        handleSuggestMailRulesCommand(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Suggest mail rules command error'),
        );
        return;
      }

      if (trimmed === '/apply-gmail-filters') {
        handleApplyGmailFiltersCommand(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Apply Gmail filters command error'),
        );
        return;
      }

      // /email-taskfinder routes through the host-side preclassifier (same
      // path as the scheduled cron). Bucket 1/2 resolve deterministically;
      // residuals classify via direct API call when OPENAI_API_KEY is set.
      // No container spawn unless the legacy agent fallback fires.
      if (
        trimmed === '/email-taskfinder' ||
        trimmed === '/email-taskfinder scan' ||
        trimmed === '/email-taskfinder now'
      ) {
        triggerEmailPreclassifier({
          registeredGroups: () => registeredGroups,
          sendMessage: async (jid: string, text: string) => {
            const channel = findChannel(channels, jid);
            if (channel) await channel.sendMessage(jid, text);
          },
          ackMessage: 'Scanning inbox — results soon.',
        }).catch((err) =>
          logger.error({ err, chatJid }, 'Email preclassifier trigger failed'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  // Access-permissions policy: skip channels denied by the channels.<name>
  // entry. Strict mode skips outright; telemetry-only logs the would-be-deny
  // and proceeds so the existing install keeps working while drift surfaces
  // in the audit log.
  for (const channelName of getRegisteredChannelNames()) {
    const decision = evaluateChannel(channelName);
    if (!decision.allow) {
      if (decision.enforced) {
        logger.warn(
          { channel: channelName, reasonCode: decision.reasonCode },
          'access-permissions: channel denied by policy — not connecting',
        );
        continue;
      }
      logger.info(
        { channel: channelName, reasonCode: decision.reasonCode },
        'access-permissions: channel would be denied (telemetry-only) — proceeding',
      );
    }
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    setSessions: (groupFolder, sessionId) => {
      sessions[groupFolder] = sessionId;
      setSession(groupFolder, sessionId);
    },
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    createRuntime: createRuntime,
    containerManager,
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();

  // MS365 To-Do reconciliation: when the user tap-completes a task on
  // Outlook / Microsoft To Do / iOS Reminders (Exchange list), this picks
  // it up and enqueues a filing task. Self-disables when MS365 isn't set up.
  startMs365Reconciler({
    registeredGroups: () => registeredGroups,
    onTaskCreated: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });

  // Action-folder watcher — when the user drags mail into the configured
  // "Action Required" folder, create an MS365 todo with clean title +
  // sidecar metadata. Shares the completion → filing loop with the main
  // triage reconciler. No-op until /add-action-folder writes the config.
  startActionFolderWatcher({
    registeredGroups: () => registeredGroups,
    onTaskCreated: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const g of Object.values(registeredGroups)) {
        writeTasksSnapshot(g.folder, g.isMain === true, taskRows);
      }
    },
  });

  // Contacts harvester — daily scan of sent-folder for new addresses, used
  // by /email-taskfinder to treat outbound-corresponded senders as solicited.
  startContactsHarvester({
    registeredGroups: () => registeredGroups,
  });

  // Email pre-classifier — host-side bucket 1/2 resolver + direct-API LLM
  // for residuals when OPENAI_API_KEY is set. Replaces the old DB-cron
  // /email-taskfinder trigger with an in-process scheduled fire.
  const preclassExpressions = (
    process.env.EMAIL_TASKFINDER_CRON || '0 7 * * *,30 16 * * *'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  startEmailPreclassifier({
    cronExpressions: preclassExpressions,
    registeredGroups: () => registeredGroups,
    sendMessage: async (jid: string, text: string) => {
      const channel = findChannel(channels, jid);
      if (channel) await channel.sendMessage(jid, text);
    },
  });

  // Daily unsolicited-summary report — reads last 24h of decisions.jsonl,
  // groups by sender, surfaces what got labeled triage:archived for review.
  startUnsolicitedSummary({
    cronExpr: process.env.UNSOLICITED_SUMMARY_CRON || '0 8 * * *',
    registeredGroups: () => registeredGroups,
    sendMessage: async (jid: string, text: string) => {
      const channel = findChannel(channels, jid);
      if (channel) await channel.sendMessage(jid, text);
    },
  });

  // Daily cost auto-report — fires at 21:00 local time each day, sends a
  // 24h cost summary to the main group. Host-side (no agent, no tokens).
  // Re-armed after each fire so it keeps running indefinitely.
  startDailyCostReport({
    cronExpr: process.env.COST_REPORT_CRON || '0 21 * * *',
    registeredGroups: () => registeredGroups,
    sendMessage: async (jid: string, text: string) => {
      const channel = findChannel(channels, jid);
      if (channel) await channel.sendMessage(jid, text);
    },
  });

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
