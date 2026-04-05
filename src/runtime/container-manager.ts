/**
 * ContainerManager — manages container lifecycle for all runtimes.
 *
 * Phase 1: Thin wrapper around the existing container-runner.ts functions.
 * The actual container spawning logic stays in container-runner.ts for now.
 * This class provides the ContainerManager interface so runtimes can
 * use it without importing container-runner directly.
 *
 * Future phases will move the implementation into this class and
 * add tool-execution mode (WebSocket broker) for non-Claude runtimes.
 */
import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../container-runner.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

import type {
  ContainerInput,
  ContainerManager as IContainerManager,
  ContainerOutput,
  ContainerSession,
  RuntimeId,
  ToolCall,
  ToolResult,
} from './types.js';

export class DefaultContainerManager implements IContainerManager {
  async acquire(_opts: {
    group: RegisteredGroup;
    runtime: RuntimeId;
    forceNew?: boolean;
  }): Promise<ContainerSession> {
    // TODO: Phase 2 — implement container pooling for tool-execution mode.
    // For now, containers are managed per-invocation by runAgentSession().
    throw new Error(
      'acquire() not yet implemented — use runAgentSession() for Claude runtime',
    );
  }

  async executeInContainer(_call: ToolCall): Promise<ToolResult> {
    // TODO: Phase 2 — implement tool-execution mode via WebSocket broker.
    throw new Error(
      'executeInContainer() not yet implemented — requires tool-runner container',
    );
  }

  async runAgentSession(opts: {
    group: RegisteredGroup;
    input: ContainerInput;
    onProcess: (proc: ChildProcess, containerName: string) => void;
    onOutput?: (output: ContainerOutput) => Promise<void>;
  }): Promise<ContainerOutput> {
    return runContainerAgent(
      opts.group,
      opts.input,
      opts.onProcess,
      opts.onOutput,
    );
  }

  closeSession(groupFolder: string): void {
    const ipcDir = resolveGroupIpcPath(groupFolder);
    const sentinel = path.join(ipcDir, 'input', '_close');
    try {
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, '');
    } catch (err) {
      logger.warn({ groupFolder, err }, 'Failed to write close sentinel');
    }
  }

  sendToContainer(groupFolder: string, text: string): boolean {
    const ipcDir = resolveGroupIpcPath(groupFolder);
    const inputDir = path.join(ipcDir, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      const filepath = path.join(inputDir, filename);
      fs.writeFileSync(filepath, JSON.stringify({ type: 'message', text }));
      return true;
    } catch (err) {
      logger.warn({ groupFolder, err }, 'Failed to send to container');
      return false;
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    // Handled by GroupQueue.shutdown() which detaches containers.
    // ContainerManager doesn't own the process lifecycle yet.
  }

  cleanupOrphans(): void {
    // Delegated to container-runtime.ts cleanupOrphans() called from index.ts.
    // Will move here in a future phase.
  }
}

// Re-export snapshot helpers (used by runAgent in index.ts and task-scheduler)
export { writeTasksSnapshot, writeGroupsSnapshot };
