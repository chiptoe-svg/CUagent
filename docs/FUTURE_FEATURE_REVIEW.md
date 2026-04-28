# Future feature review

This document is the canonical scope ledger for CUagent. It records, feature by feature, what is in the reviewed scope, what is out of the reviewed scope, why, and what would be required to bring an out-of-scope item in. The ledger exists so that scope decisions are visible and revisitable rather than implicit.

The default state for any item not listed here is **out of scope until reviewed**. Adding a feature without an entry in this ledger is not consistent with the project's design.

## Reading the table

- **In approved scope** — capability is part of the reviewed personal-productivity workflow and may be enabled in `config/access-permissions.defaults.json` or a local override.
- **Conditionally allowed** — capability has guardrails sufficient to enable for a specific use case, but the use case must be documented; broader use requires separate review.
- **Out of scope** — capability is denied by default. Enabling requires institutional review and a documented rationale in `docs/APPROVAL.private.md` (or equivalent local approval record).

## Mail

| Feature                                          | Default status        | Rationale                                                                                        | What would be needed to expand                                                              |
| ------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Read own mailbox (Inbox + folders)               | In approved scope     | Core personal-productivity workflow                                                              | —                                                                                           |
| Create draft replies                             | In approved scope     | Drafts only — no autonomous send                                                                 | —                                                                                           |
| Update existing drafts                           | In approved scope     | —                                                                                                | —                                                                                           |
| Move mail to ordinary user folders               | Conditionally allowed | Non-destructive organization of own mailbox                                                      | Per-folder allowlist if specific folders should remain off-limits                           |
| Send mail (`Mail.Send`)                          | Out of scope          | Outside reviewed scope; autonomous send is a separate trust posture                              | New review covering send conditions, recipient limits, audit; separate approved scope grant |
| Forward mail                                     | Out of scope          | Same as send                                                                                     | Same as send                                                                                |
| Reply-and-send (vs. reply-as-draft)              | Out of scope          | Same as send                                                                                     | Same as send                                                                                |
| Delete mail                                      | Out of scope          | Outside reviewed scope; not part of personal-productivity workflow                               | Deletion is rarely necessary for triage; if needed, separate review for intent and audit    |
| Move to Deleted Items / Junk / Recoverable Items | Out of scope          | Quasi-destructive — operationally similar to deletion                                            | Separate review with explicit retention semantics                                           |
| Permanent delete                                 | Out of scope          | Destructive                                                                                      | Separate review with explicit data-handling rationale                                       |
| Read shared mailbox                              | Out of scope          | Out of personal-productivity scope; shared mailbox content typically has multi-user implications | New review: which mailbox, which scope (`Mail.Read.Shared`), retention conditions           |
| Read group mailbox                               | Out of scope          | Same as shared mailbox                                                                           | Same as shared mailbox                                                                      |

## Calendar

| Feature                                     | Default status                 | Rationale                                                            | What would be needed to expand                                             |
| ------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Read own calendar                           | In approved scope              | —                                                                    | —                                                                          |
| Write own calendar (create / update events) | Conditionally allowed (logged) | Personal-productivity scope; `allow_with_log` to surface every write | Local override to remove the per-write log if log volume becomes a problem |
| Delete own calendar event                   | Conditionally allowed (logged) | Reasonable counterpart to event creation                             | Same as write                                                              |
| Read shared calendar                        | Out of scope                   | Outside personal-productivity scope                                  | New review: which calendar, which scope (`Calendars.Read.Shared`)          |
| Write shared calendar                       | Out of scope                   | Same as read-shared                                                  | Separate review with audit and consent semantics                           |

## Tasks

| Feature                                      | Default status        | Rationale                            | What would be needed to expand                                                                |
| -------------------------------------------- | --------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| Read own task list                           | In approved scope     | —                                    | —                                                                                             |
| Write own tasks (create / update / complete) | In approved scope     | —                                    | —                                                                                             |
| Delete own tasks                             | Conditionally allowed | User-initiated cleanup is reasonable | Default-allow if not surfacing concerns; default-deny if the task list is also an audit trail |

## Files (Microsoft 365)

| Feature          | Default status | Rationale                                 | What would be needed to expand                                           |
| ---------------- | -------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| OneDrive read    | Out of scope   | File access not part of reviewed workflow | New review: which folders / which file types, sensitivity classification |
| OneDrive write   | Out of scope   | Same as read                              | Same as read, plus write-target review                                   |
| SharePoint read  | Out of scope   | Multi-user file space                     | New review: which sites, which lists, sensitivity classification         |
| SharePoint write | Out of scope   | Same as read                              | Same as read                                                             |

## Files (Google Workspace)

