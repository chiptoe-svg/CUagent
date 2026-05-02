// Handler registry — the v2-style pattern adapted for our scope.
//
// Each capability (triage today; drafts, filing, calendar later) self-
// registers as a handler at import time. The orchestrator iterates and
// runs them in registration order. Adding a capability = adding a file
// in src/handlers/ and an import in src/handlers/index.ts. No edits to
// orchestration code.

export interface HandlerScopes {
  graph: string[];
  // Reserved for future expansion:
  //   gmail?: string[]    -- Google Workspace scopes
  //   ai?: string         -- host-side AI op label
}

export interface HandlerResult {
  /** Human-readable text to deliver via registered notifiers. */
  summary: string;
  /** If true, skip notifier delivery (e.g. the handler had nothing to report). */
  silent?: boolean;
}

export interface Handler {
  name: string;
  scopes: HandlerScopes;
  run(): Promise<HandlerResult>;
}

const handlers: Handler[] = [];

export function registerHandler(handler: Handler): void {
  if (handlers.some((h) => h.name === handler.name)) {
    throw new Error(`handler already registered: ${handler.name}`);
  }
  handlers.push(handler);
}

export function getHandlers(): ReadonlyArray<Handler> {
  return handlers;
}
