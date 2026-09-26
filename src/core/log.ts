/**
 * Structured stderr logger (Layer 0). Writes exactly one JSON object per line to
 * `opts.stream` (default `process.stderr`) — NEVER stdout, which is the MCP
 * transport channel (docs/security.md §2). Records below the configured level
 * are dropped. `child(bindings)` returns a logger that merges `bindings` into
 * every record.
 *
 * Redaction is INJECTED: `opts.redact` is a plain function; this module never
 * imports a redactor (the `core/redact.ts` owner supplies one). When present it
 * is applied to the merged fields object AND to the message string before the
 * line is written — the whole record is scrubbed at the sink, so an interpolated
 * message (`log.error(\`request failed: ${url}\`)`, a Graph error text echoing an
 * `access_token`) cannot bypass redaction the way a raw `msg` would.
 *
 * Six further properties are enforced HERE because the sink is the last place
 * that can still enforce them, and each one was reachable from a value that
 * originated in a tool argument, in an untyped `scripts/*.mjs` caller, or in the
 * environment the process happens to be running in:
 *
 *  - The logger OWNS `level`, `msg`, `time` and the two `logError` slots
 *    (CC-PROC-10). A caller field or a child binding of the same name is
 *    preserved under a {@link SHADOW_PREFIX} key, never in the slot the operator
 *    reads as the record's own severity, text, timestamp or health.
 *  - A level outside the vocabulary falls back to {@link FALLBACK_LEVEL} and
 *    announces itself (CC-PROC-11) instead of silently disabling the filter.
 *  - Serialization never throws into the caller (CC-PROC-12). An unserialisable
 *    field degrades the record; it does not fail the request that logged it.
 *  - NOTHING in the record-building region throws into the caller either
 *    (CC-PROC-22). Redaction is injected — it is somebody else's code — and so is
 *    every field value, whose getters run here; when any of that throws, the
 *    record collapses to its framing alone ({@link RECORD_DROPPED}). Nothing
 *    handed to a pass that failed can be shown to be safe to write, so nothing
 *    handed to it is written, the caller's `msg` included.
 *  - A clock that throws costs the TIMESTAMP, not the record, and says so. The
 *    time source is injected too; the line is written with `time: null` and
 *    {@link TIME_DROPPED} rather than with a substituted `Date.now()`, so an
 *    operator can never mistake a real wall clock for the one the embedder
 *    configured.
 *  - A sink that has GONE AWAY is survived; a sink that was NEVER USABLE is not
 *    (CC-PROC-24). An `EPIPE` after the client walks off latches the sink dead —
 *    whether it arrives as a throw from `write` (a file, a TTY) or as an `'error'`
 *    event a tick later (a pipe, which is what a supervised stdio server has) —
 *    and the process keeps serving; a non-stream in the `stream` option still
 *    fails loudly on the first write, because that one is a misconfiguration
 *    nobody will notice if the logger quietly swallows it.
 *
 * The through-line of the last four is one rule: a logging concern must never
 * become a request failure. Losing a log line is recoverable; losing the tool
 * call that produced it — or the process serving it — is not.
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

/**
 * Level used when the configured one is not in the vocabulary (CC-PROC-11).
 * Deliberately `info` — the same default `settings.ts` applies to a missing
 * `IG_LOG_LEVEL` — so a misconfigured logger behaves like an unconfigured one
 * instead of like `debug`. Failing open in a logger means more output than the
 * operator asked for, and more output means more data.
 */
const FALLBACK_LEVEL: LogLevel = 'info';

