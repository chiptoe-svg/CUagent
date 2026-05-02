// What this tool is allowed to call.
//
// Every handler declares the Graph scopes it needs (and later: Gmail, AI ops).
// Before any external call, the calling module asserts the active handler is
// allowed that scope. If a future handler tries to read calendar without
// declaring Calendars.ReadWrite, this throws.
//
// The point isn't sandboxing — the JSON-only output contract from the LLM
// already bounds blast radius. The point is *legibility*: the list of every
// Microsoft Graph operation this tool can possibly perform is in this file,
// one Object.values() away. Easy to enumerate, easy to review, code-changes
// only.

const ALLOWED_GRAPH: Record<string, ReadonlyArray<string>> = {
  // Triage today: list inbox, fetch bodies, create To Do tasks.
  triage: ['Mail.Read', 'Tasks.ReadWrite'],

  // Future handlers, declared here when they land:
  //   drafts:   ['Mail.ReadWrite']                  // write to Drafts folder
  //   filing:   ['Mail.ReadWrite']                  // move on task completion
  //   calendar: ['Calendars.ReadWrite']             // own calendar only
};

// Handler context — set by the orchestrator before each handler runs and
// cleared after. Module-scoped so Graph-call sites don't have to thread it
// through every function signature.
let activeHandler: string | null = null;

export function setActiveHandler(name: string | null): void {
  activeHandler = name;
}

export function getActiveHandler(): string | null {
  return activeHandler;
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export function assertGraphScope(scope: string): void {
  if (!activeHandler) {
    throw new PermissionDeniedError(
      `Graph call attempted with no active handler (scope=${scope})`,
    );
  }
  const allowed = ALLOWED_GRAPH[activeHandler];
  if (!allowed || !allowed.includes(scope)) {
    throw new PermissionDeniedError(
      `Handler "${activeHandler}" is not allowed Graph scope "${scope}". ` +
        `Allowed: [${allowed?.join(', ') ?? 'none'}]. ` +
        `Edit src/permissions.ts to grant.`,
    );
  }
}

// One-line description of what this tool can do, for review-time enumeration.
export function describeAllowed(): string {
  const lines: string[] = ['Allowed Microsoft Graph operations by handler:'];
  for (const [handler, scopes] of Object.entries(ALLOWED_GRAPH)) {
    lines.push(`  ${handler}: ${scopes.join(', ')}`);
  }
  return lines.join('\n');
}
