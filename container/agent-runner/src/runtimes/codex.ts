/**
 * OpenAI Codex app-server runtime for the container agent-runner.
 *
 * Uses JSON-RPC over stdio to communicate with `codex app-server`.
 * Replaces the previous SDK-based approach (thread.runStreamed) with the
 * richer app-server protocol that supports native compaction, skill
 * discovery, thread health checks, and eliminates config.toml generation.
 *
 * Self-registers with the container runtime registry.
 */
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

import {
  ContainerInput,
  drainIpcInput,
  getContainerBaseUrl,
  getContainerModel,
  log,
  shouldClose,
  writeOutput,
} from '../shared.js';
import { getProviderMcpConfigs } from '../provider-registry.js';
import { registerContainerRuntime, type QueryResult } from '../runtime-registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Input tokens before triggering native compaction */
const COMPACT_THRESHOLD = 40_000;

/** Timeout for the entire turn (5 minutes) */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

/** Timeout for initialize handshake */
const INIT_TIMEOUT_MS = 30_000;

/** Codex-specific tool guidance — injected into AGENTS.md during assembly */
const CODEX_TOOL_GUIDANCE = `
## File and Shell Best Practices

**IMPORTANT: Use MCP file tools instead of bash for file operations.** They are faster (no shell overhead) and return cleaner output.

- **Reading files:** Use \`mcp__nanoclaw__file_read\` (not cat/head/tail/sed)
- **Writing files:** Use \`mcp__nanoclaw__file_write\` (not echo/cat heredoc)
- **Editing files:** Use \`mcp__nanoclaw__file_edit\` (not sed/awk)
- **Finding files:** Use \`mcp__nanoclaw__file_glob\` (not find/ls)
- **Searching content:** Use \`mcp__nanoclaw__file_grep\` (not grep/rg)
- **Running commands:** Use bash only for system commands, git, and tools that aren't file operations

These MCP tools execute locally with no shell overhead. Each bash tool call requires a full API round-trip — MCP tools are significantly faster.
`;

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

let nextRequestId = 1;

interface JsonRpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

/** A server-initiated request (approvals, tool calls) — has an `id` we must respond to. */
interface JsonRpcServerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

function makeRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
  return { id: nextRequestId++, method, params };
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

function isServerRequest(msg: JsonRpcMessage): msg is JsonRpcServerRequest {
  return 'id' in msg && 'method' in msg;
}

// ---------------------------------------------------------------------------
// App-server process management
// ---------------------------------------------------------------------------

interface AppServer {
  process: ChildProcess;
  readline: ReadlineInterface;
  /** Pending client requests awaiting a response, keyed by request id */
  pending: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>;
  /** Listeners for server notifications */
  notificationHandlers: ((n: JsonRpcNotification) => void)[];
  /** Listeners for server requests (approvals, tool calls) */
  serverRequestHandlers: ((r: JsonRpcServerRequest) => void)[];
}

function spawnAppServer(configOverrides: string[]): AppServer {
  const args = ['app-server', '--listen', 'stdio://'];
  for (const override of configOverrides) {
    args.push('-c', override);
  }

  log(`Spawning: codex ${args.join(' ')}`);
  const proc = spawn('codex', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = createInterface({ input: proc.stdout! });

  const server: AppServer = {
    process: proc,
    readline: rl,
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  };

  // Stderr → log
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log(`[codex-stderr] ${text}`);
  });

  // Parse incoming JSON-RPC messages
  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`[codex-parse-error] ${line.slice(0, 200)}`);
      return;
    }

    if (isResponse(msg)) {
      const handler = server.pending.get(msg.id);
      if (handler) {
        server.pending.delete(msg.id);
        handler.resolve(msg);
      }
    } else if (isServerRequest(msg)) {
      for (const h of server.serverRequestHandlers) h(msg);
    } else if ('method' in msg) {
      for (const h of server.notificationHandlers) h(msg as JsonRpcNotification);
    }
  });

  proc.on('error', (err) => {
    log(`[codex-process-error] ${err.message}`);
    // Reject all pending requests
    for (const [, handler] of server.pending) {
      handler.reject(err);
    }
    server.pending.clear();
  });

  proc.on('exit', (code, signal) => {
    log(`[codex-exit] code=${code} signal=${signal}`);
    const err = new Error(`Codex app-server exited: code=${code} signal=${signal}`);
    for (const [, handler] of server.pending) {
      handler.reject(err);
    }
    server.pending.clear();
  });

  return server;
}