/**
 * Record keys the logger owns. Nothing a caller supplies may land in one of
 * these slots — see {@link SHADOW_PREFIX}.
 *
 * `logError` and `logErrorDetail` are reserved for the same reason the other
 * three are, and became reachable when the clock guard started writing them into
 * an OTHERWISE HEALTHY record: before that they only ever appeared in a degraded
 * line built from framing alone, where no caller key can reach. A caller field
 * named `logError` would now sit in the slot an operator greps to find broken
 * records — either inventing a failure that did not happen, or masking one that
 * did — so it is shadowed like any other collision rather than dropped.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'level',
  'msg',
  'time',
  'logError',
  'logErrorDetail',
]);

/**
 * Prefix applied to a caller field whose name collides with a reserved key, so
 * the value is preserved rather than dropped (CC-PROC-10). Chosen over the
 * simpler "built-ins last, collisions discarded" because a dropped field hides
 * information from the same operator the reserved keys are protecting.
 *
 * Documented rough edge: a caller that supplies BOTH `msg` and a literal
 * `fields.msg` puts two values in one slot, and the later key in
 * `Object.entries` order wins. No caller in this server does that, and both
 * values are caller-supplied either way, so the record stays unforgeable.
 */
const SHADOW_PREFIX = 'fields.';

/** `logError` marker written when a record could not be serialized. */
const FIELDS_DROPPED = 'log fields dropped: not JSON-serialisable';

/**
 * `logError` marker written when the record could not be built at all
 * (CC-PROC-22). The whole record is gone, not just its fields — hence a separate
 * marker from {@link FIELDS_DROPPED}, so an operator grepping the two cases apart
 * can tell "this line is missing its payload" from "this line is missing
 * everything the caller said".
 *
 * The wording names the OUTCOME, not the culprit, and that is deliberate: the
 * guard it belongs to covers the whole record-building region, which has at least
 * three doors into somebody else's code — redaction of the fields, redaction of
 * the message, and `Object.entries` running a hostile getter — and will grow a
 * fourth the next time a step is added there. A marker that said "redaction
 * failed" would send an operator after the scrubber for a field whose getter
 * threw. The culprit is named where it can be named accurately, in
 * `logErrorDetail`, which carries the thrown value's class.
 */
const RECORD_DROPPED = 'log record dropped: could not be made safe to write';

/**
 * `logError` marker written when the injected clock threw. Distinct from
 * {@link RECORD_DROPPED} because the loss is: the caller's message and fields are
 * intact and written, and only the timestamp is missing.
 */
const TIME_DROPPED = 'log timestamp dropped: the clock threw';

/** Stand-in for a `msg` (or a requested level) that is not a string. */
const UNPRINTABLE = '[unprintable]';

/**
 * Stand-in for the `msg` of a record that could not be built. Distinct from
 * {@link UNPRINTABLE}: that one means "the caller's value was not a string", this
 * one means "the caller's value exists and is deliberately not being written".
 */
const WITHHELD = '[withheld]';

/**
 * `logErrorDetail` for a thrown value that is not an `Error` and therefore has no
 * class name worth reporting. Coercing it is not an option: `String(aSymbol)`
 * throws, and a rejected object's `toString` is caller code all over again.
 */
const UNNAMED_FAILURE = 'unnamed failure: a non-Error value was thrown';

/** `msg` of the record announcing a level outside the vocabulary. */
const INVALID_LEVEL_MSG = 'invalid log level; falling back';

/**
 * Error codes that mean "this sink is gone", as opposed to "this sink was never
 * a sink" (CC-PROC-24). All four are Node stream-lifecycle codes: the peer closed
 * the pipe, or the stream was destroyed/ended underneath us. Anything else — a
 * `TypeError` from a non-stream, an `ENOSPC` from a full disk, an embedder's own
 * failure — is rethrown, because it is either a misconfiguration worth failing on
 * or a condition this module has no basis for calling terminal.
 *
 * `ERR_STREAM_ALREADY_FINISHED` is included even though `write()` does not raise
 * it in core (it is `end()`'s answer to a stream that has already finished): the
 * MEANING is exactly the survivable one — the sink has completed and will accept
 * nothing further — and the option is typed `NodeJS.WritableStream`, so a custom
 * `_write` in an embedder's rotating-file or buffering sink is free to raise it.
 * Excluding it would split one condition ("finished") from its neighbour
 * ("written after end") on an accident of which core function throws which.
 */
