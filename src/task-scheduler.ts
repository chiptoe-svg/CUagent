import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import type {
  AgentRuntime,
  ContainerManager,
  ContainerOutput,
} from './runtime/types.js';
import { writeTasksSnapshot } from './runtime/container-manager.js';
import {
  getAllTasks,
  getDueTasks,
  getRecentTaskRuns,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

function isExpectedTaskError(err: unknown): err is Error {
  return err instanceof Error;
}

// --- Circuit breaker thresholds ---
// After N runs in a row that look abnormal (error exit, SIGKILL from timeout,
// or token burn past the hard ceiling) we auto-pause the task and post a
// warning to the group. The goal is to stop paying for a looping task long
// before a human notices.
const CIRCUIT_CONSECUTIVE_FAILURES = 2;
const CIRCUIT_INPUT_TOKEN_CEILING = 3_000_000; // one-run hard stop, ~$3.75 at gpt-5.3-codex rates
const CIRCUIT_DURATION_MS_CEILING = 10 * 60 * 1000; // 10 min = almost certainly thrash

function runLookedBad(run: {
  status: string;
  exit_code?: number | null;
  input_tokens?: number | null;
  duration_ms: number;
}): boolean {
  if (run.status === 'error') return true;
  if (run.exit_code === 137 || run.exit_code === 143) return true; // SIGKILL / SIGTERM
  if ((run.input_tokens ?? 0) > CIRCUIT_INPUT_TOKEN_CEILING) return true;
  if (run.duration_ms > CIRCUIT_DURATION_MS_CEILING) return true;
  return false;
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  setSessions: (groupFolder: string, sessionId: string) => void;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  createRuntime: (group: RegisteredGroup) => AgentRuntime;
  containerManager: ContainerManager;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    if (!isExpectedTaskError(err)) throw err;
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;
  let metrics:
    | import('./runtime/types.js').ContainerOutput['metrics']
    | undefined;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // Per-task model override — clone the group with the override applied so
  // the runtime reads it through the standard containerConfig path without
  // mutating the shared group registration.
  const effectiveGroup: RegisteredGroup = task.model_override
    ? {
        ...group,
        containerConfig: {
          ...(group.containerConfig || {}),
          model: task.model_override,
        },
      }
    : group;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const runtime = deps.createRuntime(effectiveGroup);

    for await (const event of runtime.run(task.prompt, {
      group: effectiveGroup,
      chatJid: task.chat_jid,
      isMain,
      assistantName: ASSISTANT_NAME,
      sessionId,
      isScheduledTask: true,
      script: task.script || undefined,
      containerManager: deps.containerManager,
      onProcess: (proc, containerName, groupFolder) =>
        deps.onProcess(task.chat_jid, proc, containerName, groupFolder),
      _onStreamedOutput: async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
          // Clear stale sessions detected in streamed errors
          if (
            sessionId &&
            streamedOutput.error &&
            runtime.shouldClearSession?.(streamedOutput.error)
          ) {
            logger.warn(
              { taskId: task.id, error: streamedOutput.error },
              'Stale session detected in task — clearing',
            );
            deps.setSessions(task.group_folder, '');
          }
        }
      },
    })) {
      if (event.sessionId) {
        deps.setSessions(task.group_folder, event.sessionId);
      }
      if (event.metrics) {
        metrics = event.metrics;
      }
      if (event.type === 'error') {
        error = event.error || 'Unknown error';
      } else if (event.type === 'result' && event.result) {
        result = event.result;
      }
    }

    if (closeTimer) clearTimeout(closeTimer);

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (!isExpectedTaskError(err)) throw err;
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
    input_tokens: metrics?.inputTokens ?? null,
    output_tokens: metrics?.outputTokens ?? null,
    tool_call_count: metrics?.toolCallCount ?? null,
    exit_code: metrics?.exitCode ?? null,
    model_used: effectiveGroup.containerConfig?.model ?? null,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);

  // Circuit breaker — pause the task if the last N runs all looked bad. The
  // current run is already in task_run_logs, so it counts. Only trips for
  // recurring tasks; one-shot tasks already auto-complete.
  if (task.schedule_type !== 'once') {
    const recent = getRecentTaskRuns(task.id, CIRCUIT_CONSECUTIVE_FAILURES);
    if (
      recent.length >= CIRCUIT_CONSECUTIVE_FAILURES &&
      recent.every(runLookedBad)
    ) {
      updateTask(task.id, { status: 'paused' });
      const reasons = recent
        .map((r, i) => {
          const flags: string[] = [];
          if (r.status === 'error') flags.push('error');
          if (r.exit_code === 137) flags.push('killed (timeout)');
          if ((r.input_tokens ?? 0) > CIRCUIT_INPUT_TOKEN_CEILING)
            flags.push(`${(r.input_tokens! / 1e6).toFixed(1)}M tokens`);
          if (r.duration_ms > CIRCUIT_DURATION_MS_CEILING)
            flags.push(`${Math.round(r.duration_ms / 60_000)}m duration`);
          return `  ${i + 1}. ${flags.join(', ') || 'bad'}`;
        })
        .join('\n');
      logger.warn(
        { taskId: task.id, prompt: task.prompt.slice(0, 80) },
        'Circuit breaker tripped — auto-paused task',
      );
      try {
        await deps.sendMessage(
          task.chat_jid,
          `⚠️ Auto-paused scheduled task \`${task.prompt.slice(0, 60)}\` — ${CIRCUIT_CONSECUTIVE_FAILURES} consecutive bad runs:\n${reasons}\n\nResume with the /task tool once fixed.`,
        );
      } catch (err) {
        logger.warn({ err }, 'Could not notify chat of circuit trip');
      }
    }
  }
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      if (!isExpectedTaskError(err)) throw err;
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
