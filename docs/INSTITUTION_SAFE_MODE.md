# Institution-safe mode

CUagent operates under a deliberate institution-safe posture: a small, finite set of capabilities that have been affirmatively reviewed, with everything else implicit-deny. The architecture separates four orthogonal concerns — AI runtime selection, host-side AI operations, institutional data source access, and inbound channel surfaces — each gated by an explicit allow-list rather than implied by which skills happen to be installed.

This document is the reference for that posture: what it enforces, how it is configured, what the public defaults are, what local installs may override, and what is deliberately out of scope.

## Design principles

1. **Affirmative allow, implicit deny.** A capability is permitted only if it is explicitly listed in the access-permissions config with an `allowed: true` entry and a stated rationale. New skills, new providers, new runtimes do not auto-enable when installed. They become available only after an explicit policy entry is added.

2. **Source-based classification.** Data inherits its sensitivity classification from the source it came from, not from a content scan. The user's institutional email accounts are treated as `internal_use`. A future financial data source would carry its own classification appropriate to that data domain. Per-content scanning of unstructured input (regex/ML detection of sensitive terms within a message body) is documented as a future feature, not a current control.

3. **Vendor-portable workflow, vendor approval as policy.** The workflow engine is multi-runtime by design (Claude, Codex, Gemini, local). Vendor approval is encoded in the policy registry, not in workflow code. If institutional approval shifts to a different AI vendor, the change is a registry edit — not a rewrite.

4. **Operations narrower than scopes.** A granted Microsoft Graph scope like `Mail.ReadWrite` technically permits deletion and destructive folder moves. The policy layer enforces a narrower operation table: read mail, create draft, update draft, move to ordinary folder — yes; delete, send, move to trash/junk/recoverable items — no. Same shape for Google Workspace operations.

5. **Privacy-preserving audit.** Decision logs record what crossed which boundary (provider, endpoint, source classification, content hash, message ID hash) without retaining the content itself. The host-side email pre-classifier records `body_sha256` and `body_chars_sent` per residual classification; the policy layer follows the same convention.

6. **Private approval records stay private.** The reviewed approval profile (institution name, approving team, ticket reference, Azure app ID, tenant directory, exact approved scopes) is stored in `docs/APPROVAL.private.md` and `config/access-permissions.local.json` — both gitignored. The public repository carries a template, not a record.

## Scope of the reviewed workflow

The institution-safe posture is designed around a delegated Microsoft 365 personal-productivity workflow:

- Reading and triaging the user's own email (own mailboxes only).
- Identifying actions and proposed responses.
- Creating email drafts. **Not** sending mail.
- Maintaining the user's own task list.
- Maintaining the user's own calendar.

Google Workspace, when registered as a data source for the same user, runs under the parallel ruleset: own data only, drafts not sends, no destructive operations, plus full authoring control for the user's own Docs / Sheets / Slides. Drive list and read-only access support cross-referencing documents the user already authored or co-authored; arbitrary file uploads, sharing, and permission changes are denied.

## Out of scope without separate review

The following capabilities are denied by default in the public configuration and require their own institutional review before being enabled in any local override:

- **Mail.Send** and any autonomous email sending, forwarding, or reply-send.
- **Mail deletion**, move to deleted items / junk / recoverable items, permanent delete.
- **Shared mailbox** or shared calendar access.
- **App-only / client-credentials** Graph access (the workflow is delegated-only).
- **Tenant-wide directory or user reads** (`/users/{id}`, `/groups/{id}`).
- **Teams or Slack chat** reading or writing.
- **OneDrive / SharePoint / general Drive** file connectors.
- **LMS / SIS / advising** course or student record sources.
- **Restricted data** processing through any AI vendor.
- **External remote-control channels** (Slack, Discord, Signal, WhatsApp, Matrix, HTTP API).
- **Any AI vendor** not present in the access-permissions config.

The full ledger lives at [FUTURE_FEATURE_REVIEW.md](FUTURE_FEATURE_REVIEW.md) with status, rationale, and what would be needed to enable each.

## Architecture

The access-permissions config exposes four orthogonal axes that match the project's existing self-registration registries.

### AI providers

