import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';

import { createLogger } from '../../src/core/log.js';
import { createRedactor } from '../../src/core/redact.js';
import type { LogLevel } from '../../src/core/types.js';
import { fakeClock } from '../helpers/fake-clock.js';

/** Locate the repo root: the nearest ancestor directory holding a `package.json`. */
function findRepoRoot(): string {
  const candidates: string[] = [process.cwd()];
  let dir = dirname(fileURLToPath(import.meta.url));
  let parent = dirname(dir);
  while (dir !== parent) {
    candidates.push(dir);
    dir = parent;
    parent = dirname(dir);
  }
  candidates.push(dir);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  throw new Error('could not locate repo root');
}

/**
 * The survivable set as `src/core/log.ts` spells it, read out of the module
 * rather than copied here. `SINK_GONE_CODES` is module-private on purpose — it
 * is an implementation detail, not part of the logger's contract — so the two
 * loops below walked a hand-written duplicate, which pins the set in one
 * direction only: dropping a member turns them red, ADDING one is invisible.
 * The cost of that gap is not symmetric with its size. `isSinkGone` feeds a
 * permanent latch, so a fifth code — `EAGAIN` on a non-blocking pipe, say — turns
 * a condition that clears by itself into the end of logging for the life of the
 * process, and the only negative control the file carries is `ENOSPC`.
 */
const SINK_GONE_CODES: readonly string[] = (() => {
  const source = readFileSync(join(findRepoRoot(), 'src', 'core', 'log.ts'), 'utf8');
  const literal = /const SINK_GONE_CODES[^=]*= new Set\(\[([^\]]*)\]\)/.exec(source);
  const body = literal?.[1];
  assert.ok(body !== undefined, 'the SINK_GONE_CODES set literal no longer parses out of log.ts');
  const codes = [...body.matchAll(/'([^']+)'/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
  assert.ok(codes.length > 0, 'the SINK_GONE_CODES set literal parsed to no codes');
  return codes;
})();

interface Collector {
  stream: Writable;
  /** All completed lines, parsed as JSON records. */
  records(): Array<Record<string, unknown>>;
  /** Raw concatenated output. */
  raw(): string;
}

function collector(): Collector {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb: () => void) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    raw: () => chunks.join(''),
    records: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

test('writes one JSON object per line with level, msg, time and fields', () => {
  const sink = collector();
  const clock = fakeClock(1_700_000_000_000);
  const log = createLogger({ level: 'debug', stream: sink.stream, clock });

  log.info('hello', { a: 1 });
  log.warn('careful', { b: 'x' });

  const raw = sink.raw();
  assert.ok(raw.endsWith('\n'), 'each record ends with a newline');
  assert.equal(raw.split('\n').filter((l) => l.length > 0).length, 2);

  const [first, second] = sink.records();
  assert.deepEqual(first, { level: 'info', msg: 'hello', time: 1_700_000_000_000, a: 1 });
  assert.deepEqual(second, { level: 'warn', msg: 'careful', time: 1_700_000_000_000, b: 'x' });
});

test('every level method emits under its own name and forwards its caller fields', () => {
  // The four methods are four one-line adapters over the same `emit`. Nothing
  // else in the suite calls all of them WITH fields, so a method that forwards
  // the wrong level (an error logged as `warn` disappears at `IG_LOG_LEVEL=error`)
  // or silently drops its fields (an incident record with no request id) would
  // ship unnoticed.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(3) });

  log.debug('d', { at: 'debug' });
  log.info('i', { at: 'info' });
  log.warn('w', { at: 'warn' });
  log.error('e', { at: 'error' });

  assert.deepEqual(sink.records(), [
    { level: 'debug', msg: 'd', time: 3, at: 'debug' },
    { level: 'info', msg: 'i', time: 3, at: 'info' },
    { level: 'warn', msg: 'w', time: 3, at: 'warn' },
    { level: 'error', msg: 'e', time: 3, at: 'error' },
  ]);
});

test('the level filter is exact at every boundary, not just at the one the suite happens to use', () => {
  // The filter is `weight(level) < threshold`, and the weights are spaced ten
  // apart — which means a single weight can be moved a long way before ANY test
  // that only ever configures one level notices. Both failure directions are
  // expensive: a boundary that is one notch too tight silences the errors an
  // operator configured the server to see, and one notch too loose ships debug
  // records that carry far more request detail than `IG_LOG_LEVEL=warn` implies.
  // The full matrix is the only thing that pins each adjacent pair.
  const configured: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const expected: Record<LogLevel, LogLevel[]> = {
    debug: ['debug', 'info', 'warn', 'error'],
    info: ['info', 'warn', 'error'],
    warn: ['warn', 'error'],
    error: ['error'],
  };

  for (const level of configured) {
    const sink = collector();
    const log = createLogger({ level, stream: sink.stream, clock: fakeClock(0) });

    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    assert.deepEqual(
      sink.records().map((r) => r.level),
      expected[level],
      `level ${level} must emit exactly itself and everything above it`,
    );
  }
});

test('records below the configured level are dropped', () => {
  const sink = collector();
  const log = createLogger({ level: 'warn', stream: sink.stream });

  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');

  const levels = sink.records().map((r) => r.level);
  assert.deepEqual(levels, ['warn', 'error']);
});

test('nothing is written when every call is below threshold', () => {
  const sink = collector();
  const log = createLogger({ level: 'error', stream: sink.stream });

  log.debug('d');
  log.info('i');
  log.warn('w');

  assert.equal(sink.raw(), '');
  assert.equal(sink.records().length, 0);
});

test('child bindings are merged into every record and accumulate', () => {
  const sink = collector();
  const clock = fakeClock(42);
  const log = createLogger({ level: 'debug', stream: sink.stream, clock });

  const child = log.child({ requestId: 'r1' });
  const grandchild = child.child({ tool: 'media_list' });

  child.info('a', { step: 1 });
  grandchild.error('b');

  const [a, b] = sink.records();
  assert.deepEqual(a, { level: 'info', msg: 'a', time: 42, step: 1, requestId: 'r1' });
  assert.deepEqual(b, {
    level: 'error',
    msg: 'b',
    time: 42,
    requestId: 'r1',
    tool: 'media_list',
  });

  // The parent logger is unaffected by child bindings.
  log.info('c');
  const c = sink.records()[2];
  assert.deepEqual(c, { level: 'info', msg: 'c', time: 42 });
});

test('child bindings win over per-call fields on key collision', () => {
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(0) });

  log.child({ k: 'binding' }).info('m', { k: 'field' });

  assert.equal(sink.records()[0]?.k, 'binding');
});

test('a child binding overrides an inherited binding of the same name', () => {
  // `child()` is how per-request context is layered on (`requestId`, then `tool`).
  // If the inherited value won, a re-bound key would freeze at whatever the
  // outermost logger set — every nested record would carry the wrong attribution
  // and the audit trail would point at the wrong tool.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(0) });

  log.child({ scope: 'outer' }).child({ scope: 'inner' }).info('m');

  assert.equal(sink.records()[0]?.scope, 'inner');
});

test('a child inherits the stream, the threshold, the clock and the redactor', () => {
  // A child is built from a spread of the parent state. Losing any one of those
  // four is silent and severe: a lost stream writes to the process stderr behind
  // the sink's back, a lost threshold floods debug output from inside a request,
  // a lost clock corrupts every timestamp, and a lost redactor leaks the secret
  // that the parent was configured to mask.
  const sink = collector();
  const log = createLogger({
    level: 'warn',
    stream: sink.stream,
    clock: fakeClock(11),
    redact: (value: unknown): unknown =>
      typeof value === 'object' && value !== null
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, k === 'token' ? '[REDACTED]' : v]),
          )
        : value,
  });

  const child = log.child({ requestId: 'r9' });
  child.debug('below threshold');
  child.warn('kept', { token: 'ig-fake-token-value' });

  assert.deepEqual(sink.records(), [
    { level: 'warn', msg: 'kept', time: 11, token: '[REDACTED]', requestId: 'r9' },
  ]);
});

test('the injected redactor is applied to the merged fields object', () => {
  const sink = collector();
  const redact = (value: unknown): unknown => {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = k === 'token' ? '[REDACTED]' : v;
    }
    return out;
  };
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(7), redact });

  log.child({ token: 'EAAsecret' }).info('call', { safe: true });

  const record = sink.records()[0];
  assert.deepEqual(record, {
    level: 'info',
    msg: 'call',
    time: 7,
    safe: true,
    token: '[REDACTED]',
  });
});

