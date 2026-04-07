<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">docs</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

## Why NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but is an incredibly complex piece of software, and the orginal author (qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) was not comfortable with it having full access to his life. OpenClaw has nearly half a million lines of code, 53 config files, 70+ dependencies and lots of real security implications. NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files.

I found it incredibly satisfying to use and grow with new capabilities, but the realities at my work (ChatGPT.edu contract and provacy concerns) made it very challenging to utilize outside of my house. I set out to recreate this tool with the same philosophy and capabilites within an OpenAI framework. The Claude Agent SDK (that Nanoclaw is built on) does a lot of heavy lifting with built-in handling of the agent loop, swarms, tools, containers, etc., and it is difficult to find all of those in a lightweight, easy use framework elsewhere. Given that this is a personal assistant, I also wanted to keep it within a subscription use case (ie. chatgpt login). I settled on using the Codex SDK - it is not a perfect fit, and out of the box it fell short in several areas, but was able to add some functionality to mimic most of the Claude Agent SDK features. 

In keeping with the orginal Nanoclaw philosophy, I abstracted all of this out of the main install, and created an /add-agentSDK-claude and /add-agentSDK-codex that you use during setup to add one or both (like you would a channel). You can run either or both - each agent gets its own container with all of its own agentSDK trimmings, but I think most will just pick the agentSDK that makes the most sense for their environment and subscription plan. One side benefit of the CodexSDK is that has support for using a local model completely (you can do that to some extent with Claude Agent SDK using MCP to go out to Ollama for instance, but my understanding is that planning is still all done with anthropic models no matter what so privacy issues still exist). Keep in mind you lose a lot going with a local model, but for certain use cases, it may be necessary (I plan to use it as a classifier to prescreen any data that I am referencing to eliminate possible sharing of private or senstive information).

I did keep the backend Claude Code - I imagine that coud be changed to Codex, but I am just really comfortable in claude code... A couple of minor things: I was struggling to get onecli to work in both so I kept the old .env method. And agent swarms are not supported by Codex - this doesnt affect my use case so it wasn't a priority, and it will take some effort to build that capability in.

Here is the comparison of capabilties between the two:
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

</head>
<body>
<h1>Claude Agent SDK vs Codex Agent SDK</h1>
<p class="subtitle">Feature comparison for the CU Agent multi-runtime architecture</p>

<table>
<thead>
<tr>
  <th style="width:170px">Feature</th>
  <th style="width:35%">Claude</th>
  <th style="width:35%">Codex</th>
  <th style="width:140px">Status</th>
</tr>
</thead>
<tbody>
<tr>
  <td class="feature">Streaming events</td>
  <td>Full &mdash; messages, tool calls, results streamed in real-time via async iterable</td>
  <td>Full &mdash; <code>runStreamed()</code> with item.started/completed events</td>
  <td><span class="badge badge-same">Same</span></td>
</tr>
<tr>
  <td class="feature">IPC follow-up messages</td>
  <td>Messages injected into active query in real-time (mid-turn)</td>
  <td>Messages processed as next turn after current turn completes. Context preserved across turns via thread.</td>
  <td><span class="badge badge-functional">Functional</span><br><small>slight delay</small></td>
</tr>
<tr>
  <td class="feature">Session resume</td>
  <td>Resume by session ID + UUID with precise re-entry point</td>
  <td>Fresh thread each container start. Context via <code>conversations/</code> archive and <code>memory/</code> directory.</td>
  <td><span class="badge badge-functional">Different approach</span><br><small>reliable, no errors</small></td>
</tr>
<tr>
  <td class="feature">Conversation archiving</td>
  <td>Pre-compact hook archives full multi-turn JSONL transcript. Uses session summary for filename.</td>
  <td>Per-turn archive from stream events &mdash; captures prompt, tool calls, command output, and response.</td>
  <td><span class="badge badge-functional">Functional</span><br><small>per-turn, not multi-turn</small></td>
</tr>
<tr>
  <td class="feature">Session summary filenames</td>
  <td>Reads <code>sessions-index.json</code> for intelligent filename</td>
  <td>Uses first 50 chars of prompt</td>
  <td><span class="badge badge-functional">Functional</span><br><small>less descriptive</small></td>
</tr>
<tr>
  <td class="feature">Global instructions</td>
  <td>Loaded from <code>AGENT.md</code>, injected via <code>systemPrompt.append</code></td>
  <td>Assembled into <code>AGENTS.md</code> from global + group sources</td>
  <td><span class="badge badge-same">Same</span><br><small>diff mechanism</small></td>
</tr>
<tr>
  <td class="feature">Persona file sync</td>
  <td>Copies <code>AGENT.md</code> &rarr; <code>CLAUDE.md</code> for SDK discovery</td>
  <td>Assembles <code>AGENTS.md</code> from sources + Codex tool guidance appended</td>
  <td><span class="badge badge-same">Same</span><br><small>diff mechanism</small></td>
</tr>
<tr>
  <td class="feature">MCP server config</td>
  <td>Passed via <code>query()</code> options (code)</td>
  <td>Written to <code>config.toml</code> (file)</td>
  <td><span class="badge badge-same">Same</span><br><small>diff mechanism</small></td>
</tr>
<tr>
  <td class="feature">Additional directories</td>
  <td><code>additionalDirectories</code> from <code>/workspace/extra/</code></td>
  <td><code>additionalDirectories</code> passed to thread options</td>
  <td><span class="badge badge-same">Same</span></td>
