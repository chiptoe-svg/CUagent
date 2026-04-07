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

## Before editing code
- Research the codebase before editing. Never change code you haven't read.
- Read the file first. Understand what's there before proposing changes.
- Check how similar features are implemented elsewhere in the codebase and follow the same pattern.

## Problem-solving approach
- When a library or API seems too complex, don't give up — look for CLI flags, output format options, or intermediate approaches before concluding "can't be done"
- Check `--help` output for every CLI tool before writing integration code
- When facing a binary choice (full library vs crude subprocess), there's usually a third option (structured output, streaming flags, simpler API surface)
- Propose the third option yourself rather than waiting to be pushed — the user shouldn't have to ask "is there anything we can do to mitigate"
- If you recommend skipping something as "Phase 2", immediately also describe what partial solutions exist today