test('a secret-named field is masked by key, not by value shape', () => {
  // The real redactor masks `access_token` BY KEY NAME, which only works while it
  // still sees an object. This is the test that separates "redact the record" from
  // "redact the serialized line": the value here is deliberately not token-shaped,
  // so a redactor applied to the finished JSON string would find nothing to mask
  // and the credential would land in the log file verbatim.
  const sink = collector();
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: fakeClock(5),
    redact: createRedactor(),
  });

  log.info('graph call', { access_token: 'not-token-shaped-fake-value', path: '/me/media' });

  assert.deepEqual(sink.records()[0], {
    level: 'info',
    msg: 'graph call',
    time: 5,
    access_token: '[REDACTED]',
    path: '/me/media',
  });
});

test('every secret field is masked, not only the first one', () => {
  // Redaction has to cover the whole merged object — per-call fields AND child
  // bindings. A scrubber that stops after one key (or only ever sees one of the
  // two sources) leaves the rest of the record raw, and the leak is invisible in
  // review because the line does contain a `[REDACTED]`.
  const sink = collector();
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: fakeClock(5),
    redact: createRedactor(),
  });

  log
    .child({ appsecret_proof: 'binding-side-fake-proof' })
    .info('graph call', { access_token: 'field-side-fake-token', client_secret: 'fake-secret' });

  assert.deepEqual(sink.records()[0], {
    level: 'info',
    msg: 'graph call',
    time: 5,
    access_token: '[REDACTED]',
    client_secret: '[REDACTED]',
    appsecret_proof: '[REDACTED]',
  });
});

test('the injected redactor also scrubs the message string', () => {
  const sink = collector();
  const secret = 'EAAGm0PX4ZCpsBA' + 'x'.repeat(40);
  const redact = createRedactor({ extraSecrets: [secret] });
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(7), redact });

  // An interpolated message is the realistic leak: a Graph error text or a URL
  // carrying `access_token=` reaches the sink as `msg`, not as a field.
  log.error(`request failed: https://graph.facebook.com/me?access_token=${secret}`);

  const raw = sink.raw();
  assert.equal(raw.includes(secret), false, 'the secret must not reach the stream');
  assert.match(String(sink.records()[0]?.msg), /access_token=\[REDACTED\]/);
});

test('a message-only leak of a token-shaped string is masked without registration', () => {
  const sink = collector();
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: fakeClock(1),
    redact: createRedactor(),
  });

  log.warn('token EAA0123456789abcdefghijklmnop rejected by Meta');

  assert.equal(sink.records()[0]?.msg, 'token [REDACTED] rejected by Meta');
});

test('a redactor that does not return a string leaves msg intact', () => {
  const sink = collector();
  // An object-only redactor (returns a record for any input) must not turn the
  // message into "[object Object]" — msg falls back to the original string.
  const redact = (): unknown => ({});
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1), redact });

  log.info('plain message');

  assert.deepEqual(sink.records()[0], { level: 'info', msg: 'plain message', time: 1 });
});

test('a non-string message is not handed back unredacted', () => {
  const sink = collector();
  const secret = 'EAAGm0PX4ZCpsBA' + 'y'.repeat(40);
  const redact = createRedactor({ extraSecrets: [secret] });
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(3), redact });

  // The test above pins the fallback for a STRING message, and that fallback is
  // correct there. The same `typeof` test decides a second case it was not written
  // for: when `msg` itself is not a string, the redactor returns a scrubbed OBJECT,
  // the test fails, and the ORIGINAL object — the one still holding the secret — is
  // what reaches the record. `JSON.stringify` serialises it without complaint, so
  // nothing downstream notices. `msg` is declared `string`, but this module already
  // states in `printableText` that the untyped entry points can hand it anything,
  // and two of them do: both `.mjs` probe scripts build a logger with a real
  // redactor (CC-PROC-178).
  //
  // Cast rather than a type error: the point of the test is precisely the caller
  // the type system does not see.
  (log.info as (msg: unknown) => void)({ note: `token is ${secret}` });

  assert.equal(sink.raw().includes(secret), false, 'the secret must not reach the stream');
  assert.equal(sink.records()[0]?.msg, '[unprintable]');
});

test('a string passed as fields is redacted whole, never spread one character per key', () => {
  const sink = collector();
  const token = 'EAA' + 'x'.repeat(30);
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: fakeClock(4),
    redact: createRedactor(),
  });

  // `fields` is declared a record, but the untyped `.mjs` entry points can pass
  // anything. Spread before redaction, a string became `{0:'E',1:'A',…}`: no single
  // character has a token's shape, so the redactor passed every one of them and
  // the token reached the line in pieces. Cast: the caller is the one the type
  // system does not see.
  (log.info as (msg: string, fields: unknown) => void)('string fields', token);
  (log.info as (msg: string, fields: unknown) => void)('boxed fields', new String(token));

  assert.deepEqual(sink.records(), [
    { level: 'info', msg: 'string fields', time: 4, fields: '[REDACTED]' },
    { level: 'info', msg: 'boxed fields', time: 4, fields: '[REDACTED]' },
  ]);
});

test('string child bindings are redacted whole, never spread one character per key', () => {
  const sink = collector();
  const token = 'EAA' + 'x'.repeat(30);
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: fakeClock(5),
    redact: createRedactor(),
  });

  (log.child as (bindings: unknown) => typeof log)(token).warn('string bindings');

  assert.deepEqual(sink.records(), [
    { level: 'warn', msg: 'string bindings', time: 5, fields: '[REDACTED]' },
  ]);
});

test('a redactor that collapses the fields to a scalar drops them, never spreads them', () => {
  const sink = collector();
  // `redact` is an injected seam typed `unknown -> unknown`; a stringifying
  // scrubber returns a string for the fields object too. Spreading that into the
  // record would emit `{0:'s',1:'c',…}` — one key per character, burying the
  // level/msg/time the sink exists to carry. Dropping is the only safe reading.
  const redact = (): unknown => 'scrubbed';
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1), redact });

  log.warn('rate limited', { host: 'graph.instagram.com', usagePct: 95 });

  assert.deepEqual(sink.records()[0], { level: 'warn', msg: 'scrubbed', time: 1 });
});

test('a redactor that empties the message emits an empty msg rather than the original', () => {
  // `redactMessage` falls back to the original string only when the redactor
  // returns a NON-string. An empty string is a legitimate redactor answer
  // ("everything in this message was secret"); treating it as a miss would put
  // the unmasked message back on the line — a fallback that leaks precisely when
  // the redactor was most sure it should not.
  const sink = collector();
  const redact = (value: unknown): unknown => (typeof value === 'string' ? '' : value);
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(2), redact });

  log.error('everything here is secret');

  assert.equal(sink.records()[0]?.msg, '');
});

test('an array-shaped redactor result is spread by index — a documented rough edge', () => {
  // `isPlainRecord` accepts arrays (`typeof [] === 'object'`), so a redactor that
  // returns an array turns the fields into `{0:…,1:…}` instead of dropping them.
  // No redactor in this server does that, and the record still carries level/msg/
  // time, so it is pinned rather than changed — but it is the one input shape
  // where the "drop anything that is not a record" rule does not hold.
  const sink = collector();
  const redact = (): unknown => ['a', 'b'];
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(2), redact });

  log.info('m', { x: 1 });

  assert.deepEqual(sink.records()[0], { level: 'info', msg: 'm', time: 2, 0: 'a', 1: 'b' });
});

test('a redactor that returns null drops the fields rather than degrading the record', () => {
  // The companion to the scalar case above, and the one shape where the explicit
  // `value !== null` in `isPlainRecord` is doing work its `typeof` test does not
  // already do: `typeof null === 'object'`, so without it the null reaches the
  // `Object.entries` loop that copies the fields in, and that throws. The visible
  // difference is not "fields dropped" versus "fields dropped" — it is this clean
  // line versus `msg: '[withheld]'` plus a `logError`. A redactor that erased
  // everything must not be reported as a redactor that broke.
  const sink = collector();
  const redact = (): unknown => null;
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1), redact });

  log.info('hello', { a: 1 });

  assert.deepEqual(sink.records()[0], { level: 'info', msg: 'hello', time: 1 });
});

test('an undefined field value is omitted from the line instead of being written as null', () => {
  // Optional context (`fbtraceId`, `status`) is routinely passed as `undefined`.
  // `JSON.stringify` drops those keys, so absent means "not known". Writing them
  // as `null` instead would make every log line claim to carry a value it does
  // not have, and operator greps for a missing trace id would come back empty.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(2) });

  log.warn('partial', { known: 1, unknown: undefined });

  assert.deepEqual(sink.records()[0], { level: 'warn', msg: 'partial', time: 2, known: 1 });
  assert.equal(sink.raw().includes('null'), false);
});

