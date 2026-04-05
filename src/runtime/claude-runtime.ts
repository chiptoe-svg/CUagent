/**
 * ClaudeRuntime — AgentRuntime implementation for Claude Agent SDK.
 *
 * Phase 1: Thin wrapper around ContainerManager.runAgentSession().
 * The container runs the full agent loop (Claude SDK query()) internally.
 * This adapter translates ContainerOutput into AgentEvents.
 *
 * Claude's built-in tools (Bash, Read, Write, Edit, Glob, Grep) run inside
 * the container via the SDK. ToolExecutor is not used for these — Claude's
 * built-in tools are a temporary bypass (they're better today), not the
 * permanent architecture. Long-term, all tools route through ToolExecutor.
 */
import type {
  AgentEvent,
  AgentRuntime,
  AgentRuntimeConfig,
  ContainerManager,
  ContainerOutput,
  RuntimeId,
} from './types.js';

/** Claude-specific stale session error patterns */
const STALE_SESSION_PATTERN =
  /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'claude';

  private containerManager: ContainerManager | null = null;
  private groupFolder: string | null = null;

  async *run(
    prompt: string,
    config: AgentRuntimeConfig,
  ): AsyncGenerator<AgentEvent> {
    this.containerManager = config.containerManager;
    this.groupFolder = config.group.folder;

    const output = await config.containerManager.runAgentSession({
      group: config.group,
      input: {
        prompt,
        sessionId: config.sessionId,
        groupFolder: config.group.folder,
        chatJid: config.chatJid,
        isMain: config.isMain,
        isScheduledTask: config.isScheduledTask,
        assistantName: config.assistantName,
        script: config.script,
      },
      onProcess: (proc, containerName) =>
        config.onProcess(proc, containerName, config.group.folder),
      onOutput: async (streamedOutput: ContainerOutput) => {
        // This callback is invoked for each streamed result from the container.
        // We can't yield from inside a callback, so we use a different mechanism:
        // the caller (index.ts) provides its own onOutput wrapper that handles
        // streamed results directly. The AgentEvent generator yields the final result.
        //
        // This is a Phase 1 compromise. In future phases, the runtime will
        // own the streaming pipeline end-to-end.
        if (config._onStreamedOutput) {
          await config._onStreamedOutput(streamedOutput);
        }
      },
    });

    // Yield session update if we got a new session ID
    if (output.newSessionId) {
      yield {
        type: 'session_update',
        runtime: this.id,
        sessionId: output.newSessionId,
      };
    }

    // Yield the final result or error
    if (output.status === 'error') {
      yield {
        type: 'error',
        runtime: this.id,
        error: output.error,
        sessionId: output.newSessionId,
      };
    } else {
      yield {
        type: 'result',
        runtime: this.id,
        result: output.result,
        sessionId: output.newSessionId,
      };
    }
  }

  sendFollowUp(text: string): boolean {
    if (!this.containerManager || !this.groupFolder) return false;
    return this.containerManager.sendToContainer(this.groupFolder, text);
  }

  close(): void {
    if (this.containerManager && this.groupFolder) {
      this.containerManager.closeSession(this.groupFolder);
    }
  }

  shouldClearSession(error: string): boolean {
    return STALE_SESSION_PATTERN.test(error);
  }
}
