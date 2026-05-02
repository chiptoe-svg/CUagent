// Triage handler: walk new mail through the cascade, classify residuals,
// create MS365 To Do tasks. The shipping capability today.

import { runScan } from '../scan.js';
import { registerHandler } from './registry.js';

registerHandler({
  name: 'triage',
  scopes: { graph: ['Mail.Read', 'Tasks.ReadWrite'] },
  run: async () => {
    const summary = await runScan();
    return { summary };
  },
});