const SINK_GONE_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_ALREADY_FINISHED',
]);

export interface CreateLoggerOptions {
  /**
   * Minimum level to emit; records with a lower weight are dropped. A value
   * outside the vocabulary is not honoured: it falls back to
   * {@link FALLBACK_LEVEL} and the logger writes one warning record saying so.
   */
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

/**
 * The dead-sink latch (CC-PROC-24), held in a mutable cell rather than as a
 * boolean on {@link LoggerState}.
 *
 * That indirection is the whole point, and it is a decision rather than a style:
 * `child()` builds its state with `{...state}`, which COPIES a boolean and SHARES
 * an object reference. The latch describes the SINK, not the logger — every
 * logger in a tree writes to the same file descriptor — so a per-request
 * `child({ requestId })` must inherit the finding rather than rediscover it. With
 * a copied boolean, each of the dozens of children a busy server creates would
 * pay its own throw against the same dead pipe, which is the per-line cost the
 * latch exists to remove. Sharing also runs the other way on purpose: a child
 * that discovers the pipe is gone latches it for the parent and for its siblings.
 *
 * The cell is keyed by the STREAM ({@link sinkHealthFor}), not created per
 * `createLogger`, which follows that same sentence to its end: two loggers built
 * separately over one `process.stderr` are looking at one pipe, and when it goes
 * the finding is true for both. Per-tree cells were the earlier shape and they
 * cannot express the asynchronous half of this at all — a pipe reports `EPIPE`
 * once, as an event on the stream, and a cell the handler cannot reach learns
 * nothing. Loggers over DIFFERENT streams still share nothing.
 */
interface SinkHealth {
  gone: boolean;
}

/**
 * One {@link SinkHealth} per sink object, and — the reason it is a `WeakMap`
 * rather than a plain lookup — at most one `'error'` listener per sink object for
 * the life of the process.
 *
 * `createLogger` is called freely: per server, per test, and in embedders per
 * request. Attaching a listener on each call would earn a
 * `MaxListenersExceededWarning` on the tenth one and, long before that, N
 * handlers racing to latch one cell. The map is the guard because presence in it
 * IS the "already watched" fact: one lookup both dedupes the listener and hands
 * back the cell the listener latches, so the two can never drift apart the way a
 * `WeakSet` of watched streams plus a separate registry of cells could. Weak keys
 * mean this bookkeeping never keeps a finished stream alive.
 */
const SINK_HEALTH = new WeakMap<object, SinkHealth>();

/**
 * True for a sink this module can subscribe to. Deliberately narrow: it asks for
 * the one method it is about to call, on an object it is about to use as a
 * `WeakMap` key (a primitive key throws).
 *
 * A `false` here is NOT a failure — it is the never-usable sink taking the path
 * it is supposed to take. Nothing is attached, no cell is shared, and the first
 * `write` still throws the `TypeError` that tells the operator its records are
 * going nowhere. Refusing to watch is what keeps that loud (CC-PROC-24).
 *
 * A CALLABLE is excluded too, and that is the narrowness talking rather than an
 * accident of the `typeof` test: a function is a perfectly good `WeakMap` key, so
 * the key argument does not decide this one. Subscribing attaches a
 * process-lifetime handler that absorbs a whole class of errors raised on
 * somebody else's object (see {@link sinkHealthFor}), and that is far too much to
 * do to a value that does not even have the shape this module was handed.
 *
 * Equivalent-mutant note: the `stream !== null` half cannot be observed. The one
 * call site passes `opts.stream ?? process.stderr`, and `??` treats `null` as
 * nullish, so a `null` sink has already become `process.stderr` before the
 * predicate runs. It stays because the predicate is written against `unknown`
 * rather than against its current caller: without it `typeof null === 'object'`
 * lets a `null` through to `.on` and raises a `TypeError` out of `createLogger`
 * itself — a construction-time crash in a module whose whole story is that a bad
 * sink fails at the first WRITE.
 */
function isWatchableSink(stream: unknown): stream is NodeJS.WritableStream {
  return (
    typeof stream === 'object' &&
    stream !== null &&
    typeof (stream as { on?: unknown }).on === 'function'
  );
}

/**
 * The {@link SinkHealth} for `stream`, subscribing to the stream's `'error'`
 * event the first time it is asked (CC-PROC-24, asynchronous half).
 *
 * `write` throwing is only how a dead sink announces itself for a FILE or a TTY.
 * For a pipe — which is what `process.stderr` is under a supervisor, under a log
 * shipper, or under any parent that spawned this server with `stdio: 'pipe'` —
 * the write returns normally and the `EPIPE` arrives a tick later as an `'error'`
 * event. With no listener that event is fatal: measured on Node 22, a child whose
 * stderr pipe is destroyed under it exits with code 1. A logger that kills the
 * process it is logging for is a strictly worse version of the failure the
 * synchronous latch was built for, so the same predicate answers both doors.
 *
 * This CHANGES PROCESS-WIDE BEHAVIOUR and is meant to. `process.stderr` is not
 * this module's object: a listener attached here also decides what happens to an
 * `EPIPE` raised by somebody else's `console.error`. That is the right trade for
 * a stdio MCP server — a dead diagnostic pipe must not take down a live session —
 * but the reader should not have to discover it. What is absorbed is exactly
 * {@link SINK_GONE_CODES} and nothing else; everything else is rethrown from the
 * handler, which is `emit`'s own behaviour for an unhandled `'error'` and reaches
 * Node's default handler as an uncaught exception, exactly as it would have if
 * this module had never subscribed. A full disk still stops the process.
 */
function sinkHealthFor(stream: NodeJS.WritableStream): SinkHealth {
  if (!isWatchableSink(stream)) return { gone: false };
  const existing = SINK_HEALTH.get(stream);
  if (existing) return existing;
  const health: SinkHealth = { gone: false };
  SINK_HEALTH.set(stream, health);
  stream.on('error', (error: unknown) => {
    if (!isSinkGone(error)) throw error;
    health.gone = true;
  });
  return health;
}

interface LoggerState {
  stream: NodeJS.WritableStream;
  now: () => number;
  threshold: number;
  redact?: (value: unknown) => unknown;
  bindings: Record<string, unknown>;
  /** Shared by reference across `child()` — see {@link SinkHealth}. */
  sink: SinkHealth;
}

/**
 * Equivalent-mutant note: neither half is removable. `typeof value === 'object'`
 * is what stops a redactor that collapses the fields to a string from being
 * copied into the record one character per key. `value !== null` is NOT implied
 * by it — `typeof null === 'object'` — and the consumer does not spread this
 * result, it iterates `Object.entries(extra)`, which throws a `TypeError` on
 * `null`. Dropping the null test therefore turns a redactor that erased
 * everything into a withheld message plus a `logError`, instead of the clean
 * line such a redactor should produce. That mutant survived the entire suite
 * until the null-returning-redactor test in `test/core/log.test.ts` was added to
 * pin it. Arrays deliberately pass (see the array-shaped-result test).
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Runtime membership test for {@link LogLevel}.
 *
 * The compiler cannot do this job. {@link LEVEL_WEIGHT} is keyed by the
 * `LogLevel` UNION, so `LEVEL_WEIGHT[level]` is typed `number` and even
 * `noUncheckedIndexedAccess` treats the lookup as total — which is exactly how an
 * out-of-vocabulary level produced an `undefined` threshold and, since
 * `undefined < undefined` is `false`, a filter that passed every record through
 * including `debug` (CC-PROC-11). `settings.ts` enum-validates `IG_LOG_LEVEL`,
 * so the callers that can still reach this are the untyped `.mjs` entry points
 * in `scripts/` and any embedder using a cast.
 *
 * The `typeof value === 'string'` half is load-bearing twice over: it makes the
 * predicate a sound type guard, and it keeps a pathological key object (one
 * whose `toString` throws) out of the `Object.hasOwn` coercion.
 */
function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(LEVEL_WEIGHT, value);
}

