/**
 * OpenAIRuntime — AgentRuntime implementation using OpenAI Codex SDK.
 *
 * Like ClaudeRuntime, the agent loop runs inside a container via the
 * agent-runner. The agent-runner detects runtime='openai' and uses
 * @openai/codex-sdk instead of @anthropic-ai/claude-agent-sdk.
 *
 * Both runtimes share the same container image, MCP server, IPC protocol,
 * and output format. The only difference is which SDK drives the agent loop.
 */
import { DEFAULT_MODEL } from '../config.js';

import type {
  AgentEvent,
  AgentRuntime,
  AgentRuntimeConfig,
  ContainerManager,
  ContainerOutput,
  RuntimeId,
} from './types.js';
import { registerAgentSdk } from './registry.js';

export class OpenAIRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'codex';

  private containerManager: ContainerManager | null = null;
  private groupFolder: string | null = null;

  async *run(
    prompt: string,
    config: AgentRuntimeConfig,
  ): AsyncGenerator<AgentEvent> {
    this.containerManager = config.containerManager;
    this.groupFolder = config.group.folder;

    const model = config.group.containerConfig?.model || DEFAULT_MODEL;

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
        runtime: 'codex',
        model,
        baseUrl: config.group.containerConfig?.baseUrl,
      },
      onProcess: (proc, containerName) =>
        config.onProcess(proc, containerName, config.group.folder),
      onOutput: async (streamedOutput: ContainerOutput) => {
        if (config._onStreamedOutput) {
          await config._onStreamedOutput(streamedOutput);
        }
      },
    });

    if (output.newSessionId) {
      yield {
        type: 'session_update',
        runtime: this.id,
        sessionId: output.newSessionId,
      };
    }

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
    // Clear session on thread resume failures
    return /no rollout found|thread.*not found|resume.*failed/i.test(error);
  }
}

// Self-register
registerAgentSdk('codex', () => new OpenAIRuntime());