test('a falsy field value is a value — 0, empty string, false and null are written, not dropped', () => {
  // The copy loop keys on presence, not on truth, and the difference is the
  // whole meaning of these lines: `remaining: 0` is a budget that is exhausted,
  // `cursor: ''` is a page with nothing after it, `retried: false` is a request
  // that was not retried, `fbtraceId: null` is a trace the Graph did not return.
  // A loop that copied only truthy values would file all four under "not known"
  // — the shape the `undefined` test above reserves for a field the caller never
  // passed — and an exhausted budget would read as an unreported one. Bindings
  // go through the same loop, so a child bound to a falsy value is pinned too.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(3) });

  log
    .child({ attempt: 0 })
    .info('m', { remaining: 0, cursor: '', retried: false, fbtraceId: null });

  assert.deepEqual(sink.records(), [
    {
      level: 'info',
      msg: 'm',
      time: 3,
      attempt: 0,
      remaining: 0,
      cursor: '',
      retried: false,
      fbtraceId: null,
    },
  ]);
});

test('a clock that reads zero stamps the record with 0 — the epoch is a time, not a missing one', () => {
  // `time: null` is this logger's broken-clock signature (see the clock-failure
  // tests below), and it means something only while a WORKING clock can never
  // produce it. A simulated or offset clock that starts at 0 is a working clock;
  // a record that showed `null` for it — with no `logError` saying why — would
  // send an operator after a clock that is fine. The degraded line carries its
  // own copy of the timestamp (`printableTime`), so both shapes are pinned.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(0) });

  log.info('m', { a: 1 });
  log.info('m', { n: 1n });

  const [good, degraded] = sink.records();
  assert.deepEqual(good, { level: 'info', msg: 'm', time: 0, a: 1 });
  const { logErrorDetail, ...framing } = degraded ?? {};
  assert.deepEqual(framing, {
    level: 'info',
    msg: 'm',
    time: 0,
    logError: 'log fields dropped: not JSON-serialisable',
  });
  assert.match(String(logErrorDetail), /BigInt/i);
});

test('a clock returning a serialisable non-number stamps that value, not a broken-clock null', () => {
  // The two degraded lines coerce the timestamp through `printableTime`; the
  // record line deliberately does not, and until 2026-09-23 nothing said so —
  // `time: printableTime(time)` there survived the entire suite (CC-PROC-181).
  // It is not the harmless tightening it reads as. `time: null` is a reserved
  // shape here: it is written together with `log timestamp dropped: the clock
  // threw`, and the test above exists to keep a WORKING clock from ever
  // producing it. A clock handing back a string throws nothing and serialises
  // fine, so it never reaches either degraded line — the coercion would write a
  // bare `null` with no marker beside it, which is the broken-clock signature on
  // the one line where the clock did not break. An embedder debugging its own
  // clock would be sent after this module instead, and the value that would have
  // told them what their clock returns is the one thing thrown away.
  const sink = collector();
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: { now: () => '2026-09-23T00:00:00Z' as unknown as number },
  });

  log.info('m', { a: 1 });

  assert.deepEqual(sink.records()[0], {
    level: 'info',
    msg: 'm',
    time: '2026-09-23T00:00:00Z',
    a: 1,
  });
});

test('a field that cannot be serialised degrades the record instead of failing the caller', () => {
  // A BigInt field used to make `JSON.stringify` throw out of `emit` and into the
  // tool call that logged it — a logging concern turned into a request failure
  // (CC-PROC-12). Swallowing it silently would be the other bad answer: the
  // operator would believe a line exists that does not. The degraded record is
  // the third option — the fields are dropped because the fields are the part
  // that cannot be written, and the level/msg/time framing plus a stated reason
  // survive, so the incomplete line is visibly incomplete.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(2) });

  assert.doesNotThrow(() => {
    log.info('bigint field', { n: 1n });
  });

  const { logErrorDetail, ...framing } = sink.records()[0] ?? {};
  assert.deepEqual(framing, {
    level: 'info',
    msg: 'bigint field',
    time: 2,
    logError: 'log fields dropped: not JSON-serialisable',
  });
  // The engine's wording is not this suite's to pin; that it names the cause is.
  assert.match(String(logErrorDetail), /BigInt/i);
});

test('a cyclic field degrades too when no redactor is injected to neutralise it', () => {
  // `log.ts` has no cycle defence of its own — the `[Circular]` marker in the
  // test below comes from the INJECTED redactor, and an embedder can inject a
  // different one or none at all. The guarantee that has to survive that
  // substitution is this one: the request that logged the cycle still completes.
  const sink = collector();
  const cyclic: Record<string, unknown> = { name: 'node' };
  cyclic.self = cyclic;
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(3) });

  assert.doesNotThrow(() => {
    log.warn('cycle', { payload: cyclic });
  });

  const record = sink.records()[0] ?? {};
  assert.equal(record.level, 'warn');
  assert.equal(record.msg, 'cycle');
  assert.equal(record.time, 3);
  assert.equal(record.logError, 'log fields dropped: not JSON-serialisable');
  assert.equal(record.payload, undefined, 'the unwritable fields are dropped, not half-written');
});

test('the injected redactor does not neutralise a BigInt — the sink guard is what does', () => {
  // Easy to assume the production redactor covers this the way it covers cycles.
  // It does not: `redactValue` returns any non-string, non-object value
  // unchanged, so a BigInt reaches `JSON.stringify` exactly as it would with no
  // redactor at all. Production therefore depends on the sink guard here, not on
  // `core/redact.ts` — which is why this test injects the real redactor.
  const sink = collector();
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: fakeClock(4),
    redact: createRedactor(),
  });

  assert.doesNotThrow(() => {
    log.error('graph payload', { cursor: 9007199254740993n });
  });

  const record = sink.records()[0] ?? {};
  assert.equal(record.msg, 'graph payload');
  assert.equal(record.logError, 'log fields dropped: not JSON-serialisable');
});

test('a toJSON that throws a non-Error is reported generically rather than coerced', () => {
  // `JSON.stringify` throws a `TypeError` on its own, but a field's `toJSON` runs
  // first and can reject with anything — and coercing an arbitrary rejection is
  // not safe either (`String(aSymbol)` throws), which would defeat the whole
  // point of the guard by throwing from inside the catch.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(5) });
  // Held as `unknown` because that is what it is: the rejection reaching the
  // catch carries no `message` and no prototype the sink can rely on.
  const bareReason: unknown = 'a bare string, not an Error';
  const hostile = {
    toJSON(): never {
      throw bareReason;
    },
  };

  assert.doesNotThrow(() => {
    log.info('hostile field', { hostile });
  });

  assert.deepEqual(sink.records()[0], {
    level: 'info',
    msg: 'hostile field',
    time: 5,
    logError: 'log fields dropped: not JSON-serialisable',
    logErrorDetail: 'unknown serialization failure',
  });
});

test('the degraded record survives a msg and a clock that are not what they claim to be', () => {
  // The degraded line is the one record that must not fail a second time, so it
  // is rebuilt from coerced values instead of from whatever the state held. Both
  // routes into that state are open to the untyped `.mjs` callers: a `msg` that
  // is not a string and a clock that does not return a number. Either one would
  // throw again from inside the catch if the values were reused verbatim.
  const sink = collector();
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: { now: () => 1n as unknown as number },
  });

  assert.doesNotThrow(() => {
    log.error(7n as unknown as string);
  });

  const record = sink.records()[0] ?? {};
  assert.equal(record.level, 'error', 'the severity is never in doubt');
  assert.equal(record.msg, '[unprintable]');
  assert.equal(record.time, null);
});

test('the degraded line runs the reason through the redactor but never its own marker or level', () => {
  // Three strings share the fallback line, and only one of them is somebody
  // else's text. `logErrorDetail` is whatever the engine or a `toJSON` said and
  // is scrubbed for that reason. `logError` and `level` are this module's own
  // constants: an operator greps for the marker verbatim and filters on the
  // level name, and a redactor is free to rewrite any string it is handed — so
  // routing those two slots through it would let a string-rewriting redactor
  // erase the very line that says the fields are gone. The redactor here
  // rewrites EVERY string it sees, which is what makes the two directions
  // distinguishable on one record.
  const sink = collector();
  const redact = (value: unknown): unknown => (typeof value === 'string' ? '[cut]' : value);
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(4), redact });
  const hostile = {
    toJSON(): never {
      throw new Error('reason text that must be scrubbed');
    },
  };

  log.error('graph payload', { hostile });

  assert.deepEqual(sink.records(), [
    {
      level: 'error',
      msg: '[cut]',
      time: 4,
      logError: 'log fields dropped: not JSON-serialisable',
      logErrorDetail: '[cut]',
    },
  ]);
});

