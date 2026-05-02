---
name: triage
description: Decide needs_task / sort_folder / task_title for new mail. Return JSON only.
---

# Triage skill

For each email, decide three things independently:

## 1. `needs_task` (bool)

True ONLY if the email creates a real obligation: concrete deadline, action
from someone with standing authority, contract/billing/legal/payroll/
benefits/school/medical/government consequence, calendar/date-dependent ask,
or ties to an existing project/account/application. Default: `false`.

Test to apply: **"Will anything bad happen if the recipient does nothing?"**
If no → `false`.

## 2. `sort_folder` (string)

Which archive folder this email will eventually be filed into. REQUIRED
even when `needs_task=false`. Pick EXACTLY one value from the taxonomy
provided in the user prompt. Off-taxonomy values will be rejected by the
host validator.

## 3. `task_title` (string)

A short title for the to-do list — 4–10 words, action-verb first, names
the sender (first name when known, organization when no person is named).
Never use generic language ("a student is requesting…", "a vendor is
asking…") — always name the person or org. Even when `needs_task=false`,
emit a title so the log is useful.

## Output

Return JSON only — no prose, no markdown fences:

```
{"needs_task": <bool>, "sort_folder": "<exact taxonomy value>", "task_title": "<named, action-verb-first>", "reasoning": "<one concise sentence, also naming the sender>"}
```

When the same skill is used in batch mode (codex CLI invocation), return a
JSON array of one object per candidate, in the same order, each object
including its `email_id`:

```
[
  {"email_id": "<id>", "needs_task": false, "sort_folder": "...", "task_title": "...", "reasoning": "..."},
  ...
]
```

## Per-email independence

Treat each email as a standalone decision. Do not let one classification
influence another. Do not carry narrative from one email into the next.
