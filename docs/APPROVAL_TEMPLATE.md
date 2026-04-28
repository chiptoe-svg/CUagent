# Approval template

This template is for **local / private use only**. Do not commit a populated approval record to the public repository.

The populated form belongs at `docs/APPROVAL.private.md` (gitignored via `docs/*.private.md`), or at the path configured by the `CUAGENT_APPROVAL_RECORD_PATH` environment variable. The public repository carries this template; it does not carry any institution's actual approval record, app IDs, tenant directories, ticket numbers, approver identities, or approval text.

This template exists so that each institutional install has a consistent, auditable place to write down what was reviewed, by whom, when, and under what conditions — without exposing any of those operational identifiers in version control.

## Approval summary

```
Institution:
Approval date:
Approving team:
Ticket / reference:
Approver name(s):
Approver contact (internal):
Approved app name:
Approved app ID:
Tenant / directory:
Auth mode:                        # delegated_only | other (document why)
Approved Graph scopes:
Approved Workspace scopes:
Approved data sources:
Approved AI vendors:
Approved retention / logging conditions:
Approval expiration / review date:
Renewal cadence:
```

## Approved workflow

Describe the reviewed workflow in plain language. What does the assistant do? What does it not do? What is the user's role in approving destructive or external actions? This section should match what was actually presented to the approving team.

## Granted scopes vs operations enforced

Document the difference between what the OAuth / Graph / Workspace scope technically permits and what the access-permissions policy enforces. The point of writing this down is so a future reviewer can confirm the operation table in `config/access-permissions.local.json` is narrower than (or equal to) what was approved.

| Scope                                         | Technical permission                   | Operations enforced (allow / deny / allow_with_log)                                                                                                                                                    |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Mail.ReadWrite`                              | Read, create, update, delete user mail | `read_mail: allow`; `create_draft: allow`; `update_draft: allow`; `move_to_ordinary_folder: allow`; `delete_mail: deny`; `move_to_deleted_items: deny`; `move_to_junk: deny`; `permanent_delete: deny` |
| `Calendars.ReadWrite`                         | Read and write calendar events         | `read_calendar: allow`; `write_calendar: allow_with_log`                                                                                                                                               |
| `Tasks.ReadWrite`                             | Read and write tasks                   | `read_task: allow`; `write_task: allow`                                                                                                                                                                |
| (additional rows for any other granted scope) |                                        |                                                                                                                                                                                                        |

## Out-of-scope features

List features that were **not** part of this approval and would require separate review. The full canonical ledger is at [`FUTURE_FEATURE_REVIEW.md`](FUTURE_FEATURE_REVIEW.md); this section captures any institution-specific carve-outs or notes.

- (institution-specific notes here)

## Local configuration

Record where the operational identifiers are stored. **Do not paste secrets into this file.** Reference the env-variable names and file paths only.

```
CUAGENT_APPROVED_AZURE_APP_ID  → set in .env (gitignored)
CUAGENT_TENANT_ID              → set in .env (gitignored)
CUAGENT_APPROVAL_RECORD_PATH   → docs/APPROVAL.private.md (this file)

config/access-permissions.local.json   → local overrides over public defaults
.env                                    → operational identifiers and credentials
```

## Conditions and limitations

If the approval came with conditions (data retention limits, training-opt-out clauses, user-account requirements, audit cooperation, breach-notification expectations, etc.), document them here in plain language. These conditions inform the operations enforced and are referenced when adding new capabilities.

## Renewal / review notes

Each renewal cycle, append a dated note describing what was reviewed and any changes:

- `YYYY-MM-DD` — initial approval. (Summary.)
- (subsequent entries)

## Related documents

- [`INSTITUTION_SAFE_MODE.md`](INSTITUTION_SAFE_MODE.md) — the public posture this approval profile customizes.
- [`FUTURE_FEATURE_REVIEW.md`](FUTURE_FEATURE_REVIEW.md) — feature-level scope ledger.
- `config/access-permissions.local.json` — the executable form of this approval record (gitignored).