test('a cyclic field is neutralised by the redactor before serialisation', () => {
  // Production always injects a redactor, and its deep clone replaces cycles with
  // `[Circular]`, so a self-referential Graph payload is still RENDERED rather
  // than merely survived. Without the redactor the same field degrades to a
  // fields-dropped line (see above): the sink guard keeps the request alive, the
  // redactor is what keeps the content.
  const sink = collector();
  const cyclic: Record<string, unknown> = { name: 'node' };
  cyclic.self = cyclic;
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: fakeClock(2),
    redact: createRedactor(),
  });

  log.info('cycle', { payload: cyclic });

  assert.deepEqual(sink.records()[0], {
    level: 'info',
    msg: 'cycle',
    time: 2,
    payload: { name: 'node', self: '[Circular]' },
  });
});

test('logging does not mutate the caller-supplied fields object', () => {
  // Call sites build the fields object once and reuse it (a per-request context
  // object handed to several log calls). Merging the child bindings INTO that
  // object instead of into a copy would let a binding leak backwards into the
  // caller's own state and into every later record built from it.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(2) });
  const fields: Record<string, unknown> = { k: 'field' };

  log.child({ k: 'binding', extra: 'from-child' }).info('m', fields);

  assert.deepEqual(fields, { k: 'field' });
});

test('time advances with the injected clock', () => {
  const sink = collector();
  const clock = fakeClock(100);
  const log = createLogger({ level: 'debug', stream: sink.stream, clock });

  log.info('t0');
  clock.advance(50);
  log.info('t1');

  const times = sink.records().map((r) => r.time);
  assert.deepEqual(times, [100, 150]);
});

test('fields are optional', () => {
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1) });

  log.debug('no fields');

  assert.deepEqual(sink.records()[0], { level: 'debug', msg: 'no fields', time: 1 });
});

test('with no clock injected the timestamp comes from the system clock', () => {
  // `clock` is optional, and every other test injects one — which leaves the
  // production-shaped call (`createLogger` without a clock in a script) reading a
  // branch nothing exercises. A frozen or constant fallback would make every log
  // line from those entry points carry the same meaningless timestamp.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream });

  const before = Date.now();
  log.info('real clock');
  const after = Date.now();

  const time = sink.records()[0]?.time;
  assert.equal(typeof time, 'number');
  assert.ok(
    typeof time === 'number' && time >= before && time <= after,
    `time ${String(time)} must fall inside [${String(before)}, ${String(after)}]`,
  );
});

test('a clock exposing only now() is enough — the logger never needs sleep()', () => {
  // The option is typed `Pick<Clock, 'now'>` on purpose: the logger has no async
  // path, so demanding a full `Clock` would force every caller (and every test)
  // to build a timer it will never use. This call is what holds that narrower
  // contract in place.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: { now: () => 4242 } });

  log.info('narrow clock');

  assert.equal(sink.records()[0]?.time, 4242);
});

test('the injected clock is called as a method of its own object', () => {
  // `now: clock ? () => clock.now() : ...` keeps the receiver. Handing the method
  // itself across (`clock ? clock.now : ...`) reads identically, and IS identical
  // for the closure-based fake this suite uses everywhere else — which is exactly
  // why it needs its own pin. It breaks the moment a `Clock` keeps its time on the
  // instance, which is what a class-based clock, or one sharing a mutable offset,
  // looks like in an embedder. The damage would not be a wrong timestamp either:
  // the unbound call throws on `this`, the clock guard catches it, and every line
  // for the life of that logger arrives with `time: null` and a broken-clock
  // marker — a working clock reported as broken, on the line an operator reads to
  // find out what is broken.
  const instanceClock = {
    epochMs: 99,
    now(): number {
      return this.epochMs;
    },
  };
  const sink = collector();

  createLogger({ level: 'info', stream: sink.stream, clock: instanceClock }).info('bound');

  assert.deepEqual(sink.records(), [{ level: 'info', msg: 'bound', time: 99 }]);
});

test('an out-of-vocabulary level falls back to info and says so, instead of failing open', () => {
  // TypeScript keeps `level` inside `LogLevel`, and `loadSettings` validates
  // `IG_LOG_LEVEL` against the same list — but the fixture and probe scripts are
  // plain `.mjs` and call `createLogger` untyped. A name outside the table used to
  // yield an undefined threshold, and `weight < undefined` is false, so EVERY
  // record was emitted, `debug` included (CC-PROC-11). `noUncheckedIndexedAccess`
  // cannot see the hole because `LEVEL_WEIGHT` is keyed by the `LogLevel` union
  // rather than by `string`. Failing open in a logger means more output than the
  // operator asked for, and more output means more data — so the fallback is the
  // conservative `info`, and it is announced rather than applied in silence.
  const sink = collector();
  const log = createLogger({
    level: 'verbose' as LogLevel,
    stream: sink.stream,
    clock: fakeClock(1),
  });

  log.debug('d');
  log.info('i');
  log.error('e');

  const records = sink.records();
  assert.deepEqual(records[0], {
    level: 'warn',
    msg: 'invalid log level; falling back',
    time: 1,
    requestedLevel: 'verbose',
    effectiveLevel: 'info',
  });
  assert.deepEqual(
    records.slice(1).map((r) => r.level),
    ['info', 'error'],
    'debug stays filtered — the fallback is a real threshold, not a disabled one',
  );
});

test('a level that is not a string is rejected by the same guard', () => {
  // `Object.hasOwn` coerces any key to a string, so the `typeof` half of the guard
  // is not about membership: it is what makes the predicate a sound type guard and
  // what keeps a pathological key object (a throwing `toString`) out of the
  // lookup. `undefined` is the realistic version — an untyped caller forwarding a
  // config value that was never set.
  const sink = collector();
  const log = createLogger({
    level: undefined as unknown as LogLevel,
    stream: sink.stream,
    clock: fakeClock(2),
  });

  log.debug('d');
  log.warn('w');

  assert.deepEqual(sink.records(), [
    {
      level: 'warn',
      msg: 'invalid log level; falling back',
      time: 2,
      requestedLevel: '[unprintable]',
      effectiveLevel: 'info',
    },
    { level: 'warn', msg: 'w', time: 2 },
  ]);
});

test('a level whose toString throws is rejected before it can be coerced', () => {
  // The other half of the same guard, and the one `undefined` cannot reach.
  // `Object.hasOwn` coerces its key, so without `typeof value === 'string'` the
  // membership test RUNS caller code: a `toString` that throws comes back out of
  // `createLogger` — before a logger exists to report it, on a call site that is
  // usually the first thing a process does. The untyped `.mjs` entry points in
  // `scripts/` are precisely the callers that can hand this module a value the
  // compiler never saw. Rejected, it takes the ordinary fallback path instead,
  // and the announcement carries `[unprintable]` rather than coercing it a second
  // time.
  const hostile = {
    toString(): string {
      throw new Error('level coercion');
    },
  };
  const sink = collector();

  const log = createLogger({
    level: hostile as unknown as LogLevel,
    stream: sink.stream,
    clock: fakeClock(7),
  });
  log.debug('below the fallback');
  log.info('at the fallback');

  assert.deepEqual(sink.records(), [
    {
      level: 'warn',
      msg: 'invalid log level; falling back',
      time: 7,
      requestedLevel: '[unprintable]',
      effectiveLevel: 'info',
    },
    { level: 'info', msg: 'at the fallback', time: 7 },
  ]);
});

test('a near-miss level name is not a level — case and whitespace are not forgiven', () => {
  // The vocabulary check is an exact membership test. `IG_LOG_LEVEL` is already
  // validated case-sensitively in settings, but `createLogger` is a public seam
  // that scripts and embedders call with whatever they were handed, and a
  // lenient match would be worse than a rejection: `'INFO'` accepted as a level
  // would index a weight table that has no such key, and a threshold of
  // `undefined` compares false against everything — every debug record ships,
  // with no announcement that anything is wrong. The announcement echoes the
  // offending spelling exactly, padding and empty string included, so the
  // operator can see WHICH near miss they wrote.
  const nearMisses = ['INFO', 'Info', ' info', 'info ', '', 'debug\n'];

  for (const requested of nearMisses) {
    const sink = collector();
    const log = createLogger({
      level: requested as LogLevel,
      stream: sink.stream,
      clock: fakeClock(11),
    });

    log.debug('d');
    log.info('i');

    assert.deepEqual(
      sink.records(),
      [
        {
          level: 'warn',
          msg: 'invalid log level; falling back',
          time: 11,
          requestedLevel: requested,
          effectiveLevel: 'info',
        },
        { level: 'info', msg: 'i', time: 11 },
      ],
      `level ${JSON.stringify(requested)} must be refused and announced verbatim`,
    );
  }
});

test('a level inside the vocabulary emits no announcement at all', () => {
  // The announcement is a diagnostic, not a banner: a correctly configured logger
  // must write nothing until its first real call, or every process on stdio
  // transport would open with a spurious warning line.
  const sink = collector();
  createLogger({ level: 'error', stream: sink.stream, clock: fakeClock(3) });

  assert.equal(sink.raw(), '');
});