Runtime-level allow/deny. Determines whether a runtime can spawn at all. Installing a runtime SDK skill (`/add-agentSDK-claude`, `/add-agentSDK-codex`, `/add-agentSDK-gemini`) is necessary but not sufficient — the runtime must also have `allowed: true` in `ai_providers`.

```json
"ai_providers": {
  "claude":  { "allowed": true,  "execution": "container_only", "rationale": "..." },
  "codex":   { "allowed": true,  "execution": "container_only", "rationale": "..." },
  "gemini":  { "allowed": false, "rationale": "Not currently approved." },
  "local":   { "allowed": false, "rationale": "No local endpoint configured." }
}
```

Enforcement is at runtime selection. A denied runtime cannot spawn; the request is refused with `PolicyDeniedError` (in strict mode) or logged as a would-be-denial (in telemetry-only mode).

### Host AI operations

Narrow allowlist for direct host-to-AI calls — calls that originate from the host process rather than from an in-container agent loop. Anything not listed is implicit-deny.

The repository currently registers exactly one host AI operation: `email_residual_classifier`, the residual classification step in `src/email-preclassifier.ts`. Bucket 1 (action templates) and bucket 2 (skip senders) are resolved deterministically host-side without any AI involvement; only the residual reaches AI, and only with body cap, noise stripping, sort_folder taxonomy validation, and `body_sha256` audit hash all enforced before any data leaves the host. The architecture-decision block at the top of `src/email-preclassifier.ts` documents why this single host-side AI use exists despite the general "model-facing cognition runs in containers" rule.

Future host-side AI calls — if any are ever added — require their own explicit `host_ai_operations` entry. There is no generic "host can call AI" gate.

### Data sources

Operation-level allow/deny per source. The granted Graph or Workspace scopes typically permit broader operations than the workflow needs; the operation table closes that gap.

```json
"data_sources": {
  "ms365": {
    "allowed": true,
    "auth_mode": "delegated_only",
    "operations": {
      "read_mail": "allow",
      "create_draft": "allow",
      "send_mail": "deny",
      "delete_mail": "deny",
      ...
    }
  }
}
```

Operations have three permission states:

- **`allow`** — operation runs without additional approval.
- **`allow_with_log`** — operation runs but is recorded in the action audit log (calendar writes default to this).
- **`deny`** — operation is refused at the policy layer regardless of granted scope.

The `denied_scopes` array adds startup validation: when the policy loader sees a granted MSAL scope that overlaps `denied_scopes`, the system fails closed in strict mode rather than silently holding a privilege the policy doesn't expect.

### Channels

Channel-level allow/deny. Determines which inbound channels can wake or trigger the agent. Each entry is explicit about whether it is a self-only channel (the user's own bot to the user's own chat with sender allowlist enforced upstream) or a multi-user remote-control surface.

The public default permits exactly one channel: `telegram` in `self_only_main_group` mode. All other channels — Slack, Discord, WhatsApp, Signal, Matrix, Emacs, HTTP API, Gmail-as-channel — are denied in the public config and must be explicitly allowed in a local override.

## Configuration

Two files compose the policy:

- **`config/access-permissions.defaults.json`** — public, conservative, version-controlled. The single source of truth for the public posture.
- **`config/access-permissions.local.json`** — gitignored, per-install local overrides. Deep-merges over the defaults; only specifies what differs.

`config/access-permissions.local.example.json` is the public example showing how to construct the local override; copy and customize it. Never commit a populated local file.

### `institutionSafeMode` flag

The single global mode flag at the top of the config:

- **`institutionSafeMode: false`** — telemetry-only. Policy decisions are evaluated and logged; denials are non-fatal. The agent runs as it would without policy enforcement, but the audit trail records every would-be-denial. This is the public default so a fresh clone runs out-of-the-box.
- **`institutionSafeMode: true`** — strict. Policy denials throw `PolicyDeniedError` and refuse the operation. Institutional installs flip this to true in their local override after their approval profile is in place.

Telemetry-only mode exists specifically to surface drift over time without breaking a working install: changes that would be denied under strict mode show up in the audit log so the operator can correct them or update the policy.

### Local approval profile

Each institutional install maintains a private approval record at `docs/APPROVAL.private.md` (gitignored) — the populated form of the [APPROVAL_TEMPLATE.md](APPROVAL_TEMPLATE.md). The path is configurable via the `CUAGENT_APPROVAL_RECORD_PATH` environment variable. The approval record contains the institution name, approving team, ticket reference, Azure app ID, tenant directory, exact approved scopes, expiration date, and any conditions attached to the approval — none of which appear in the public repository.