| Feature                                                 | Default status                 | Rationale                                                                               | What would be needed to expand                                         |
| ------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Google Docs read / create / update                      | In approved scope              | Authoring control for the user's own documents                                          | —                                                                      |
| Google Sheets read / create / update                    | In approved scope              | Same as Docs                                                                            | —                                                                      |
| Google Slides read / create / update                    | In approved scope              | Same as Docs                                                                            | —                                                                      |
| Google Docs / Sheets / Slides delete                    | Out of scope                   | Deletion is destructive and typically intentional; not needed for authoring workflow    | Review specific use case                                               |
| Google Drive list                                       | In approved scope              | Necessary to find user's own documents for editing                                      | —                                                                      |
| Google Drive read arbitrary file                        | Conditionally allowed (logged) | Useful for cross-referencing user-authored documents; logging surfaces unexpected reads | —                                                                      |
| Google Drive write arbitrary file (non Doc/Sheet/Slide) | Out of scope                   | Authoring is captured by Doc/Sheet/Slide tools; arbitrary uploads not in scope          | Review specific use case (e.g., automated export of generated content) |
| Google Drive share / change permissions                 | Out of scope                   | Sharing affects multi-user trust boundaries                                             | New review for each sharing scenario                                   |
| Google Drive make public                                | Out of scope                   | Public exposure of institutional content is a separate trust decision                   | Review per-document                                                    |

## Chat / messaging

| Feature                              | Default status | Rationale                                                                       | What would be needed to expand                       |
| ------------------------------------ | -------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Microsoft Teams chat read            | Out of scope   | Chat content has multi-user implications and was not part of the reviewed scope | New review: which chats / channels, retention, audit |
| Microsoft Teams channel message read | Out of scope   | Same as Teams chat                                                              | Same as Teams chat                                   |
| Slack workspace read                 | Out of scope   | External chat platform with multi-user content                                  | New review: which workspace / channels, retention    |
| Discord channel read                 | Out of scope   | Same as Slack                                                                   | Same as Slack                                        |
| WhatsApp group read                  | Out of scope   | Same as Slack                                                                   | Same as Slack                                        |

## Inbound channels (remote control of the agent)

| Channel                           | Default status    | Rationale                                                                                             | What would be needed to expand                                          |
| --------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Telegram (`self_only_main_group`) | In approved scope | User's own bot to user's own main group; sender allowlist enforced upstream                           | —                                                                       |
| Slack                             | Out of scope      | Multi-user remote-control surface                                                                     | Review for self-only mode and sender allowlist                          |
| Discord                           | Out of scope      | Same as Slack                                                                                         | Same as Slack                                                           |
| WhatsApp                          | Out of scope      | Personal but bot-trust review still required                                                          | Review for self-only mode                                               |
| Signal                            | Out of scope      | Same as WhatsApp                                                                                      | Same as WhatsApp                                                        |
| Matrix                            | Out of scope      | Same as Slack                                                                                         | Same as Slack                                                           |
| HTTP API                          | Out of scope      | API surface needs explicit local-bind / token / CORS review                                           | Review with bind-address, token, and CORS policy                        |
| Gmail-as-channel                  | Out of scope      | Distinct from GWS data-source provider; inbound mail triggering the agent is a separate trust posture | Review for trigger conditions, sender allowlist, rate limit             |
| Emacs HTTP bridge                 | Out of scope      | Local development convenience                                                                         | Review whether the bridge is local-only and if it carries an auth token |
| iOS NanoVoice / voice channel     | Out of scope      | New trust surface (audio capture, transcription)                                                      | Review specifically                                                     |

## AI vendors

| Vendor                                        | Default status    | Rationale                                                                                                                                   | What would be needed to expand                                                   |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Anthropic Claude (in-container SDK)           | In approved scope | Container-only execution with host-side credential proxy                                                                                    | —                                                                                |
| OpenAI Codex (in-container SDK)               | In approved scope | Container-only execution with mounted credential                                                                                            | —                                                                                |
| Google Gemini (in-container SDK)              | Out of scope      | Not currently approved                                                                                                                      | Review of vendor terms, contract coverage, training-opt-out                      |
| Local model (no external egress)              | Out of scope      | No local endpoint configured                                                                                                                | Review of where the model runs, what data it sees, audit story                   |
| Any new vendor                                | Out of scope      | New vendors must be added to the registry, never auto-allowed                                                                               | Vendor approval, registry entry with `allowed: true`, rationale                  |
| OpenAI direct API (host-side, narrow op only) | In approved scope | One operation only: `email_residual_classifier` (`config/access-permissions.defaults.json`). All other host-side AI calls are implicit-deny | New host AI operation requires explicit registry entry plus institutional review |

## AI use against institutional data