/**
 * Key under which a string handed in as `fields` (or as child `bindings`) is
 * carried whole. See {@link fieldBag}.
 */
const STRING_FIELDS_KEY = 'fields';

/**
 * Normalise a `fields` / `bindings` argument before it is spread into a record.
 *
 * Both are declared `Record<string, unknown>`, but the untyped entry points can
 * hand this module anything — the premise {@link printableText} is written for.
 * Every other non-object spreads to nothing, but a STRING (primitive or boxed)
 * spreads one key per character, and it does so BEFORE the redactor runs: the
 * redactor is then shown `{0:'E',1:'A',…}`, no single value of which has a
 * token's shape or equals a registered secret, and the token is written to the
 * line one character per key, trivially reassembled. Carrying the string whole
 * under one key hands the redactor the value it can actually recognise.
 */
function fieldBag(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') return { [STRING_FIELDS_KEY]: value };
  if (value instanceof String) return { [STRING_FIELDS_KEY]: value.valueOf() };
  return value as Record<string, unknown> | undefined;
}

/**
 * Redact the message string. Cheap by construction — this runs on every emitted
 * record, and a redactor handed a string does one string pass. A redactor that
 * returns a non-string (one written for objects only) leaves a STRING `msg`
 * untouched rather than mangling it.
 *
 * The fallback runs {@link printableText} rather than returning `msg` raw, and the
 * difference is only visible for the caller the type system does not see. `msg` is
 * declared `string`, but the untyped entry points can hand this module anything —
 * the same premise {@link printableText} is written for — and both `.mjs` probe
 * scripts build a logger with a real redactor. Handed an OBJECT, the redactor
 * correctly returns a scrubbed object, the `typeof` test fails, and returning `msg`
 * would hand back the one copy that was never scrubbed, for `JSON.stringify` to
 * serialise without complaint. A string survives `printableText` unchanged, so the
 * object-only-redactor contract above is untouched (CC-PROC-178).
 */