test('each record is exactly one line: no CR, no padding, one trailing newline', () => {
  // Consumers of this stream are line-oriented (`journalctl`, a container log
  // shipper, `grep`). A CRLF terminator or a pretty-printed record turns one
  // record into several partial lines, and every downstream JSON parser sees
  // malformed input instead of the structured record it was promised.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(8) });

  log.info('one', { a: 1 });
  log.info('two', { b: 2 });

  const raw = sink.raw();
  assert.equal(raw.includes('\r'), false, 'no carriage returns');
  assert.equal(raw.split('\n').length, 3, 'exactly two newline-terminated records');
  assert.equal(
    raw,
    '{"level":"info","msg":"one","time":8,"a":1}\n{"level":"info","msg":"two","time":8,"b":2}\n',
  );
});

test('the default sink is stderr — never stdout, which is the MCP channel', () => {
  // Every other test in this file injects a stream, which leaves the ONE line
  // that decides where an unconfigured logger writes completely unexercised. On
  // stdio transport stdout carries framed JSON-RPC: a single log line written
  // there corrupts the frame and the client drops the session. This is the
  // cheapest possible guard on the most expensive possible mistake.
  const stderrWrites: string[] = [];
  const stdoutWrites: string[] = [];
  const realErr = process.stderr.write.bind(process.stderr);
  const realOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrWrites.push(chunk.toString());
    return true;
  };
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutWrites.push(chunk.toString());
    return true;
  };
  try {
    // No `stream` option: this is the production call shape.
    createLogger({ level: 'debug', clock: fakeClock(7) }).warn('default sink probe');
  } finally {
    process.stderr.write = realErr;
    process.stdout.write = realOut;
  }

  assert.deepEqual(stdoutWrites, [], 'nothing may reach the transport channel');
  assert.equal(stderrWrites.length, 1);
  assert.deepEqual(JSON.parse(stderrWrites[0] ?? ''), {
    level: 'warn',
    msg: 'default sink probe',
    time: 7,
  });
});

test('only a missing stream selects the default sink — a falsy one is not swapped out', () => {
  // `opts.stream ?? process.stderr` uses nullish coalescing, so ONLY `undefined`
  // (or `null`) picks the default. That distinction is invisible from TypeScript
  // and very visible from the untyped `.mjs` entry points in `scripts/`, which
  // call `createLogger` with whatever they were handed. Under `||` a bad stream
  // would be silently replaced by the process's own stderr: the caller believes
  // its sink is capturing the records, the records go somewhere else, and the
  // mistake surfaces only as missing logs during an incident. Failing loudly at
  // the first write is the behaviour worth keeping.
  const log = createLogger({
    level: 'debug',
    stream: 0 as unknown as NodeJS.WritableStream,
    clock: fakeClock(0),
  });

  assert.throws(() => {
    log.error('boom');
  }, TypeError);
});

test('the logger owns level/msg/time — a caller field of the same name cannot forge them', () => {
  // The record used to be `{ level, msg, time, ...extra }` with the spread LAST,
  // so a field named `level`/`msg`/`time` replaced the real one (CC-PROC-10).
  // Every log field on the write paths is at least partly Graph- or
  // argument-derived, and no legitimate caller needs to restate its own severity,
  // so the built-ins now win. The colliding value is re-keyed rather than dropped:
  // discarding it would hide information from the same operator the reserved keys
  // exist to protect. Reversing either half of that is a test-visible decision.
  const sink = collector();
  const log = createLogger({ level: 'info', stream: sink.stream, clock: fakeClock(1) });

  log.info('real message', { level: 'audit', msg: 'forged', time: 999, keep: 'me' });

  assert.deepEqual(sink.records()[0], {
    level: 'info',
    msg: 'real message',
    time: 1,
    keep: 'me',
    'fields.level': 'audit',
    'fields.msg': 'forged',
    'fields.time': 999,
  });
});

test('a child binding cannot forge a reserved key either', () => {
  // Bindings and per-call fields land in the same merged object, and a binding is
  // exactly as caller-derived as a field — `child({ tool, requestId })` is built
  // from the request. Shadowing has to hold on both sources or the cheaper one
  // stays open.
  const sink = collector();
  const log = createLogger({ level: 'info', stream: sink.stream, clock: fakeClock(2) });

  log.child({ msg: 'forged by a binding' }).error('real message', { a: 1 });

  assert.deepEqual(sink.records()[0], {
    level: 'error',
    msg: 'real message',
    time: 2,
    a: 1,
    'fields.msg': 'forged by a binding',
  });
});

test('only an exact reserved name is shadowed — a prefix or a case variant keeps its own key', () => {
  // The shadow rule is an exact-set lookup, and the near misses are ordinary
  // field names: `timeout` and `timestamp` start with `time`, `msgId` with
  // `msg`, `levelName` with `level`, `logErrors` with `logError`. A prefix match
  // would silently rename every one of them to `fields.<name>` and break the
  // dashboards and greps keyed on them; a case-folded match would do the same to
  // `Level`/`MSG`/`Time`, which collide with nothing because JSON keys are
  // case-sensitive. The exact names next to them prove the rule still fires.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(8) });

  log.info('m', {
    timeout: 30,
    timestamp: 't',
    msgId: 'm-1',
    levelName: 'l',
    logErrors: 2,
    Level: 'L',
    MSG: 'M',
    Time: 'T',
    msg: 'forged',
    logError: 'forged',
  });

  assert.deepEqual(sink.records(), [
    {
      level: 'info',
      msg: 'm',
      time: 8,
      timeout: 30,
      timestamp: 't',
      msgId: 'm-1',
      levelName: 'l',
      logErrors: 2,
      Level: 'L',
      MSG: 'M',
      Time: 'T',
      'fields.msg': 'forged',
      'fields.logError': 'forged',
    },
  ]);
});

test('a caller field literally named fields.msg shares the shadow slot — a rough edge', () => {
  // The shadow key is a name in the same flat namespace, so a caller supplying
  // BOTH `msg` and `fields.msg` puts two values in one slot and the later key in
  // `Object.entries` order wins. Pinned rather than designed away: no caller in
  // this server does it, both values are caller-supplied either way, and the
  // property that matters — the operator-facing `msg` is not forgeable — still
  // holds. Recorded here so the collapse is a known shape and not a surprise.
  const sink = collector();
  const log = createLogger({ level: 'info', stream: sink.stream, clock: fakeClock(3) });

  log.info('real message', { 'fields.msg': 'first', msg: 'second' });

  assert.deepEqual(sink.records()[0], {
    level: 'info',
    msg: 'real message',
    time: 3,
    'fields.msg': 'second',
  });
});

test('a redactor that throws on the fields object collapses the record instead of failing the caller', () => {
  // The redactor is INJECTED — it is a seam, and what comes through it is
  // somebody else's code. A throwing one used to propagate straight out of
  // `emit` into the tool call that logged the line (CC-PROC-22): the same failure
  // class CC-PROC-12 closed for `JSON.stringify`, reached through a different
  // door. What survives is only what the sink itself knows. Every caller field is
  // dropped, and the assertion is a `deepEqual` rather than a subset check for
  // that reason: a field on this line is by definition a field no redactor ever
  // looked at.
  const sink = collector();
  const secret = 'ig-fake-token-in-a-field';
  const redact = (value: unknown): unknown => {
    if (typeof value === 'object') throw new Error(`cannot clone ${secret}`);
    return value;
  };
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(9), redact });

  assert.doesNotThrow(() => {
    log.info('graph call', { access_token: secret, path: '/me/media' });
  });

  assert.deepEqual(sink.records()[0], {
    level: 'info',
    msg: '[withheld]',
    time: 9,
    logError: 'log record dropped: could not be made safe to write',
    logErrorDetail: 'Error',
  });
  assert.equal(sink.raw().includes(secret), false, 'nothing unredacted may reach the stream');
});

test('a redactor that throws on the message withholds the message rather than writing it raw', () => {
  // The second call site, and the one that is easy to argue out of: `msg` looks
  // like framing next to the fields, so "keep the message, drop the fields" is
  // the tempting degraded record. It is also the wrong one — `msg` goes through
  // the redactor exactly like the fields do, and an interpolated message is
  // precisely where a token turns up (see the message-scrubbing tests above).
  // Here the FIELDS redaction succeeds and only the message redaction throws, so
  // this line fails if the guard ever narrows to the fields call alone.
  const sink = collector();
  const secret = 'EAA0123456789abcdefghijklmnop';
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') throw new Error('string redaction is broken');
    return value;
  };
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(10), redact });

  assert.doesNotThrow(() => {
    log.error(`request failed: https://graph.facebook.com/me?access_token=${secret}`, { a: 1 });
  });

  assert.deepEqual(sink.records()[0], {
    level: 'error',
    msg: '[withheld]',
    time: 10,
    logError: 'log record dropped: could not be made safe to write',
    logErrorDetail: 'Error',
  });
  assert.equal(sink.raw().includes(secret), false, 'the unscrubbed message must not be written');
});