| Capability                                                                    | Default status                 | Rationale                                                                                                                                                                                               | What would be needed to expand                                                            |
| ----------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Classify residual email through approved AI                                   | In approved scope              | One narrow operation: `email_residual_classifier`. Bucket 1/2 resolved deterministically host-side; only residuals reach AI; body cap, noise stripping, sort_folder validation, audit hash all enforced | —                                                                                         |
| Send full email body to AI for other purposes (summarization, drafting, etc.) | Out of scope                   | New host AI operation; new institutional review                                                                                                                                                         | Add `host_ai_operations` entry with rationale; review                                     |
| Per-content data classification (regex / ML scan within unstructured input)   | Out of scope (forward-looking) | Source-based classification is the current model; per-content detection co-designs with future financial / advising work that introduces structured restricted sources                                  | Implementation when forward features land; institutional input on classification taxonomy |
| Restricted-data processing through any AI vendor                              | Out of scope                   | Restricted classification (FERPA student records, HIPAA, financial PII, credentials) is denied for all AI processing by policy regardless of vendor                                                     | Specific contractual and review scope; not anticipated                                    |

## Other data sources

| Source                                         | Default status          | Rationale                                                                     | What would be needed to expand                                 |
| ---------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| IMAP mail accounts                             | Out of scope            | Provider definition exists at `container/providers/imap.json` but is inactive | Per-account review of host, credential storage, retention      |
| LMS / SIS (Canvas, Blackboard, course rosters) | Out of scope            | Course / student records require explicit FERPA-aware review                  | Source-by-source review; classification flows from data domain |
| Advising notes / student-records database      | Out of scope            | Same as LMS                                                                   | Same as LMS                                                    |
| Financial / accounting systems                 | Out of scope            | Same as LMS                                                                   | Source-specific review with classification flowing from domain |
| Obsidian vault                                 | Out of scope by default | Knowledge-extraction-to-Obsidian is a planned future feature                  | Review the vault's contents; confirm no restricted data        |
| Research data systems                          | Out of scope            | Multi-PI implications; research data classification varies                    | Per-system review                                              |

## Extension points

| Capability                                  | Default status | Rationale                                                                                                                                                                  | What would be needed to expand                      |
| ------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| External plugins / installable agent skills | Out of scope   | Each new skill is a new capability; auto-install would bypass review                                                                                                       | Per-skill review and explicit registry entry        |
| Self-modifying runtime behavior             | Out of scope   | Agent runner source is mounted writable per-group by design (intentional architecture decision in `src/container-runner.ts`); but skills should not modify it autonomously | Review per modification scope                       |
| External MCP servers (network-reachable)    | Out of scope   | New trust surface for tool calls                                                                                                                                           | Review per MCP server: what it exposes, auth, audit |

## Generated content

| Capability                                                        | Default status        | Rationale                                                            | What would be needed to expand                |
| ----------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| Generate draft text from public or user-provided content          | In approved scope     | Drafts only; user reviews before any external action                 | —                                             |
| Generate PowerPoint / class outline from user-provided content    | Conditionally allowed | Local file generation from safe inputs; no automatic upload or share | Review per use case if outputs become routine |
| Generate from institutional file sources (LMS, SharePoint, Drive) | Out of scope          | Source itself is out of scope                                        | Source review must come first                 |
| Auto-share / auto-upload generated content                        | Out of scope          | Sharing is a separate trust decision                                 | Review per sharing target                     |

## Logging and audit

| Item                                          | Default status        | Rationale                                                                   |
| --------------------------------------------- | --------------------- | --------------------------------------------------------------------------- |
| Decision logging (allow / deny per operation) | In approved scope     | Privacy-preserving audit; no raw content                                    |
| Body / prompt content logging                 | Denied                | Hash-only audit (`body_sha256`, `body_chars_sent`); no raw content retained |
| Token / secret logging                        | Denied                | —                                                                           |
| Calendar write logging                        | In approved scope     | `allow_with_log` ensures each write is recorded                             |
| Mail-move logging                             | Conditionally allowed | Logs the source / destination folder; no message body                       |

## How this ledger is used

When a new feature is proposed:

1. Identify the row in this table that covers it. If no row covers it, the default is out of scope — propose adding a new row before adding code.
2. If the row says "in approved scope," the feature can be developed within the existing posture; the access-permissions config may already cover it, or a small policy entry may be needed.
3. If the row says "conditionally allowed," confirm the conditions in the row are met by the proposed implementation.
4. If the row says "out of scope," the feature requires institutional review. The "what would be needed to expand" column describes the review that would unlock it. Document the outcome in the local approval record before enabling.

This ledger is the place where scope drift becomes visible. If a feature is being added without a corresponding ledger entry, that is a signal to slow down and revisit scope, not a signal to update the ledger after the fact.