function sendRequest(server: AppServer, method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<JsonRpcResponse> {
  const req = makeRequest(method, params);
  const line = JSON.stringify(req) + '\n';

  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.pending.delete(req.id);
      reject(new Error(`Timeout waiting for ${method} response (${timeoutMs}ms)`));
    }, timeoutMs);

    server.pending.set(req.id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });

    try {
      server.process.stdin!.write(line);
    } catch (err) {
      clearTimeout(timer);
      server.pending.delete(req.id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function sendResponse(server: AppServer, id: number, result: unknown): void {
  const line = JSON.stringify({ id, result }) + '\n';
  try {
    server.process.stdin!.write(line);
  } catch (err) {
    log(`[codex-send-error] Failed to send response for id=${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function killServer(server: AppServer): void {
  try {
    server.readline.close();
    server.process.kill('SIGTERM');
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Auto-approval handler
// ---------------------------------------------------------------------------

/**
 * Auto-approve all server requests. We're inside a Docker sandbox so
 * command execution, file changes, and permission escalation are all safe.
 */
function handleServerRequest(server: AppServer, req: JsonRpcServerRequest): void {
  const method = req.method;
  log(`[approval] Auto-approving: ${method}`);

  switch (method) {
    case 'item/commandExecution/requestApproval':
      sendResponse(server, req.id, { decision: 'accept' });
      break;

    case 'item/fileChange/requestApproval':
      sendResponse(server, req.id, { decision: 'accept' });
      break;

    case 'item/permissions/requestApproval':
      // Grant full permissions — Docker is our sandbox
      sendResponse(server, req.id, {
        permissions: {
          fileSystem: { read: ['/'], write: ['/'] },
          network: { enabled: true },
        },
        scope: 'session',
      });
      break;

    case 'applyPatchApproval':
    case 'execCommandApproval':
      // Legacy approval format uses "approved" instead of "accept"
      sendResponse(server, req.id, { decision: 'approved' });
      break;

    case 'item/tool/call': {
      // Dynamic tool call — we don't register any dynamic tools, so this
      // shouldn't fire. MCP tools (nanoclaw, ms365) are handled internally
      // by the app-server via config.toml. Return failure so the model
      // knows the tool isn't available rather than getting a silent empty result.
      const toolName = (req.params as { tool?: string }).tool || 'unknown';
      log(`[approval] Unexpected dynamic tool call: ${toolName}`);
      sendResponse(server, req.id, {
        success: false,
        contentItems: [{ type: 'inputText', text: `Tool "${toolName}" is not available. Use MCP tools instead.` }],
      });
      break;
    }

    case 'item/tool/requestUserInput':
    case 'mcpServer/elicitation/request':
      // Can't get user input in headless mode — decline gracefully
      sendResponse(server, req.id, { input: null });
      break;

    default:
      // Unknown request type — try generic approval
      log(`[approval] Unknown server request method: ${method}, attempting generic approval`);
      sendResponse(server, req.id, { decision: 'accept' });
      break;
  }
}

// ---------------------------------------------------------------------------
// MCP config builder (replaces config.toml generation)
// ---------------------------------------------------------------------------

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function buildMcpConfig(mcpServerPath: string, containerInput: ContainerInput, modelRef: string): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  // NanoClaw IPC MCP server
  servers['nanoclaw'] = {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      NANOCLAW_RUNTIME: 'codex',
      NANOCLAW_MODEL: modelRef,
    },
  };

  // Provider-based MCP servers (MS365, etc.)
  const providerConfigs = getProviderMcpConfigs();
  for (const [name, config] of Object.entries(providerConfigs)) {
    servers[name] = {
      command: config.command,
      args: config.args || [],
      env: config.env || {},
    };
  }

  return servers;
}

/**
 * Write a minimal config.toml with just MCP server definitions.
 * The app-server auto-reads this file. We write it fresh each time
 * to avoid stale/duplicate section bugs from the old approach.
 */
function writeMcpConfigToml(servers: Record<string, McpServerConfig>): void {
  const codexConfigDir = path.join(process.env.HOME || '/home/node', '.codex');
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const configTomlPath = path.join(codexConfigDir, 'config.toml');

  const lines: string[] = [];
  for (const [name, config] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push('type = "stdio"');
    lines.push(`command = "${config.command}"`);
    if (config.args && config.args.length > 0) {
      const argsStr = config.args.map((a) => `"${a}"`).join(', ');
      lines.push(`args = [${argsStr}]`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(config.env)) {
        lines.push(`${key} = "${value}"`);
      }
    }
    lines.push('');
  }

  fs.writeFileSync(configTomlPath, lines.join('\n'));
  log(`Wrote MCP config.toml (${Object.keys(servers).length} servers, clean rebuild)`);
}

// ---------------------------------------------------------------------------
// AGENTS.md assembly — persona only, no skills (app-server handles those)
// ---------------------------------------------------------------------------

function assembleAgentsMd(): void {
  const agentsParts: string[] = [];

  for (const dir of ['/workspace/global', '/workspace/group']) {
    for (const filename of ['AGENT.md', 'CLAUDE.md']) {
      const filePath = path.join(dir, filename);
      if (fs.existsSync(filePath)) {
        agentsParts.push(fs.readFileSync(filePath, 'utf-8'));
        break;
      }
    }
  }

  agentsParts.push(CODEX_TOOL_GUIDANCE);

  if (agentsParts.length > 0) {
    fs.writeFileSync(
      '/workspace/group/AGENTS.md',
      agentsParts.join('\n\n---\n\n'),
    );
    log(`Assembled AGENTS.md from ${agentsParts.length} source(s)`);
  }
}

// ---------------------------------------------------------------------------
// Main query handler
// ---------------------------------------------------------------------------

async function runCodexQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
): Promise<QueryResult> {
  const modelRef = getContainerModel(containerInput, 'gpt-5.4-mini');
  const baseUrl = getContainerBaseUrl(containerInput) || process.env.OPENAI_BASE_URL;

  // Assemble AGENTS.md — persona + tool guidance only.
  // Skills are discovered natively by the app-server via skills/list.
  assembleAgentsMd();

  // Build config overrides (replaces config.toml)
  const configOverrides: string[] = [
    'features.use_linux_sandbox_bwrap=false',
  ];
  if (baseUrl) {
    configOverrides.push(`model_provider_base_url="${baseUrl}"`);
  }

  // Build MCP server configs and write config.toml
  // The app-server reads config.toml for MCP server definitions.
  // We write a minimal file with just MCP config — everything else
  // goes via -c flags to avoid the config.toml corruption bugs.
  const mcpServers = buildMcpConfig(mcpServerPath, containerInput, modelRef);
  writeMcpConfigToml(mcpServers);

  // Spawn the app-server
  const server = spawnAppServer(configOverrides);

  // Wire up auto-approval
  server.serverRequestHandlers.push((req) => handleServerRequest(server, req));

  let newThreadId: string | undefined;
  let closedDuringQuery = false;

  try {
    // Step 1: Initialize
    log('Sending initialize...');
    const initResp = await sendRequest(server, 'initialize', {
      clientInfo: { name: 'nanoclaw', version: '1.0.0' },
      capabilities: { experimentalApi: false },
    }, INIT_TIMEOUT_MS);

    if (initResp.error) {
      throw new Error(`Initialize failed: ${initResp.error.message}`);
    }
    log('Initialize successful');

    // Step 2: Start or resume thread
    // Pass AGENTS.md content explicitly via baseInstructions.
    // The app-server CLI reads AGENTS.md from cwd, but the JSON-RPC
    // protocol may not — baseInstructions ensures the persona is injected.
    const agentsMdContent = fs.existsSync('/workspace/group/AGENTS.md')
      ? fs.readFileSync('/workspace/group/AGENTS.md', 'utf-8')
      : undefined;

    const threadParams = {
      model: modelRef,
      cwd: '/workspace/group',
      sandbox: 'danger-full-access' as const,
      approvalPolicy: 'never' as const,
      personality: 'friendly' as const,
      baseInstructions: agentsMdContent,
    };

    let threadId: string | undefined;

    // Try resuming an existing thread
    if (sessionId) {
      log(`Resuming thread: ${sessionId}`);
      const resumeResp = await sendRequest(server, 'thread/resume', {
        threadId: sessionId,
        ...threadParams,
      });

      if (resumeResp.error) {
        log(`Resume failed: ${resumeResp.error.message}. Starting fresh thread.`);
      } else {
        threadId = sessionId;
        log(`Thread resumed: ${threadId}`);
      }
    }

    // Start fresh thread if resume failed or no sessionId
    if (!threadId) {
      log('Starting new thread...');
      const startResp = await sendRequest(server, 'thread/start', threadParams);

      if (startResp.error) {
        throw new Error(`thread/start failed: ${startResp.error.message}`);
      }

      const result = startResp.result as { thread?: { id?: string } } | undefined;
      threadId = result?.thread?.id;
      if (!threadId) {
        throw new Error('thread/start response missing thread ID');
      }
      log(`New thread started: ${threadId}`);
    }

    newThreadId = threadId;

    // Step 3: Send the turn
    log('Starting turn...');

    // Collect streaming output — mutable state shared with notification handlers.
    // Using an object so TypeScript doesn't narrow closure-captured vars to `never`.
    const turnState = {
      resultText: '',
      toolCalls: [] as string[],
      turnComplete: false,
      totalInputTokens: 0,
    };

    // Set up notification handlers for this turn
    const turnPromise = new Promise<void>((resolve, reject) => {
      const turnTimeout = setTimeout(() => {
        reject(new Error(`Turn timed out after ${TURN_TIMEOUT_MS}ms`));
      }, TURN_TIMEOUT_MS);

      server.notificationHandlers.push((notification) => {
        const method = notification.method;
        const params = notification.params;

        switch (method) {
          case 'thread/started': {
            const thread = params.thread as { id?: string } | undefined;
            if (thread?.id) {
              newThreadId = thread.id;
              log(`Thread started: ${newThreadId}`);
            }
            break;
          }

          case 'item/agentMessage/delta': {
            const delta = params.delta as string;
            if (delta) turnState.resultText += delta;
            break;
          }

          case 'item/started': {
            const item = params.item as { type?: string; command?: string; server?: string; tool?: string; query?: string; changes?: { path: string }[] } | undefined;
            if (!item) break;

            if (item.type === 'commandExecution' && item.command) {
              log(`[tool] Running: ${item.command}`);
              turnState.toolCalls.push(`$ ${item.command}`);
            } else if (item.type === 'mcpToolCall' && item.server && item.tool) {
              log(`[tool] MCP: ${item.server}/${item.tool}`);
              turnState.toolCalls.push(`MCP: ${item.server}/${item.tool}`);
            } else if (item.type === 'webSearch' && item.query) {
              log(`[tool] Web search: ${item.query}`);
              turnState.toolCalls.push(`Search: ${item.query}`);
            } else if (item.type === 'fileChange' && item.changes) {
              const paths = item.changes.map((c) => c.path).join(', ');
              log(`[tool] File changes: ${paths}`);
              turnState.toolCalls.push(`Files: ${paths}`);
            }
            break;
          }

          case 'item/completed': {
            const item = params.item as { type?: string; aggregated_output?: string; text?: string } | undefined;
            if (item?.type === 'commandExecution' && item.aggregated_output) {
              turnState.toolCalls.push(item.aggregated_output.slice(0, 500));
            }
            // Capture final message text from completed agentMessage items
            if (item?.type === 'agentMessage' && item.text) {
              turnState.resultText = item.text;
            }
            break;
          }

          case 'item/commandExecution/outputDelta':
            // Streaming command output — log but don't append to result
            break;

          case 'thread/tokenUsage/updated': {
            // Server tracks cumulative totals — use directly for compaction decisions
            const usage = params.tokenUsage as { total?: { inputTokens?: number; outputTokens?: number } } | undefined;
            if (usage?.total) {
              turnState.totalInputTokens = usage.total.inputTokens || 0;
              log(`Token usage: ${usage.total.inputTokens} in, ${usage.total.outputTokens} out (total)`);
            }
            break;
          }

          case 'thread/compacted':
            log('Thread compacted by server');
            break;

          case 'turn/started':
            log('Turn started');
            break;

          case 'turn/completed': {
            turnState.turnComplete = true;
            clearTimeout(turnTimeout);
            resolve();
            break;
          }

          case 'thread/status/changed': {
            const status = params.status as string | undefined;
            log(`Thread status: ${status}`);
            break;
          }

          // Ignore noisy notifications
          case 'item/reasoning/summaryTextDelta':
          case 'turn/diff/updated':
          case 'turn/plan/updated':
            break;

          default:
            // Log unknown notifications for debugging
            if (!method.startsWith('item/')) {
              log(`[notification] ${method}`);
            }
            break;
        }
      });
    });

    // Send turn/start
    const turnResp = await sendRequest(server, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      model: modelRef,
      cwd: '/workspace/group',
    });

    if (turnResp.error) {
      throw new Error(`turn/start failed: ${turnResp.error.message}`);
    }

    // Poll for IPC messages during the turn
    let ipcPolling = true;
    const pollIpc = () => {
      if (!ipcPolling) return;
      if (shouldClose()) {
        closedDuringQuery = true;
        ipcPolling = false;
        return;
      }
      setTimeout(pollIpc, 500);
    };
    setTimeout(pollIpc, 500);

    // Wait for turn completion
    await turnPromise;
    ipcPolling = false;

    log(`Turn complete. Result: ${turnState.resultText.length} chars, ${turnState.toolCalls.length} tool calls`);

    // Trigger native compaction if cumulative tokens exceed threshold.
    // The server tracks totals via thread/tokenUsage/updated — no local state file needed.
    if (turnState.totalInputTokens >= COMPACT_THRESHOLD) {
      log(`Compaction threshold reached (${turnState.totalInputTokens}/${COMPACT_THRESHOLD} tokens). Compacting...`);
      const compactResp = await sendRequest(server, 'thread/compact/start', {
        threadId: newThreadId,
      });
      if (compactResp.error) {
        log(`Compaction failed: ${compactResp.error.message}. Continuing uncompacted.`);
      } else {
        log('Native compaction completed');
      }
    }

    writeOutput({ status: 'success', result: turnState.resultText || null, newSessionId: newThreadId });

    // Process IPC messages that arrived during the turn
    const pendingMessages = drainIpcInput();
    if (pendingMessages.length > 0 && !closedDuringQuery) {
      log(`Processing ${pendingMessages.length} IPC message(s) that arrived during turn`);
      const followUp = pendingMessages.join('\n');

      // Reset streaming state for follow-up
      turnState.resultText = '';
      turnState.turnComplete = false;

      const followUpTurnPromise = new Promise<void>((resolve) => {
        const checkComplete = () => {
          if (turnState.turnComplete) { resolve(); return; }
          setTimeout(checkComplete, 100);
        };
        setTimeout(checkComplete, 100);
      });

      const followUpResp = await sendRequest(server, 'turn/start', {
        threadId: newThreadId,
        input: [{ type: 'text', text: followUp }],
        model: modelRef,
      });

      if (!followUpResp.error) {
        await followUpTurnPromise;
        if (turnState.resultText) {
          writeOutput({ status: 'success', result: turnState.resultText, newSessionId: newThreadId });
        }
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`Codex error: ${error}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: newThreadId,
      error,
    });
  } finally {
    killServer(server);
  }

  return { newSessionId: newThreadId, closedDuringQuery };
}

// --- Self-register ---

registerContainerRuntime('codex', runCodexQuery);
