// Tiny structured-ish logger. Writes JSON-ish lines to stderr so they don't
// get mixed into the summary text on stdout.

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const THRESHOLD: Level = (process.env.LOG_LEVEL as Level) || 'info';

function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[THRESHOLD]) return;
  const ts = new Date().toISOString();
  const ctxStr = ctx ? ' ' + JSON.stringify(ctx) : '';
  process.stderr.write(`${ts} [${level}] ${msg}${ctxStr}\n`);
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx),
};