test('a redactor that throws from inside the serialization fallback still cannot fail the caller', () => {
  // The sharp edge of CC-PROC-22, and the reason the guard wraps the whole
  // record-building region instead of the two obvious redactor calls: the
  // CC-PROC-12 fallback SCRUBS its own reason text, so the degraded record is a
  // third way into the redactor and the only one that runs while the record is
  // already broken. This redactor is fine on the fields and fine on the caller's
  // message, and throws only on the engine's failure text — so serialization
  // degrades first and redaction fails second, from inside the `catch`.
  const sink = collector();
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string' && value.includes('BigInt')) throw new RangeError('nested boom');
    return value;
  };
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(11), redact });

  assert.doesNotThrow(() => {
    log.warn('graph payload', { cursor: 9007199254740993n });
  });

  // The redaction failure wins over the serialization one: it is the later, more
  // specific finding, and the fields-dropped record it replaces is the record
  // whose own reason text could not be scrubbed.
  assert.deepEqual(sink.records()[0], {
    level: 'warn',
    msg: '[withheld]',
    time: 11,
    logError: 'log record dropped: could not be made safe to write',
    logErrorDetail: 'RangeError',
  });
});

test('the redaction failure detail names the thrown error and never quotes its message', () => {
  // The asymmetry with the CC-PROC-12 record, pinned so it is not "tidied up"
  // into a shared helper. A redactor throws because it choked on a value, and the
  // idiomatic error message embeds that value — which is the one string on the
  // record that has just been shown to be unredactable. Reporting `error.message`
  // here would publish it in the record written because redaction cannot be
  // trusted, so only the constructor name goes out.
  const sink = collector();
  const secret = 'EAAGm0PX4ZCpsBA' + 'x'.repeat(40);
  const redact = (): unknown => {
    throw new TypeError(`unsupported input: ${secret}`);
  };
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(12), redact });

  log.info('m');

  assert.equal(sink.records()[0]?.logErrorDetail, 'TypeError');
  assert.equal(sink.raw().includes(secret), false, 'the message must not be echoed as the detail');
  assert.equal(sink.raw().includes('unsupported input'), false, 'not even the safe half of it');
});

test('a non-Error thrown by the redactor is reported generically rather than coerced', () => {
  // The same reasoning as the `toJSON` case: an injected function can reject with
  // anything, and coercing an arbitrary rejection is unsafe in its own right
  // (`String(aSymbol)` throws) — which would defeat the guard by throwing from
  // inside it.
  const sink = collector();
  // Held as `unknown` because that is what reaches the catch: no `name`, no
  // prototype the sink can rely on.
  const bareReason: unknown = 'a bare string, not an Error';
  const redact = (): unknown => {
    throw bareReason;
  };
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(13), redact });

  assert.doesNotThrow(() => {
    log.info('m');
  });

  assert.equal(sink.records()[0]?.logErrorDetail, 'unnamed failure: a non-Error value was thrown');
});

test('an error whose name is not a string cannot take the degraded line down a second time', () => {
  // `name` is declared `string` and is an ordinary writable property, so a
  // redactor is free to hand back an error carrying a BigInt name. Reading it
  // straight into the degraded record would make `JSON.stringify` throw inside
  // the one line that exists because something already threw — the exact
  // second-throw shape CC-PROC-12 guards against on `msg` and `time`.
  const sink = collector();
  const misnamed = new Error('boom');
  (misnamed as { name: unknown }).name = 7n;
  const redact = (): unknown => {
    throw misnamed;
  };
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(14), redact });

  assert.doesNotThrow(() => {
    log.error('m', { a: 1 });
  });

  assert.deepEqual(sink.records()[0], {
    level: 'error',
    msg: '[withheld]',
    time: 14,
    logError: 'log record dropped: could not be made safe to write',
    logErrorDetail: '[unprintable]',
  });
});

/**
 * A sink whose `write` always throws `error`, counting the attempts. Used to tell
 * "the logger stopped writing" from "the logger kept paying a throw per line".
 */
function throwingSink(error: unknown): { stream: NodeJS.WritableStream; attempts: () => number } {
  let attempts = 0;
  const stream = {
    write(): boolean {
      attempts += 1;
      throw error;
    },
  };
  return { stream: stream as unknown as NodeJS.WritableStream, attempts: () => attempts };
}

/** A Node-shaped stream error: a real `Error` carrying a string `code`. */
function codedError(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code });
}

test('a sink that has gone away is latched dead instead of failing the request', () => {
  // `stderr` closing under a long-lived server is ordinary — the client walks
  // off, the log shipper restarts — and the write that discovers it is inside a
  // tool call. Re-raising turns one lost log line into a failure of every
  // subsequent request: the server stops working because nobody is listening to
  // its logs. The latch is the second half: without it the dead pipe is
  // rediscovered on every line, at the cost of a throw each time, forever.
  const sink = throwingSink(codedError('EPIPE'));
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1) });

  assert.doesNotThrow(() => {
    log.info('first');
    log.warn('second');
    log.error('third');
  });

  assert.equal(sink.attempts(), 1, 'the sink is attempted once and then left alone');
});

test('every stream-lifecycle code is read as a sink that went away', () => {
  // One membership test decides between "survive" and "fail the request", and the
  // set is spaced far enough apart that dropping a member is invisible to any
  // test that only ever uses EPIPE. Each of these is a way for a sink to end:
  // the peer closed the pipe, the stream was destroyed, it was written after
  // `end()`, or it had already finished. `ERR_STREAM_ALREADY_FINISHED` is here
  // although core raises it from `end()` rather than from `write()` — the option
  // is typed `NodeJS.WritableStream`, so an embedder's custom `_write` may raise
  // it, and its meaning is squarely the survivable one.
  assert.deepEqual(
    [...SINK_GONE_CODES],
    ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_ALREADY_FINISHED'],
    'src/core/log.ts treats a different set of codes as a sink that went away than this file ' +
      'walks. A code added there latches the sink permanently for a condition nothing here ' +
      'ever probes.',
  );
  for (const code of SINK_GONE_CODES) {
    const sink = throwingSink(codedError(code));
    const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1) });

    assert.doesNotThrow(() => {
      log.info('a');
      log.info('b');
    }, `${code} must not fail the request that logged the line`);
    assert.equal(sink.attempts(), 1, `${code} must latch the sink`);
  }
});

test('an error the stream lifecycle does not explain still reaches the caller', () => {
  // The survivable set is a whitelist, not a catch-all. A full disk is not a sink
  // that went away — it is a condition this module has no basis for calling
  // terminal, and one an operator has to hear about. Swallowing everything with a
  // `code` would be the easy mistake and would silently re-open CC-PROC-12's
  // sibling: records vanishing with nobody the wiser.
  const sink = throwingSink(codedError('ENOSPC'));
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1) });

  assert.throws(() => {
    log.error('disk full');
  }, /ENOSPC/);
  // One attempt, not two: the rethrow must leave `emit` outright. If the write
  // were made from inside the redaction guard instead, the stream error would be
  // caught there, degraded into a redaction-failure line, and written AGAIN —
  // turning one failed record into two failed writes on a sink already in
  // trouble, and mislabelling a disk failure as a scrubber failure.
  assert.equal(sink.attempts(), 1, 'a failed write is not retried with a degraded line');
});

test('a non-Error thrown by the sink reaches the caller rather than latching it', () => {
  // A hand-rolled sink that throws a `{ code: 'EPIPE' }` bag has not shown enough
  // to earn the survivable path: `instanceof Error` is what keeps the decision on
  // the ground Node actually stands on, where core throws real errors carrying
  // `code`. Anything looser and any object with the right property could switch
  // the logger off for the life of the process.
  const impostor: unknown = { code: 'EPIPE', message: 'looks like a stream error' };
  const sink = throwingSink(impostor);
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1) });

  assert.throws(
    () => {
      log.error('boom');
    },
    (thrown: unknown) => thrown === impostor,
  );
  assert.equal(sink.attempts(), 1);
});

test('a sink that was never usable fails on every call, not only on the first', () => {
  // The other half of the distinction, and the one the latch could quietly eat. A
  // non-stream in the `stream` option is a misconfiguration: the operator
  // believes its sink is capturing the records and it is not. If the latch fired
  // on ANY write failure, the first call would throw and every later one would
  // return silently — which is exactly the "records go somewhere else" outcome
  // the loud failure exists to prevent.
  const log = createLogger({
    level: 'debug',
    stream: 0 as unknown as NodeJS.WritableStream,
    clock: fakeClock(0),
  });

  assert.throws(() => {
    log.error('first');
  }, TypeError);
  assert.throws(() => {
    log.error('second');
  }, TypeError);
});

