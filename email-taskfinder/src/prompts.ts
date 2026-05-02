// Persona + skills loader. Reads AGENT.md (root, runtime-agnostic) and
// skills/<handler>/SKILL.md (one folder per skill, frontmatter + body),
// composes them into the system prompt at runtime.
//
// Standard format — same shape as Claude Code .claude/skills/, Codex
// ~/.codex/skills/, NanoClaw container/skills/. A skill folder is portable
// across all of them.

import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

const ROOT = path.resolve(process.cwd());

function readOptional(p: string): string {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

export function loadAgent(): string {
  return readOptional(path.join(ROOT, 'AGENT.md')).trim();
}

export interface Skill {
  name: string;
  description: string;
  body: string;
}

export function loadSkill(handler: string): Skill | null {
  const raw = readOptional(path.join(ROOT, 'skills', handler, 'SKILL.md'));
  if (!raw) return null;
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) {
    return { name: handler, description: '', body: raw.trim() };
  }
  const front = (YAML.parse(m[1]) ?? {}) as {
    name?: string;
    description?: string;
  };
  return {
    name: String(front.name ?? handler),
    description: String(front.description ?? ''),
    body: m[2].trim(),
  };
}

/** Compose the system prompt: persona (AGENT.md) → skill body
 *  (skills/<handler>/SKILL.md) → optional runtime-computed appendix
 *  (taxonomy bullets, recent-sent examples, calendar snapshot, etc.).
 *  Sections are joined with `---` separators so the model sees clear
 *  boundaries between authored prose and runtime data. */
export function composeSystemPrompt(
  handler: string,
  appendix?: string,
): string {
  const parts: string[] = [];
  const persona = loadAgent();
  if (persona) parts.push(persona);
  const skill = loadSkill(handler);
  if (skill?.body) parts.push(skill.body);
  if (appendix && appendix.trim()) parts.push(appendix.trim());
  return parts.join('\n\n---\n\n');
}
