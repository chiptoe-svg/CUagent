/**
 * Shared HTTP helper for in-container MCP servers that proxy to host-side
 * services (e.g. the reminders Swift app on the Mac mini).
 *
 * Used by:
 *   - src/mcp-reminders.ts          (Apple Reminders MCP proxy)
 *   - src/ipc-mcp-stdio.ts          (todo_migrate_to_reminders tool)
 */

const DEFAULT_HOST = 'http://host.docker.internal:3002';

/** Read REMINDERS_HOST from env, falling back to the docker-gateway default. */
export function remindersHost(): string {
  return process.env.REMINDERS_HOST || DEFAULT_HOST;
}

/**
 * Fetch a host endpoint and return parsed JSON (or null for empty bodies).
 *
 * Throws an Error whose .message is a single `code: message` line when the
 * host returns a structured error, or `host_unreachable: ...` on transport
 * failure. Callers forward the message directly into MCP tool responses.
 */
export async function hostFetch<T>(
  host: string,
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${host}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `host_unreachable: could not reach ${host} — ${msg}. Is the host service running?`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    try {
      const parsed = JSON.parse(text) as { code?: string; message?: string };
      if (parsed.code) {
        throw new Error(`${parsed.code}: ${parsed.message || '(no detail)'}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes(':')) throw err;
    }
    throw new Error(`HTTP ${res.status}: ${text || '(empty body)'}`);
  }
  return text ? (JSON.parse(text) as T) : null;
}
