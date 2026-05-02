// Entrypoint. Single-shot run: acquire lock, iterate handlers, deliver
// summaries via registered notifiers, exit. Wire to cron/launchd/systemd
// for scheduling.

import { MODE } from './config.js';
import './handlers/index.js'; // side-effect imports register handlers
import './notifiers/index.js'; // side-effect imports register notifiers
import { getHandlers } from './handlers/registry.js';
import { log } from './log.js';
import { deliver } from './notifiers/registry.js';
import { setActiveHandler } from './permissions.js';
import { acquireScanLock, releaseScanLock } from './state.js';

async function main(): Promise<void> {
  if (!acquireScanLock()) {
    log.info('scan already in progress — exiting');
    process.exit(0);
  }
  try {
    log.info('starting', {
      mode: MODE,
      handlers: getHandlers().map((h) => h.name),
    });
    for (const handler of getHandlers()) {
      try {
        setActiveHandler(handler.name);
        const result = await handler.run();
        if (!result.silent) {
          await deliver(result.summary);
        }
      } catch (err) {
        log.error('handler threw', {
          handler: handler.name,
          err: String(err),
          stack: (err as Error)?.stack,
        });
      } finally {
        setActiveHandler(null);
      }
    }
  } finally {
    releaseScanLock();
  }
}

main().catch((err) => {
  log.error('main threw', { err: String(err), stack: err?.stack });
  releaseScanLock();
  process.exit(1);
});