function redactMessage(redact: (value: unknown) => unknown, msg: string): string {
  const out = redact(msg);
  return typeof out === 'string' ? out : printableText(msg);
}

/**
 * Coerce a value that has to survive into the DEGRADED record. Both helpers take
 * `unknown` on purpose: `msg` is declared `string` and the clock is declared to
 * return `number`, but the untyped entry points can hand this module anything,
 * and the degraded record is the one line that is not allowed to fail a second
 * time — a `BigInt` timestamp would throw straight back out of the `catch`.
 */
function printableText(value: unknown): string {
  return typeof value === 'string' ? value : UNPRINTABLE;
}

/** See {@link printableText}. `null` serializes; a non-number may not. */
function printableTime(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * One-line reason for a serialization failure. `JSON.stringify` itself throws a
 * `TypeError` (a `BigInt`, a cycle), but a field's own `toJSON` can throw
 * anything at all — and coercing an arbitrary rejection is not safe either
 * (`String(aSymbol)` throws), so a non-`Error` is reported generically.
 */
function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown serialization failure';
}

/**
 * One-word reason for a failure raised by INJECTED code — the thrown value's
 * `name`, and deliberately NOT its `message`.
 *
 * This is the one place where {@link failureReason} is not reused, and the
 * asymmetry with the CC-PROC-12 degraded record is the design rather than an
 * oversight left to be tidied up. A redactor throws because it choked on some
 * value, and the idiomatic way for it to say so is to put that value in its own
 * message (`cannot clone EAA…`, `unsupported input "…"`). Reporting the message
 * would therefore publish the exact string we just failed to redact, inside the
 * one record that exists precisely because redaction is not trustworthy right
 * now. The same holds for a field's getter and for a clock, which are just as
 * free to interpolate what they were looking at. `failureReason` is safe where it
 * is used because a `JSON.stringify` failure is a fact about the SHAPE of a value
 * ("Do not know how to serialize a BigInt"), and it is scrubbed on the way out;
 * neither holds here.
 *
 * `name` is coarse — a subclass that does not set it reads as `Error` — and that
 * is accepted: it is enough to point at a component, and it never carries record
 * data. The {@link printableText} guard is not decoration either: `name` is an
 * ordinary writable property, and a non-string one would take `JSON.stringify`
 * down inside the very line that may not fail a second time.
 */
