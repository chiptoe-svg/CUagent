// Notifier registry — where summaries get delivered.
//
// Today's only registered notifier is stdout (so the cron job's stdout
// captures the summary, or a launchctl plist can route it to a log file).
// This is the seam where future delivery channels would plug in:
//
//   Slack, Telegram, email-self, webhook, file-tail, ...
//
// Each adds a file in src/notifiers/ that calls registerNotifier(). No
// orchestration changes. The wiring is here so the extension point is
// visible in the codebase, not so any of those channels are shipped.

export interface Notifier {
  name: string;
  send(text: string): Promise<void>;
}

const notifiers: Notifier[] = [];

export function registerNotifier(n: Notifier): void {
  if (notifiers.some((x) => x.name === n.name)) {
    throw new Error(`notifier already registered: ${n.name}`);
  }
  notifiers.push(n);
}

export function getNotifiers(): ReadonlyArray<Notifier> {
  return notifiers;
}

export async function deliver(text: string): Promise<void> {
  for (const n of notifiers) {
    try {
      await n.send(text);
    } catch (err) {
      // Notifier failures are non-fatal — the decisions.jsonl is the source
      // of truth for what happened; a missing summary delivery shouldn't
      // crash the scan.
      process.stderr.write(
        `[notifier:${n.name}] delivery failed: ${String(err)}\n`,
      );
    }
  }
}