test('a child shares the dead-sink latch with its parent, in both directions', () => {
  // A deliberate consequence of the latch living in a mutable cell rather than as
  // a boolean on the state object: `child()` spreads the state, which would COPY
  // a boolean and SHARE an object. The latch describes the SINK — parent and
  // child write to the same file descriptor — so a per-request
  // `child({ requestId })` must inherit the finding instead of rediscovering it
  // with its own throw. Both directions are asserted because both happen: the
  // child created before the discovery, and the parent that outlives the child
  // which made it.
  const sink = throwingSink(codedError('EPIPE'));
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1) });
  const child = log.child({ requestId: 'r1' });

  assert.doesNotThrow(() => {
    child.info('the child discovers the closed pipe');
    log.info('the parent inherits the finding');
    log.child({ tool: 'media_list' }).info('and so does a child created afterwards');
  });

  assert.equal(sink.attempts(), 1);
});

test('one logger going quiet does not silence an unrelated logger', () => {
  // The flip side of sharing: the cell belongs to the SINK, not to the module. A
  // latch hoisted to module scope would pass every test above and take a second
  // server — or the next test in a shared process — down with the first. Two
  // loggers over two streams hold two findings; the test below covers the other
  // half, where two loggers over ONE stream hold one.
  const dead = throwingSink(codedError('EPIPE'));
  createLogger({ level: 'debug', stream: dead.stream, clock: fakeClock(1) }).info('goodbye');

  const alive = collector();
  const log = createLogger({ level: 'debug', stream: alive.stream, clock: fakeClock(2) });
  log.info('still here');

  assert.deepEqual(alive.records(), [{ level: 'info', msg: 'still here', time: 2 }]);
});

test('the redaction-failure line survives a clock that does not return a number', () => {
  // The degraded line's second-throw guard, on the route that has no other test:
  // the CC-PROC-12 record coerces its timestamp because an untyped `.mjs` caller
  // can inject a clock returning anything, and the CC-PROC-22 record is written
  // under exactly the same constraint from a different catch. A raw BigInt in the
  // `time` slot would take `JSON.stringify` down inside the one line that exists
  // because something already threw, and the request would fail after all —
  // through the guard that was added to stop it failing.
  const sink = collector();
  const redact = (): unknown => {
    throw new Error('boom');
  };
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: { now: () => 5n as unknown as number },
    redact,
  });

  assert.doesNotThrow(() => {
    log.info('m', { a: 1 });
  });

  assert.deepEqual(sink.records()[0], {
    level: 'info',
    msg: '[withheld]',
    time: null,
    logError: 'log record dropped: could not be made safe to write',
    logErrorDetail: 'Error',
  });
});

test('two loggers over one stream share the finding — the latch belongs to the sink', () => {
  // The other half of the ownership question, and the one the ASYNCHRONOUS door
  // forced. A stream reports `EPIPE` once, as a single event on the stream
  // itself; a cell created per `createLogger` call cannot be reached from that
  // handler, so the second logger over the same dead pipe would keep writing into
  // it forever. Making the cell belong to the sink object answers both doors with
  // one fact, and it is the truthful reading anyway: two loggers over one
  // `process.stderr` are looking at one pipe.
  const sink = collector();
  const first = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1) });
  const second = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(2) });

  sink.stream.emit('error', codedError('EPIPE'));

  assert.doesNotThrow(() => {
    first.info('a');
    second.info('b');
  });
  assert.equal(sink.raw(), '', 'neither logger keeps writing into a pipe known to be gone');
});

test('an EPIPE that arrives as an event rather than as a throw still latches the sink', () => {
  // How a dead PIPE actually reports itself, and the half a synchronous guard
  // cannot see: `write` returns normally and the `EPIPE` is delivered a tick
  // later as an `'error'` event. With nothing listening, that event is FATAL —
  // measured on Node 22, a child whose stderr pipe is destroyed under it exits
  // with code 1 — which makes this a strictly worse version of the corner case
  // the synchronous latch was opened for: not a failed request, a dead process.
  // `process.stderr` is a pipe under a supervisor, under a log shipper, and under
  // any parent that spawned the server with `stdio: 'pipe'`, which is every stdio
  // MCP client there is.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1) });
  log.info('before the pipe goes');

  sink.stream.emit('error', codedError('EPIPE'));

  assert.doesNotThrow(() => {
    log.info('after the pipe goes');
    log.child({ requestId: 'r1' }).warn('and from a child too');
  });
  assert.deepEqual(sink.records(), [{ level: 'info', msg: 'before the pipe goes', time: 1 }]);
});

test('every stream-lifecycle code is read the same way through the event door', () => {
  // One predicate answers both doors, which is the property worth pinning: a file
  // and a pipe must not end up with two different ideas of what counts as dead,
  // and widening the set must widen both at once.
  for (const code of SINK_GONE_CODES) {
    const sink = collector();
    const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1) });

    sink.stream.emit('error', codedError(code));

    assert.doesNotThrow(() => {
      log.info('a');
    }, `${code} must not fail the request that logged the line`);
    assert.equal(sink.raw(), '', `${code} must latch the sink`);
  }
});

test('an error event the stream lifecycle does not explain is not swallowed', () => {
  // The listener is a classifier, not a mute button. Rethrowing from the handler
  // puts an unrecognised error exactly where it would have gone if this module
  // had never subscribed — Node's uncaught-exception path — which is what makes
  // the subscription honest: what we absorb is the four lifecycle codes, and
  // nothing else. Swallowing everything would turn the logger into the place real
  // faults go to disappear, and it would do it PROCESS-WIDE, because the sink is
  // normally `process.stderr` and the error may be somebody else's.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1) });
  const boom = codedError('ENOSPC');

  assert.throws(
    () => sink.stream.emit('error', boom),
    (thrown: unknown) => thrown === boom,
  );

  // And the sink is not latched either: an error this module cannot explain is
  // not evidence that the sink is gone.
  log.info('still writing');
  assert.deepEqual(sink.records(), [{ level: 'info', msg: 'still writing', time: 1 }]);
});

test('at most one error listener is attached per sink, however many loggers use it', () => {
  // `createLogger` is called per server, per test, and in an embedder per
  // request. An attach on every call earns a `MaxListenersExceededWarning` at ten
  // and, long before that, N handlers racing to latch one cell — a leak in the
  // literal sense on a stream as long-lived as `process.stderr`. Nothing about
  // the OUTPUT would ever show it: the records stay correct while the listener
  // count climbs, which is why the count is asserted directly.
  const sink = collector();
  for (let i = 0; i < 12; i += 1) {
    createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(1) })
      .child({ i })
      .info('x');
  }

  assert.equal(sink.stream.listenerCount('error'), 1, 'one subscription per sink, for its life');
  assert.equal(sink.records().length, 12);
});

test('a sink that cannot be watched is not watched, and still fails loudly', () => {
  // The never-usable sink must not be quietly rescued by the new door either. A
  // non-stream has nothing to subscribe to, and the attempt must not be made:
  // `createLogger` has to construct without throwing (the loud failure belongs at
  // the first WRITE, where the operator can see which record went nowhere), and a
  // primitive would take the sink registry's own `WeakMap` down if it were used
  // as a key.
  let log: ReturnType<typeof createLogger> | undefined;
  assert.doesNotThrow(() => {
    log = createLogger({
      level: 'debug',
      stream: 0 as unknown as NodeJS.WritableStream,
      clock: fakeClock(0),
    });
  });
  assert.throws(() => log?.error('boom'), TypeError);

  // A plain object with a `write` and no `on` is the other shape of unwatchable —
  // an embedder's hand-rolled sink — and it must still work as a sink.
  const bare = {
    lines: [] as string[],
    write(line: string) {
      this.lines.push(line);
      return true;
    },
  };
  createLogger({
    level: 'debug',
    stream: bare as unknown as NodeJS.WritableStream,
    clock: fakeClock(3),
  }).info('hand-rolled');
  assert.deepEqual(bare.lines, ['{"level":"info","msg":"hand-rolled","time":3}\n']);
});

test('a callable sink is not subscribed to, however stream-shaped it looks', () => {
  // `typeof stream === 'object'` is the half of the watchability test that a
  // FUNCTION fails, and a callable is the only value that can tell the two
  // spellings apart: a primitive has no `on` to find, and a `null` was swapped for
  // `process.stderr` by the `??` long before this. Losing it would make the module
  // attach a process-lifetime `'error'` handler — one that silently swallows every
  // EPIPE-class error raised on that object, by this logger or by anything else
  // holding it — to a value it has already judged not to be one of its streams.
  // Writing to it is a different question, and the answer is unchanged: the sink
  // still gets the line.
  const attached: string[] = [];
  const lines: string[] = [];
  const callable = Object.assign(
    (): never => {
      throw new Error('the sink is never called as a function');
    },
    {
      on(event: string): void {
        attached.push(event);
      },
      write(line: string): boolean {
        lines.push(line);
        return true;
      },
    },
  );

  createLogger({
    level: 'debug',
    stream: callable as unknown as NodeJS.WritableStream,
    clock: fakeClock(4),
  }).info('callable');

  assert.deepEqual(attached, [], 'nothing is subscribed to a sink that is not an object');
  assert.deepEqual(lines, ['{"level":"info","msg":"callable","time":4}\n']);
});