function failureName(error: unknown): string {
  return error instanceof Error ? printableText(error.name) : UNNAMED_FAILURE;
}

/**
 * The record written when the record could not be built (CC-PROC-22): the
 * framing, and nothing else.
 *
 * Every caller field is dropped because every caller field is, by definition,
 * unproven — the pass that would have masked it is the pass that threw. The
 * caller's `msg` is dropped for the same reason and is the easier one to get
 * wrong: it looks like framing, but it goes through the redactor exactly like the
 * fields do, and an interpolated message (`request failed: ${url}`) is precisely
 * where a token shows up. What survives is what the sink itself knows: the
 * severity, the timestamp, and the fact that a record existed here.
 *
 * Provably serialisable by construction, which is the property that matters most
 * in this function: `level` is one of four literals from a checked call site,
 * `msg` and `logError` are module constants, `time` is a number or `null`, and
 * the detail is a string. Nothing here calls back into caller code.
 */
function droppedRecordLine(level: LogLevel, time: unknown, error: unknown): string {
  return JSON.stringify({
    level,
    msg: WITHHELD,
    time: printableTime(time),
    logError: RECORD_DROPPED,
    logErrorDetail: failureName(error),
  });
}

/**
 * Classify a sink failure as "the sink went away" (CC-PROC-24). ONE predicate for
 * both doors — a throw out of `write`, and an `'error'` event on the stream — so
 * that a pipe and a file cannot end up with two different ideas of what counts as
 * dead, and so that widening the set widens both at once.
 *
 * The `instanceof Error` half keeps the decision on the ground Node actually
 * stands on: core throws real `Error`s carrying `code`, and a hand-rolled sink
 * that throws a `{ code: 'EPIPE' }` bag has not shown enough to earn the
 * survivable path. The `typeof code === 'string'` half is what a plain
 * `TypeError` fails — which is exactly how "this was never a stream" keeps
 * reaching the caller.
 *
 * Equivalent-mutant note: that second half cannot be mutated away at source
 * level. `SINK_GONE_CODES` is a `ReadonlySet<string>` and `code` is `unknown`,
 * so the compiler rejects the membership test without it; and were it dropped
 * in the emitted JS it would still change nothing, because a set of strings
 * answers `false` to every non-string on its own. It stays for the reason it
 * was written: it is what types the lookup, and it states in the predicate the
 * rule that the set's element type only implies.
 *
 * Exported for `mcp/transport.ts`: the stdio transport's stdout is the same kind
 * of pipe as this module's stderr, dies the same way when the client exits, and
 * must classify that death by the same rule rather than a second copy of it.
 */
export function isSinkGone(error: unknown): boolean {
  const code: unknown = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' && SINK_GONE_CODES.has(code);
}

