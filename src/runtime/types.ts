/**
 * Shared types for the runtime abstraction layer.
 *
 * These types define the boundary between the App Shell (Layer 1)
 * and the Agent Runtime (Layer 2). The app never imports SDK-specific
 * types — only these neutral interfaces.
 */
import { ChildProcess } from 'child_process';

import { RegisteredGroup } from '../types.js';

// --- Identity ---

export type RuntimeId = 'claude' | 'openai' | (string & {});

// --- Container protocol ---
// These match the existing ContainerInput/ContainerOutput from container-runner.ts.
// Kept here so container-runner.ts can eventually be replaced by ContainerManager.

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// --- Agent events ---

export interface AgentEvent {
  type: 'result' | 'session_update' | 'error' | 'idle';
  /** Runtime that produced this event */
  runtime: RuntimeId;
  result?: string | null;
  sessionId?: string;
  error?: string;
  /** Tool calls made (for observability) */
  toolCalls?: Array<{ name: string; durationMs: number; isError: boolean }>;
}

// --- Container manager ---

export interface ContainerSession {
  containerId: string;
  containerName: string;
  groupFolder: string;
  process: ChildProcess;
  runtime: RuntimeId;
}

export interface ContainerManager {
  /** Get or create a container for a group. */
  acquire(opts: {
    group: RegisteredGroup;
    runtime: RuntimeId;
    forceNew?: boolean;
  }): Promise<ContainerSession>;

  /** Execute a single tool call inside a container. */
  executeInContainer(call: ToolCall): Promise<ToolResult>;

  /**
   * Run a full agent session in a container.
   * Used by ClaudeRuntime — the container runs the agent loop internally.
   */
  runAgentSession(opts: {
    group: RegisteredGroup;
    input: ContainerInput;
    onProcess: (proc: ChildProcess, containerName: string) => void;
    onOutput?: (output: ContainerOutput) => Promise<void>;
  }): Promise<ContainerOutput>;

  /** Write _close sentinel to signal container shutdown. */
  closeSession(groupFolder: string): void;

  /** Send follow-up message to active container via IPC. */
  sendToContainer(groupFolder: string, text: string): boolean;

  /** Stop all containers gracefully. */
  shutdown(gracePeriodMs: number): Promise<void>;

  /** Kill orphaned containers from previous runs. */
  cleanupOrphans(): void;
}

// --- Tool layer ---

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execution: 'container' | 'host' | 'either';
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  context: ToolContext;
}

export interface ToolContext {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  containerId?: string;
}

export interface ToolExecutor {
  getTools(opts: { runtime: RuntimeId; isMain: boolean }): ToolDefinition[];
  execute(call: ToolCall): Promise<ToolResult>;
}

// --- Agent runtime ---

export interface AgentRuntime {
  readonly id: RuntimeId;

  run(
    prompt: string,
    config: AgentRuntimeConfig,
  ): AsyncGenerator<AgentEvent>;

  /** Send a follow-up message into an active run. */
  sendFollowUp(text: string): boolean;

  /** Signal the runtime to wind down gracefully. */
  close(): void;

  /** Ask the runtime whether a session should be cleared after an error. */
  shouldClearSession?(error: string): boolean;
}

export interface AgentRuntimeConfig {
  group: RegisteredGroup;
  chatJid: string;
  isMain: boolean;
  assistantName: string;
  sessionId?: string;
  isScheduledTask?: boolean;
  script?: string;
  toolExecutor: ToolExecutor;
  containerManager: ContainerManager;
  /** Callback to register the container process with the group queue */
  onProcess: (
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  /**
   * Phase 1 escape hatch: callback for streamed container output.
   * The current architecture uses callbacks for streaming results from the
   * container. The AgentEvent generator yields only the final result.
   * Future phases will unify streaming through the generator.
   */
  _onStreamedOutput?: (output: ContainerOutput) => Promise<void>;
}
