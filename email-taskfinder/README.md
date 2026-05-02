# email-taskfinder

A small, single-purpose personal assistant: scans your inbox a few times a day,
identifies actionable mail, and creates Microsoft 365 To Do tasks.

Some shared ideas with sidestream project: [GC_Agent_Course](https://github.com/chiptoe-svg/nanoclaw_gccourse), but this one much simplified, and narrowly focussed on personal assistant aspects.
No channels, no containers, no agent loop, no daemon.

## How it works

A scheduled run walks new inbox mail through a four-bucket cascade:

| Bucket | Check | Cost | Action |
| --- | --- | --- | --- |
| 1 — `action_templates` | Sender + subject pattern in `classification.yaml` | zero LLM | create or skip per template |
| 2 — `skip_senders`     | Sender domain/address in `classification.yaml` | zero LLM | log skip |
| 3 — Solicited          | Sender in `known_contacts` or domain in `institutions` or thread already seen | LLM call | classify |
| 4 — Outreach           | Heuristic: short personal body, scheduling keywords, no list-unsub headers | LLM call | classify |
| 5 — Unsolicited        | Anything else | label-only | log |

Buckets 3 and 4 fetch the body once, strip quoted-reply chains and footer
boilerplate, and ask the model: "does this create a real obligation?" If yes,
a task is created in MS365 To Do. Either way, a row is appended to
`state/decisions.jsonl` for audit.

The scan is **read + create-task only** — it never moves, archives, or deletes
mail. Filing happens separately when you complete the task in To Do.

## Modes

Pick one in `.env`:

- `MODE=preclassifier` (default) — the host runs the cascade. Residuals go to
  OpenAI via direct API when `OPENAI_API_KEY` is set; otherwise the host
  **automatically falls back to `codex exec`** for residuals. So you can leave
  `OPENAI_API_KEY` blank if you already have the codex CLI authenticated with
  a ChatGPT subscription.
- `MODE=agent` — skip the host cascade entirely; let codex classify every
  email. Useful for sanity-checking the cascade rules end-to-end.
- `MODE=hybrid` — host always runs buckets 1+2; residuals always go to
  `codex exec` (not OpenAI direct), even if `OPENAI_API_KEY` is set.

## Setup

```bash
git clone <this-repo>
cd email-taskfinder
npm install
cp .env.example .env                # fill in MS365 + OpenAI / Codex
cp config/accounts.example.yaml         config/accounts.yaml
cp config/classification.example.yaml   config/classification.yaml
cp config/taxonomy.example.yaml         config/taxonomy.yaml
cp config/institutions.example.yaml     config/institutions.yaml
cp config/known_contacts.example.yaml   config/known_contacts.yaml
```

### MS365 auth (one-time)

You need an Azure AD app registration with delegated scopes:
`Mail.Read`, `Mail.ReadWrite`, `Tasks.ReadWrite`, `offline_access`.

Run the device-code login helper to populate `MS365_REFRESH_TOKEN` in `.env`:

```bash
npm run scripts/ms365-login   # TODO
```

### Schedule it

```bash
# Run once, dry-run (no tasks created):
npm run scan:dry

# Real run:
npm run scan
```

Then wire to cron / launchd / systemd — twice daily is the recommended cadence:

```cron
# 7:00 AM and 4:30 PM, weekdays
0  7  * * 1-5  cd /path/to/email-taskfinder && /usr/local/bin/npm run scan
30 16 * * 1-5  cd /path/to/email-taskfinder && /usr/local/bin/npm run scan
```

## How it's organized

Each capability is a self-registering **handler** in `src/handlers/`. Today
there's only one:

- `triage` — declared scopes: `Mail.Read`, `Tasks.ReadWrite`. Walks the
  cascade, creates tasks, writes `decisions.jsonl`.

Each handler declares the Microsoft Graph scopes it touches in
`src/permissions.ts`. Every Graph call asserts the active handler's
declared scopes before firing. The full list of operations the tool is
allowed to perform is one `Object.values()` away.

## Persona and skills

Persona lives in `AGENT.md` at the repo root — the runtime-agnostic identity
and tone, applied to every prompt. Edit it to change how the assistant
sounds.

Skills live in `skills/<name>/SKILL.md`, one folder per capability. Each
SKILL.md has YAML frontmatter (`name`, `description`) and a markdown body.
This is the standard format used by Claude Code, Codex CLI, NanoClaw, and
other agent runtimes — a skill folder lifts cleanly between them.

```
AGENT.md
skills/
  triage/
    SKILL.md          -- the only skill today
```

At runtime, `src/prompts.ts` reads `AGENT.md` + the active handler's
`SKILL.md` and composes them into the system prompt, with runtime-computed
data (taxonomy bullets, candidate lists, etc.) appended after.

## Adding a capability

1. Create `src/handlers/<name>.ts` that calls `registerHandler(...)`.
2. Add the import in `src/handlers/index.ts`.
3. Declare the new scopes in `src/permissions.ts`.
4. Write `skills/<name>/SKILL.md` with the task-specific instructions.

No orchestration changes. Optional: add `skills/<name>/references/` for
supporting reference docs the skill can cite.

Output goes through a parallel **notifier** registry in `src/notifiers/`.
Today the only registered notifier is stdout (so cron / launchctl captures
the summary). The registry is the seam where I'd add personal delivery
channels later (Slack incoming-webhook, email-self, file-tail, etc.) — same
pattern as handlers, no orchestration changes.

## Things I've thought about but haven't done

- Reply drafting (would be a `drafts` handler + `skills/drafts/SKILL.md`;
  `Mail.ReadWrite` scope).
- Auto-filing on task completion (a `filing` handler; `Mail.ReadWrite`).
- Calendar suggestions on scheduling emails (`calendar` handler; own
  calendar only).

Each goes through the same handler + permissions + skill seam.

## Related: the Codex Gmail plugin

OpenAI ships a [Gmail plugin for Codex](https://developers.openai.com/codex/plugins)
plus a [Manage-your-inbox use case](https://developers.openai.com/codex/use-cases/manage-your-inbox)
that solves a different but adjacent problem: agentically reading recent
threads and **drafting replies in your voice**. It's not a packaged skill in
[`openai/skills`](https://github.com/openai/skills); it's the Gmail plugin
plus a prompt like "review Gmail for what needs my attention and draft the
replies."

Differences vs. this project:

| | Codex Gmail use case | email-taskfinder |
| --- | --- | --- |
| Architecture | LLM agent loop end-to-end | Deterministic cascade, LLM only on residuals |
| Output | Gmail drafts | MS365 To Do tasks + audit JSONL |
| Rules layer | None | action_templates / skip_senders / institutions / known_contacts |
| Cost per ~50 mail | ~$0.30–$2 | ~$0.005 (only residuals hit the model) |
| Repeatability | Per-run; depends on prompt + memory | Same input → same decision until rules change |
| Audit | Chat transcript | decisions.jsonl with body_sha256, model_used per email |
| MS365 / Outlook + To Do | Limited (Outlook MCP exists, To Do not built-in) | Native |
| Scheduling | Codex Automations | Plain cron / launchd |

**They compose well.** Run this taskfinder twice daily to keep To Do honest;
use the Codex Gmail plugin ad-hoc when you actually sit down to reply.

## License

TBD.
