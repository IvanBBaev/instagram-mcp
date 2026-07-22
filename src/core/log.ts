/**
 * Structured stderr logger (Layer 0). Writes exactly one JSON object per line to
 * `opts.stream` (default `process.stderr`) — NEVER stdout, which is the MCP
 * transport channel (docs/security.md §2). Records below the configured level
 * are dropped. `child(bindings)` returns a logger that merges `bindings` into
 * every record.
 *
 * Redaction is INJECTED: `opts.redact` is a plain function; this module never
 * imports a redactor (the `mcp/redact.ts` owner supplies one). When present it
 * is applied to the merged fields object before the line is written.
 */
import type { Clock } from './clock.js';
import type { Logger, LogLevel } from './types.js';

/** Numeric ordering: debug < info < warn < error. */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface CreateLoggerOptions {
  /** Minimum level to emit; records with a lower weight are dropped. */
  level: LogLevel;
  /**
   * Optional secret-redactor applied to the merged fields object before writing.
   * Injected — this module never imports the concrete redactor.
   */
  redact?: (value: unknown) => unknown;
  /** Sink for JSON lines. Defaults to `process.stderr`. MUST NOT be stdout. */
  stream?: NodeJS.WritableStream;
  /** Time source for the `time` field (epoch ms). Defaults to `Date.now`. */
  clock?: Pick<Clock, 'now'>;
}

interface LoggerState {
  stream: NodeJS.WritableStream;
  now: () => number;
  threshold: number;
  redact?: (value: unknown) => unknown;
  bindings: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function makeLogger(state: LoggerState): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[level] < state.threshold) return;
    // Merge per-call fields with the child bindings; bindings win on key
    // collision, matching the frozen record shape `{...fields, ...childBindings}`.
    const merged: Record<string, unknown> = { ...fields, ...state.bindings };
    const processed = state.redact ? state.redact(merged) : merged;
    const extra = isPlainRecord(processed) ? processed : {};
    const record = { level, msg, time: state.now(), ...extra };
    state.stream.write(JSON.stringify(record) + '\n');
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (bindings) => makeLogger({ ...state, bindings: { ...state.bindings, ...bindings } }),
  };
}

/** Create a {@link Logger} writing JSON lines to stderr (or a provided stream). */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const clock = opts.clock;
  return makeLogger({
    stream: opts.stream ?? process.stderr,
    now: clock ? () => clock.now() : () => Date.now(),
    threshold: LEVEL_WEIGHT[opts.level],
    redact: opts.redact,
    bindings: {},
  });
}