test('a clock that throws costs the timestamp, not the record — and never substitutes one', () => {
  // Two shapes were on the table for an injected clock that throws: fall back to
  // `Date.now()`, or write `time: null` and say so. The second wins on the only
  // question the sink gets to influence — what an operator can tell from the line
  // in front of them. A substituted wall clock is INDISTINGUISHABLE from a
  // working injected one: an embedder whose clock is frozen, offset or replayed
  // gets a plausible timestamp from a different clock domain, one that sorts
  // wrong, correlates with nothing, and leaves no evidence in the record that a
  // substitution happened at all. `null` cannot be mistaken for a timestamp and
  // the marker names exactly what was lost. It also keeps the module's one rule:
  // the sink never invents a value it was not given.
  const sink = collector();
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: {
      now: (): number => {
        throw new Error('clock is broken');
      },
    },
    redact: createRedactor(),
  });

  assert.doesNotThrow(() => {
    log.info('m', { a: 1 });
  });

  assert.deepEqual(sink.records(), [
    {
      level: 'info',
      msg: 'm',
      time: null,
      logError: 'log timestamp dropped: the clock threw',
      logErrorDetail: 'Error',
      a: 1,
    },
  ]);
});

test('a broken clock is not filed under a broken record — a pinned boundary', () => {
  // The clock keeps its OWN guard, outside the record-building one, and this is
  // the test that holds them apart. Merged, a broken time source would be
  // reported as a record that could not be made safe: the caller's message and
  // fields withheld although nothing was ever wrong with them, and the one line
  // written to say something is broken naming the wrong component. The previous
  // shape of this test pinned the same boundary from the other side, when a
  // throwing clock still failed the caller outright.
  const sink = collector();
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: {
      now: (): number => {
        throw new TypeError('clock is broken');
      },
    },
  });

  log.info('the caller message survives', { field: 'and so does the field' });

  const record = sink.records()[0] ?? {};
  assert.equal(record.logError, 'log timestamp dropped: the clock threw');
  assert.equal(record.msg, 'the caller message survives');
  assert.equal(record.field, 'and so does the field');
  assert.equal(record.logErrorDetail, 'TypeError');
});

test('a clock failure is announced even when the thrown value has no name to report', () => {
  // The marker is written on `clockFailure !== undefined`, and the distinction
  // that guard draws is not decorative: `failureName` reports `error.name`, and
  // `name` is an ordinary writable property that an embedder's error class is
  // free to leave empty. Testing the detail for TRUTH instead of for PRESENCE
  // therefore drops the whole announcement for exactly the errors that are
  // hardest to identify — the record arrives with `time: null` and nothing at all
  // saying why, which reads as the logger emitting a null timestamp of its own
  // accord. The detail being empty is what this line has to say about the
  // culprit; it is not a reason to stop saying the clock failed.
  const nameless = new Error('clock is broken');
  nameless.name = '';
  const sink = collector();
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: {
      now: (): number => {
        throw nameless;
      },
    },
  });

  log.info('m');

  assert.deepEqual(sink.records(), [
    {
      level: 'info',
      msg: 'm',
      time: null,
      logError: 'log timestamp dropped: the clock threw',
      logErrorDetail: '',
    },
  ]);
});

test('a record that fails after a clock that failed reports the worse of the two', () => {
  // Both guards can fire on one record, and the line has one `logError` slot. The
  // record being gone outranks the timestamp being gone — it is the larger loss
  // and the one that explains why nothing else is on the line — and the null
  // timestamp is still visible, which is the observable half of what the clock
  // did.
  const sink = collector();
  const log = createLogger({
    level: 'debug',
    stream: sink.stream,
    clock: {
      now: (): number => {
        throw new Error('clock is broken');
      },
    },
    redact: () => {
      throw new RangeError('redactor is broken too');
    },
  });

  assert.doesNotThrow(() => {
    log.info('m', { a: 1 });
  });

  assert.deepEqual(sink.records(), [
    {
      level: 'info',
      msg: '[withheld]',
      time: null,
      logError: 'log record dropped: could not be made safe to write',
      logErrorDetail: 'RangeError',
    },
  ]);
});

test('a field whose getter throws is reported as a record that could not be built', () => {
  // The guard around the record-building region covers three doors into somebody
  // else's code, not one: redaction of the fields, redaction of the message, and
  // `Object.entries` running a getter. This is the third, and it is the reason
  // the marker names the OUTCOME instead of the culprit — a line reading
  // "redaction failed" would send an operator after the scrubber for a field that
  // never reached it. The culprit is still reported, accurately and without
  // quoting anything the getter said, as the thrown value's class.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(4) });
  const hostile = {
    get token(): string {
      throw new EvalError('getter refuses');
    },
  };

  assert.doesNotThrow(() => {
    log.info('reading a hostile field', hostile);
  });

  assert.deepEqual(sink.records(), [
    {
      level: 'info',
      msg: '[withheld]',
      time: 4,
      logError: 'log record dropped: could not be made safe to write',
      logErrorDetail: 'EvalError',
    },
  ]);
});

test('a caller field named logError cannot forge the health of a record', () => {
  // `logError` used to appear only in a degraded line built from framing alone,
  // where no caller key can reach. The clock marker put it into an otherwise
  // healthy record, which makes it forgeable — a field named `logError` would sit
  // in the slot an operator greps to find broken records, either inventing a
  // failure that did not happen or masking one that did. It is shadowed like
  // every other reserved-key collision (CC-PROC-10) rather than dropped.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(5) });

  log.info('healthy', { logError: 'nothing is wrong here', logErrorDetail: 'nor here' });

  assert.deepEqual(sink.records(), [
    {
      level: 'info',
      msg: 'healthy',
      time: 5,
      'fields.logError': 'nothing is wrong here',
      'fields.logErrorDetail': 'nor here',
    },
  ]);
});

/**
 * Source for the end-to-end child: a process whose stderr is a real pipe, which
 * the parent then destroys underneath it. It counts ATTEMPTED writes against
 * REQUESTED records, which is how it can tell the latch engaged from the outside
 * — once the sink is latched the logger stops calling `write` at all — and stops
 * as soon as it sees that, so the test costs a few milliseconds rather than the
 * full budget. The bound on the loop is what keeps it from hanging on a platform
 * that never raises `EPIPE` here.
 */
const PIPE_CHILD = `
const { createLogger } = await import(process.env.LOG_MODULE);
let attempted = 0;
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (...args) => {
  attempted += 1;
  return realWrite(...args);
};
const log = createLogger({ level: 'debug' });
process.stdout.write('ready\\n');
let requested = 0;
const timer = setInterval(() => {
  requested += 1;
  log.info('x'.repeat(2000));
  if (attempted < requested || requested >= 200) {
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ latched: attempted < requested, requested }) + '\\n');
  }
}, 5);
`;

test('a stderr pipe that closes under the process does not kill the process', async () => {
  // The unit tests above emit `'error'` by hand, which proves the handler does
  // the right thing but NOT that the handler is reached in the real failure — the
  // asynchronous delivery is the whole point of the defect and a fake cannot
  // demonstrate it. This spawns a child whose stderr is a genuine pipe and
  // destroys the read end while it logs. Before the subscription existed the
  // child died with exit code 1: the logger killed the process it was logging
  // for, which no request-level guard can survive.
  //
  // The load-bearing assertion is the exit code. `latched` additionally shows the
  // classifier ran against an EPIPE raised by Node itself rather than one this
  // suite constructed.
  const child = spawn(process.execPath, ['--input-type=module', '-e', PIPE_CHILD], {
    env: { ...process.env, LOG_MODULE: new URL('../../src/core/log.js', import.meta.url).href },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
    // Destroying the read end is what makes the child's next write EPIPE.
    if (out.includes('ready\n')) child.stderr.destroy();
  });
  child.stderr.on('data', () => {
    // Drained and discarded: nothing the child logs may pollute this suite's own
    // output, and an unread pipe would block the child before it ever fails.
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });

  assert.equal(exitCode, 0, 'a stderr pipe closing must not take the process down with it');
  const summary = JSON.parse(out.split('\n')[1] ?? 'null') as { latched: boolean } | null;
  assert.equal(summary?.latched, true, 'the real EPIPE was classified and the sink was latched');
});