Environment variables for private operational identifiers, all read from `.env` (gitignored):

- `CUAGENT_APPROVED_AZURE_APP_ID`
- `CUAGENT_TENANT_ID`
- `CUAGENT_APPROVAL_RECORD_PATH`

Real values for these are kept outside the repository. The public `config/access-permissions.defaults.json` references them by env-variable name only.

## What is enforced by this layer

- AI provider gating at runtime selection (container spawn).
- Host AI operation gating at each direct host-to-AI call site.
- Microsoft 365 / Graph operation gating with granted-scope startup validation.
- Google Workspace operation gating across mail, calendar, tasks, Docs, Sheets, Slides, and Drive.
- Channel gating at channel registration.
- Source-based data classification at registration time.

## What is **not** enforced by this layer

The policy layer is one of several controls. It does not replace, and is not a substitute for, the controls described in [`SECURITY.md`](SECURITY.md):

- Container isolation, mount scoping, non-root execution.
- IPC authorization between groups.
- Credential proxy and credential mount scoping.

It is also not, today, a network egress allowlist. The container can reach any endpoint the host's network permits; the policy layer constrains _which calls the system makes_, not _what the network forwards_. If an institution requires technical egress enforcement, that is a separate infrastructure-level control.

## Known limitations

1. **Per-content data classification is not implemented.** Source-based classification is the current model: data inherits its classification from the registered source. A forwarded email containing FERPA-protected student content from another system would be classified by the email source (`internal_use`) rather than by the embedded content (`restricted`). The policy does not catch this case today. Per-content detection is a candidate forward feature, likely co-designed with the financial / advising work that will introduce structured restricted sources.

2. **Operation classification depends on Graph URL inspection.** `POST /me/messages/{id}/send` maps cleanly to `send_mail`. `POST /me/messages/{id}/move` requires inspecting the destination folder to classify as `move_to_ordinary_folder` vs `move_to_deleted_items`. The classifier is straightforward but not exhaustive; new Graph endpoints introduced upstream will default to `unknown` and be refused in strict mode until classified.

3. **No technical network egress enforcement.** As noted above, this is a policy/intent layer, not a firewall.

4. **Channel "self-only" mode relies on upstream sender allowlist.** Telegram in `self_only_main_group` mode trusts the sender-allowlist enforcement in `src/sender-allowlist.ts`. If that upstream check is bypassed, the channel-level allow/deny in this layer does not re-validate per-message senders.

5. **Telemetry-only mode is the public default.** A fresh clone of this repository will not refuse operations even if the policy would deny them; it will only log. Institutional installs that need strict enforcement must set `institutionSafeMode: true` in their local override.

## Adding a new capability

Adding a new capability is an institutional-review step, not a code change.

1. Identify which axis it belongs to: AI provider, host AI operation, data source, or channel.
2. Confirm the capability fits within the existing approval profile, or request additional review from the approving team.
3. Add the entry to `config/access-permissions.local.json` with `allowed: true` and a rationale that references the approval (ticket / date / approving team).
4. If the capability requires new code (e.g., a new operation classifier, a new MCP server), that work is scoped separately; the policy entry alone does not implement it.

If the capability is broadly applicable (likely to be useful to other institutional installs), the public-default entry in `config/access-permissions.defaults.json` may also be updated — but only after public-repo hygiene review confirms no institution-specific identifiers leak into the public file.

## Related documents

- [`APPROVAL_TEMPLATE.md`](APPROVAL_TEMPLATE.md) — private approval record template; the populated form is gitignored.
- [`FUTURE_FEATURE_REVIEW.md`](FUTURE_FEATURE_REVIEW.md) — the feature-by-feature scope ledger.
- [`SECURITY.md`](SECURITY.md) — container, mount, IPC, and credential security model. Complementary to this document; covers the boundary that the policy layer sits on top of.
- [`../CLAUDE.md`](../CLAUDE.md) — project-level overview, including the architectural-exception note for the host-side residual classifier.
- [`../src/email-preclassifier.ts`](../src/email-preclassifier.ts) — the architecture-decision block at the top of this file documents the only host-side AI call site.