function makeLogger(state: LoggerState): Logger {
  /** Apply the injected redactor to a string, when one was injected. */
  const scrub = (text: string): string => (state.redact ? redactMessage(state.redact, text) : text);

  /**
   * Serialize one record, degrading instead of throwing (CC-PROC-12). A `BigInt`
   * field, a cycle or a throwing `toJSON` used to take `JSON.stringify` down and
   * the exception surfaced in the tool call that logged it — a logging concern
   * became a request failure.
   *
   * The degraded line keeps the level/msg/time framing and names the failure, so
   * the operator sees that a record existed and why it is incomplete; only the
   * fields are dropped, because the fields are the part that cannot be written.
   * This does NOT lean on the injected redactor: its deep clone is what turns a
   * cycle into `[Circular]`, but it passes a `BigInt` straight through, and an
   * embedder may inject a different redactor or none at all.
   *
   * The `catch` does still SCRUB, though — the reason text quotes the value that
   * broke — which makes this a third entry into the injected redactor and the one
   * that can throw from inside an already-degraded record. That case is caught by
   * `emit`'s guard and collapses to {@link droppedRecordLine} (CC-PROC-22); it
   * is not handled here, because a `try` inside this `catch` would have nothing
   * left to fall back to that the caller's guard does not already provide.
   */
  const serialize = (record: Record<string, unknown>, level: LogLevel): string => {
    try {
      return JSON.stringify(record);
    } catch (error) {
      return JSON.stringify({
        level,
        msg: printableText(record.msg),
        time: printableTime(record.time),
        logError: FIELDS_DROPPED,
        logErrorDetail: scrub(failureReason(error)),
      });
    }
  };

  /**
   * Write one finished line, distinguishing a sink that was NEVER USABLE from one
   * that has GONE AWAY (CC-PROC-24).
   *
   * The previous behaviour — let every `write` failure out — was argued for a
   * misconfigured sink, and for that case it is still right: a non-stream in the
   * `stream` option means the operator's records are going somewhere other than
   * where they think, and the only cheap way to learn that is a loud first write.
   * The argument does not transfer to a sink that WAS working. `stderr` closing
   * under a long-lived server is ordinary (the client goes away, the log shipper
   * restarts), and re-raising it turns one lost line into a failure of every
   * subsequent tool call — the process stops serving because nobody is listening
   * to its logs, which inverts the priority completely.
   *
   * Once gone, the sink is latched: rediscovering the same dead pipe costs a
   * throw on every line, on a path that runs inside request handling.
   */
  const write = (line: string): void => {
    if (state.sink.gone) return;
    try {
      // `write` returns `false` when the sink's buffer is over its high-water
      // mark, and that answer is discarded on purpose (CC-PROC-23): honouring it
      // would mean queuing until `drain`, which makes a synchronous logger
      // asynchronous and lets records leave in an order other than the one they
      // happened in. The residual is bounded memory growth behind a slow sink,
      // which is the better of the two failures. Note it does not interact with
      // the latch below: backpressure never throws, so a merely slow sink is
      // never mistaken for a dead one.
      state.stream.write(line);
    } catch (error) {
      if (!isSinkGone(error)) throw error;
      state.sink.gone = true;
    }
  };

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[level] < state.threshold) return;
    // Read the clock in its OWN guard, outside the record-building one below.
    // Both halves of that are deliberate. Guarded, because `opts.clock` is
    // injected like the redactor is, and a time source that throws used to take
    // the request down with it. Separately, because a broken clock is not a
    // broken scrubber: sharing the guard would file it under RECORD_DROPPED and
    // send an operator after the wrong component, on the one line written to tell
    // them something is wrong. It is also the value both the good line and the
    // degraded line need, so it is read exactly once.
    //
    // The failure costs the timestamp only — the caller's message and fields were
    // never in question — and it is announced rather than papered over with
    // `Date.now()`. A substituted wall clock is indistinguishable in the stream
    // from a working injected one, which is the worst possible outcome for an
    // embedder whose clock is frozen, offset or simulated: the line is plausible,
    // sorts wrong, correlates with nothing, and says nothing about why.
    let time: unknown;
    /** Set only when the clock threw; carries that line's `logErrorDetail`. */
    let clockFailure: string | undefined;
    try {
      time = state.now();
    } catch (error) {
      time = null;
      clockFailure = failureName(error);
    }
    let line: string;
    // ONE guard around the whole record-building region, rather than one around
    // each of the two redactor calls. There are in fact THREE ways into the
    // redactor from here — the fields object, the message, and `serialize`'s own
    // catch, which scrubs the reason text and so can throw from inside the
    // CC-PROC-12 degraded path — and every one of them wants the same answer:
    // abandon the record, keep the framing. Two guards would need a sentinel or a
    // duplicated write to skip the rest of `emit`, would still leave the third
    // entry point uncovered, and would place the "what do we do about it" comment
    // in two places that must not drift. The net is wider than the redactor on
    // purpose, in fact: a caller field with a throwing getter (`Object.entries`
    // runs getters) lands here too, and so will whatever step is added to this
    // region next. That is why the marker it writes names the outcome — the
    // record could not be made safe — rather than accusing the redactor of a
    // failure a field's getter caused; the culprit is reported, accurately and
    // without quoting anything, as the thrown value's class in `logErrorDetail`.
    //
    // The write is deliberately NOT inside the guard: a dead sink is classified
    // in `write` and a misconfigured one must still reach the caller, so
    // swallowing stream errors here would undo CC-PROC-24.
    try {
      // Merge per-call fields with the child bindings; bindings win on key
      // collision, matching the frozen record shape `{...fields, ...childBindings}`.
      const merged: Record<string, unknown> = { ...fieldBag(fields), ...state.bindings };
      const processed = state.redact ? state.redact(merged) : merged;
      const extra = isPlainRecord(processed) ? processed : {};
      // The message goes through the redactor too: every call site passes a
      // constant today, but the contract is "the sink scrubs the whole record".
      // The built-ins are written FIRST and the caller's keys are copied in one at
      // a time, so a colliding name is re-keyed instead of overwriting the slot
      // the operator reads (CC-PROC-10). Bindings are merged in above, so a forged
      // `msg` is stopped whether it arrived as a field or as a child binding.
      const record: Record<string, unknown> = { level, msg: scrub(msg), time };
      // Written BEFORE the caller's keys are copied in, so the shadow rule
      // applies to these two slots as well (they are reserved): a field named
      // `logError` is re-keyed rather than allowed to overwrite the marker.
      if (clockFailure !== undefined) {
        record.logError = TIME_DROPPED;
        record.logErrorDetail = clockFailure;
      }
      for (const [key, value] of Object.entries(extra)) {
        record[RESERVED_KEYS.has(key) ? SHADOW_PREFIX + key : key] = value;
      }
      line = serialize(record, level);
    } catch (error) {
      // A clock failure that is followed by a record failure is not reported
      // twice: this line has one `logError` slot, the record is gone entirely,
      // and that is the more severe of the two facts. The timestamp is `null`
      // here either way, which is the visible half of what the clock did.
      line = droppedRecordLine(level, time, error);
    }
    write(line + '\n');
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (bindings) =>
      makeLogger({ ...state, bindings: { ...state.bindings, ...fieldBag(bindings) } }),
  };
}

/** Create a {@link Logger} writing JSON lines to stderr (or a provided stream). */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const clock = opts.clock;
  const requested: unknown = opts.level;
  const known = isLogLevel(requested);
  const level = known ? requested : FALLBACK_LEVEL;
  const stream = opts.stream ?? process.stderr;
  const logger = makeLogger({
    stream,
    now: clock ? () => clock.now() : () => Date.now(),
    threshold: LEVEL_WEIGHT[level],
    redact: opts.redact,
    bindings: {},
    // One cell per SINK, not per call: shared by reference with every `child()`
    // built from this state, with any other logger over the same stream, and
    // with the stream's `'error'` handler (see {@link sinkHealthFor}).
    sink: sinkHealthFor(stream),
  });
  // Announce rather than fail silently. The fallback changes what the operator
  // sees, and a logger that quietly ignores its own configuration is the kind of
  // thing that gets discovered during an incident. The requested name is a
  // caller-supplied value, so it goes onto the line only if it is a string.
  if (!known) {
    logger.warn(INVALID_LEVEL_MSG, {
      requestedLevel: printableText(requested),
      effectiveLevel: level,
    });
  }
  return logger;
}
