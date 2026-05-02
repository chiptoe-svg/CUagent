// Notifier barrel — side-effect imports that register notifiers.
//
// Today only stdout is wired. To add a new delivery channel:
//   1. Create src/notifiers/<name>.ts that calls registerNotifier(...)
//   2. Add its import line below
//
// Examples for later:
//   - slack.ts:    post to a personal Slack via incoming webhook
//   - email.ts:    send the summary to yourself via Graph send-mail
//   - file.ts:     append to ~/Library/Logs/email-taskfinder.log
//   - telegram.ts: bot-to-self DM

import './stdout.js';
// import './slack.js';
// import './email.js';
// import './file.js';
