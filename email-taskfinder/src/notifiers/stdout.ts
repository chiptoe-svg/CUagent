// Default notifier: write the summary to stdout. Lets cron capture it,
// or a launchctl plist redirect it to a log file.

import { registerNotifier } from './registry.js';

registerNotifier({
  name: 'stdout',
  send: async (text) => {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  },
});