</tr>
<tr>
  <td class="feature">Skill loading</td>
  <td>On-demand from <code>.claude/skills/</code> via description matching + Skill tool</td>
  <td>On-demand from <code>.codex/skills/</code> via description matching</td>
  <td><span class="badge badge-same">Same</span><br><small>diff mechanism</small></td>
</tr>
<tr>
  <td class="feature">Tool quality</td>
  <td>18 built-in tools: fuzzy edit, numbered read, ripgrep search</td>
  <td>Shell + <code>apply_patch</code>. Guided via <code>AGENTS.md</code> instructions (<code>cat -n</code>, <code>grep -rn</code>, <code>find</code>).</td>
  <td><span class="badge badge-functional">Functional</span><br><small>less polished, same capabilities</small></td>
</tr>
<tr>
  <td class="feature">Usage tracking</td>
  <td>Not logged</td>
  <td>Input/output tokens logged per turn</td>
  <td><span class="badge badge-codex">Codex better</span></td>
</tr>
<tr>
  <td class="feature">Error handling</td>
  <td>Separate message types (<code>system/init</code>, <code>result/error</code>)</td>
  <td>Catch block + stale session detection via regex</td>
  <td><span class="badge badge-same">Same</span></td>
</tr>
<tr>
  <td class="feature">Local models</td>
  <td>Not possible (Anthropic API only)</td>
  <td><code>baseUrl</code> routes to OMLX, Ollama, LiteLLM, or any OpenAI-compatible endpoint. Per-group via <code>/model</code>.</td>
  <td><span class="badge badge-codex">Codex only</span></td>
</tr>
<tr>
  <td class="feature">Multi-agent orchestration</td>
  <td>Agent teams &mdash; orchestrator spawns subagents via TeamCreate/TeamDelete/SendMessage. Shared context.</td>
  <td>Not in SDK. Achievable at host level: main group delegates to specialist groups via IPC + scheduled tasks. No shared context.</td>
  <td><span class="badge badge-claude">Claude better</span><br><small>native vs host-managed</small></td>
</tr>
<tr>
  <td class="feature">Agent swarms</td>
  <td>Telegram swarm skill &mdash; each subagent gets own bot identity in group chat. Native SDK support.</td>
  <td>Not available. Would require host-level orchestration + multiple bot tokens.</td>
  <td><span class="badge badge-claude">Claude only</span></td>
</tr>
<tr>
  <td class="feature">Credential management</td>
  <td>Credential proxy (port 3001). OAuth + API key. Containers see placeholders only.</td>
  <td><code>~/.codex/auth.json</code> mount. Subscription or API key from <code>.env</code>.</td>
  <td><span class="badge badge-same">Same</span><br><small>diff mechanism</small></td>
</tr>
<tr>
  <td class="feature">Auth switching</td>
  <td><code>/auth</code>: toggle API key / OAuth. Persists via <code>.env</code> commenting.</td>
  <td><code>/auth</code>: shows subscription and API key status.</td>
  <td><span class="badge badge-same">Same</span></td>
</tr>
<tr>
  <td class="feature">Model selection</td>
  <td><code>/model</code> with Claude models only.</td>
  <td><code>/model</code> with OpenAI models + custom/local utilizing LiteLLM</td>
  <td><span class="badge badge-codex">Codex better</span><br><small>more options</small></td>
</tr>
</tbody>
</table>


</body>
</html>

## Quick Start

```bash
gh repo fork chiptoe-svg/nanoclaw_flexagents --clone
cd nanoclaw
claude
```


<details>
<summary>Without GitHub CLI</summary>

1. Fork [chiptoe-svg/nanoclaw_flexagents](https://github.com/chiptoe-svg/nanoclaw_flexagents) on GitHub (click the Fork button)
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw`
4. `claude`

</details>

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal. If you don't have Claude Code installed, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** NanoClaw runs on the Claude Agent SDK, which means you're running Claude Code directly. Claude Code is highly capable and its coding and problem-solving capabilities allow it to modify and expand NanoClaw and tailor it to each user.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Docker (macOS/Linux), [Docker Sandboxes](docs/docker-sandboxes.md) (micro VM isolation), or Apple Container (macOS)
- **Credential security** - Agents never hold raw API keys. Outbound requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects credentials at request time and enforces per-agent policies and rate limits.
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram to the core codebase. Instead, fork NanoClaw, make the code changes on a branch, and open a PR. We'll create a `skill/telegram` branch from your PR that other users can merge into their fork.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` - Add Signal as a channel

## Requirements

- macOS, Linux, or Windows (via WSL2)
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see the [documentation site](https://docs.nanoclaw.dev/concepts/architecture).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime. For additional isolation, [Docker Sandboxes](docs/docker-sandboxes.md) run each container inside a micro VM.

**Can I run this on Linux or Windows?**

Yes. Docker is the default runtime and works on macOS, Linux, and Windows (via WSL2). Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Credentials never enter the container — outbound API requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects authentication at the proxy level and supports rate limits and access policies. You should still review what you're running, but the codebase is small enough that you actually can. See the [security documentation](https://docs.nanoclaw.dev/concepts/security) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw supports any Claude API-compatible model endpoint. Set these environment variables in your `.env` file:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

This allows you to use:
- Local models via [Ollama](https://ollama.ai) with an API proxy
- Open-source models hosted on [Together AI](https://together.ai), [Fireworks](https://fireworks.ai), etc.
- Custom model deployments with Anthropic-compatible APIs

Note: The model must support the Anthropic API format for best compatibility.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Claude will try to dynamically fix them. If that doesn't work, run `claude`, then run `/debug`. If Claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

MIT
