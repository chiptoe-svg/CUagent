# NanoClaw FlexAgents

Multi-runtime personal assistant built on NanoClaw. Supports Claude, Codex (OpenAI), and Gemini agent SDKs.

## Architecture

Four-layer system:
1. **App Shell** — channels, state, scheduling, IPC (`src/index.ts`)
2. **AgentRuntime** — modular SDK adapters that delegate to containers (`src/runtime/`)
3. **Tool Layer** — SDK-native tools inside containers
4. **Model Layer** — per-group model selection via container config

All SDKs run inside the same container image. The agent-runner detects the runtime from `ContainerInput.runtime` and uses the appropriate SDK. SDKs self-register via a registry pattern (same as channels).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, runtime invocation |
| `src/runtime/types.ts` | AgentRuntime, ContainerManager interfaces |
| `src/runtime/registry.ts` | SDK self-registration registry |
| `src/runtime/claude-runtime.ts` | Claude adapter |
| `src/runtime/codex-runtime.ts` | Codex adapter |
| `src/runtime/gemini-runtime.ts` | Gemini adapter |
| `src/runtime/container-manager.ts` | Container lifecycle management |
| `src/container-runner.ts` | Container spawning, mounts, credential injection |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/config.ts` | Config: runtime, model, trigger, paths, intervals |
| `src/credential-proxy.ts` | Anthropic credential proxy (Claude runtime) |
| `src/auth-switch.ts` | Toggle between API key and OAuth modes |
| `src/task-scheduler.ts` | Runs scheduled tasks via AgentRuntime |
| `container/agent-runner/src/index.ts` | In-container shared agent loop |
| `container/agent-runner/src/runtime-registry.ts` | Container-side SDK dispatch |
| `container/agent-runner/src/runtimes/claude.ts` | Claude SDK query loop |
| `container/agent-runner/src/runtimes/codex.ts` | Codex SDK query loop |
| `container/agent-runner/src/runtimes/gemini.ts` | Gemini CLI query loop |
| `container/agent-runner/src/shared.ts` | Shared container plumbing (IO, IPC, MessageStream) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server for NanoClaw IPC tools |
| `container/skills/` | Skills loaded inside agent containers |
| `groups/{name}/AGENT.md` | Per-group agent persona (runtime-agnostic) |
| `groups/global/AGENT.md` | Global persona shared across all groups |
| `groups/{name}/memory/` | Persistent memory (user profile, knowledge) |

## Runtime Configuration

Default runtime and model set in `.env`:
```
DEFAULT_RUNTIME=codex
OPENAI_MODEL=gpt-5.4-mini
```

Per-group override via `containerConfig` in the database:
```sql
UPDATE registered_groups SET container_config = '{"runtime":"claude","model":"claude-sonnet-4-6"}' WHERE jid = '...';
```

Telegram commands:
- `/model` — view/switch model for this group
- `/auth` — view/switch auth mode
- `/ping` — bot status
- `/chatid` — get chat registration ID

## Credentials

**Codex (OpenAI):** Subscription auth via `codex auth login`. Credentials in `~/.codex/auth.json` synced to containers. Falls back to `OPENAI_API_KEY` in `.env`.

**Claude:** OAuth token via `claude setup-token` stored in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. Credential proxy on port 3001 injects into containers.

**Gemini:** API key from https://aistudio.google.com/apikey stored as `GEMINI_API_KEY` in `.env`. Free tier: 60 req/min.

## Agent Persona (AGENT.md)

`AGENT.md` is the canonical persona file. It's runtime-agnostic.

Inside the container, the agent-runner assembles the final instructions:
- **Codex:** concatenates `global/AGENT.md` + `group/AGENT.md` → writes `AGENTS.md`
- **Claude:** copies `AGENT.md` → `CLAUDE.md` for SDK discovery, injects global via system prompt
- **Gemini:** concatenates `global/AGENT.md` + `group/AGENT.md` → writes `GEMINI.md`

## Skills

Container skills in `container/skills/` are synced to `.claude/skills/`, `.codex/skills/`, and `.gemini/` per group. Same SKILL.md format works with all SDKs.

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management (macOS):
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart
```

## Container Build Cache

The container buildkit caches aggressively. `--no-cache` alone does NOT invalidate COPY steps. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

---

# Claude Code — Developer Guide

## Response style
- Be concise and direct
- Lead with the answer, not the reasoning
- Use code blocks for file paths and commands
- Don't add unnecessary commentary after tool calls

## Tool usage
- Use Read, Write, Edit tools (not cat/sed/echo)
- Use Glob and Grep (not find/grep)
- Use Bash only for system commands and git operations

## Project memory
- Memory files in `.claude/projects/-Users-tonkin-CU-agent/memory/`
- Read MEMORY.md at start of session for project context
- Update memory when learning important project decisions

## Hooks
- Pre-commit hook runs prettier via `format:fix` script
- Always let the hook run — don't bypass with --no-verify

## Settings
- `.claude/settings.json` has project-level configuration
- `.claude/settings.local.json` has local overrides

## Problem-solving approach
- When a library or API seems too complex, don't give up — look for CLI flags, output format options, or intermediate approaches before concluding "can't be done"
- Check `--help` output for every CLI tool before writing integration code
- When facing a binary choice (full library vs crude subprocess), there's usually a third option (structured output, streaming flags, simpler API surface)
- Propose the third option yourself rather than waiting to be pushed — the user shouldn't have to ask "is there anything we can do to mitigate"
- If you recommend skipping something as "Phase 2", immediately also describe what partial solutions exist today
