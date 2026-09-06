import { envFlag, envIs } from './env.ts';
/**
 * Structured logging. On Lambda, one JSON line per event -> CloudWatch Logs ->
 * queryable with CloudWatch Logs Insights. Never console.log a bare string in
 * a serverless system: you cannot filter on prose.
 *
 * Also: never log the raw vendor payload or a JWT. Log ids and counts.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m',
};
const RESET = '\x1b[0m';

/** In real Lambda this comes from the request; here it makes demo output readable. */
let correlationId = 'local';
export function setCorrelationId(id: string) { correlationId = id; }

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (envIs('LOG_FORMAT', 'json')) {
    process.stdout.write(JSON.stringify({ level, msg, correlationId, ...fields }) + '\n');
  } else {
    const extra = Object.keys(fields).length
      ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')
      : '';
    process.stdout.write(`${COLORS[level]}${level.padEnd(5)}${RESET} ${msg}${'\x1b[90m'}${extra}${RESET}\n`);
  }
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return JSON.stringify(v);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => { if (envFlag('DEBUG')) emit('debug', m, f); },
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};

/** Pretty section headers for the demo narration. */
export function section(n: string, title: string) {
  const prefix = n ? `${n}. ` : '';
  const line = '─'.repeat(Math.max(0, 72 - title.length - prefix.length - 1));
  process.stdout.write(`\n\x1b[1m\x1b[35m${prefix}${title}\x1b[0m \x1b[90m${line}\x1b[0m\n`);
}
export function note(text: string) {
  process.stdout.write(`\x1b[90m   ${text}\x1b[0m\n`);
}
