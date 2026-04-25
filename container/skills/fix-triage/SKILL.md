---
name: fix-triage
description: Correct a past taskfinder decision by interviewing the user and writing a specific rule to classification.yaml, known_contacts.yaml, institutions.yaml, or action_templates. Invoked as /fix-triage <subject-fragment> or in natural language ("the Brad SPC one was wrong").
---

# /fix-triage — Correction Interview

When Chip flags a misclassified email, find it in the decision log, run a narrow clarifying interview, and write a single specific rule that prevents the same miss next time.

## When this skill runs

- Explicit: `/fix-triage <fragment>` where `<fragment>` matches part of the subject line or sender.
- Natural language: "the Brad SPC one was wrong", "can you fix the adobesign thing?", "that course substitution shouldn't have been a task".

If the user's message is ambiguous (no identifying fragment), ask ONE question: "Which email? Give me a sender or subject fragment."

## Step 1 — Find the decision

Search `/workspace/group/email-triage/state/decisions.jsonl` for matching entries. Prefer recent (tail of file).

```bash
# Latest 2000 decisions, case-insensitive grep on sender+subject
tail -n 2000 /workspace/group/email-triage/state/decisions.jsonl \
  | grep -iE '"(sender|subject)":[^,]*<fragment>'
```

If multiple matches, show up to 5 with ts/sender/subject/decision and ask "Which one?". If none: "Nothing in the log matches `<fragment>`. Try a different fragment or give me a date."

## Step 2 — Narrow clarifying question

Once a specific decision is identified, the two common errors are:

- **Wrong bucket** — it skipped or label-onlied an email that should have been a task (false negative), or it created a task for something that shouldn't be one (false positive).
- **Wrong sort_folder** — task flag was correct but the filing folder is off.

Ask ONE question, framed concretely based on what the log shows:

> Got it — "Subject" from sender, which I marked as `<decision>` (bucket: `<pass>`, sort_folder: `<sort_folder>`).
> Was the **decision** wrong (should have been `<other>`), or was the **folder** wrong (should have been `<other-folder>`)?

## Step 3 — Propose specific rule additions

Based on Chip's answer, propose **up to three fixes at different levels of generality**, narrowest first. Show the exact rule that would be written.

### If the error was skip-when-should-be-task (unsolicited false negative)

Three levels:

1. **Narrowest — per-email override**: append to `classification.yaml` `overrides:`
   ```yaml
   - email_id: "<id>"
     decision: "task"
     reasoning: "<user's explanation>"
   ```
   Fixes only this one email. Useful when you don't want a broad rule.

2. **Per-sender — known_contacts**: append address to `known_contacts.yaml`.
   Treats this person as solicited forever. Useful when it's a real correspondent.

3. **Per-org — institutions**: append domain to `institutions.yaml`.
   Treats every sender from this domain as solicited. Useful when the sender's org is always worth attention.

### If the error was task-when-should-be-skip (solicited false positive)

1. **Narrowest — per-email override**: as above, with `decision: "skip"`.
2. **Action-template (skip variant)**: append to `action_templates:` with `skip: true`.
   ```yaml
   - name: "<descriptive-name>"
     match:
       from_address: "<sender>"
       subject_contains: ["<subject-fragment>"]
     skip: true
   ```
   Useful for recurring auto-mail (e.g., adobesign completion notices).
3. **Skip-sender rule**: append to `skip_senders:` with the email's `sort_folder`.
   Fires for every email from that sender, regardless of subject.

### If the error was wrong-folder

1. **Per-email override** with corrected `sort_folder`.
2. **Per-sender default**: add a `skip_senders` entry (if decision was skip) or a taxonomy hint in `email-archive/config.yaml`.

### If the error was a personal-outreach miss (should have matched bucket 4 but didn't)

Ask: "What signal was most relevant — the greeting, the scheduling language, or that you knew the sender?"

- Greeting match failed → suggest adding a regex pattern to the skill's personal-greeting list (requires skill edit, not a config edit — note that this is a bigger change and ask Chip to confirm).
- Scheduling keyword missing → propose adding the phrase (e.g., "let's grab lunch") to the `scheduling_keywords` list in the taskfinder SKILL.md. Flag as bigger-change.
- Already-known sender → add to `known_contacts.yaml` (smaller change; this is Bucket 3, not Bucket 4).

## Step 4 — Apply the user's pick

Use `mcp__nanoclaw__file_edit` to append the chosen rule to the right file:

- `classification.yaml` for `overrides`, `action_templates`, `skip_senders`
- `known_contacts.yaml` for contacts
- `institutions.yaml` for domains

Validate the write by reading back the file and grepping for the added line.

## Step 5 — Confirm

Send ONE concise confirmation:

> ✓ Added `<rule>` to `<file>`. This will take effect on the next `/email-taskfinder` run.

If the user wants retroactive action ("can you actually make this a task now?"), that's separate — offer to create the task directly via `mcp__ms365__create-todo-task` with the email metadata from the decision log.

## Constraints

- **One rule per interview.** If Chip needs multiple fixes, run `/fix-triage` multiple times. Batching leads to sloppy rules.
- **Always show the exact YAML before writing.** Chip should see what's being added, not trust the description.
- **Never modify historical decisions.jsonl entries.** Corrections are forward-looking; the log stays immutable for benchmark integrity.
- **Never infer intent beyond what Chip states.** If the answer is ambiguous ("I don't know"), bias toward the narrowest fix (per-email override) — it's reversible.
