import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { createLogger } from '../../src/core/log.js';
import { createRedactor } from '../../src/core/redact.js';
import type { LogLevel } from '../../src/core/types.js';
import { fakeClock } from '../helpers/fake-clock.js';

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

test('a field that cannot be serialised throws instead of being silently swallowed', () => {
  // There is no try/catch around the write: a BigInt field (or a throwing
  // `toJSON`) makes `JSON.stringify` throw, and the exception surfaces in the
  // caller's request path. That is the deliberate reading — a swallowed failure
  // would mean a log line the operator believes exists and does not — but it also
  // means a bad field can fail a tool call, so it is pinned as a known trade-off.
  const sink = collector();
  const log = createLogger({ level: 'debug', stream: sink.stream, clock: fakeClock(2) });

  assert.throws(() => {
    log.info('bigint field', { n: 1n });
  }, TypeError);
  assert.equal(sink.raw(), '');
});

test('a cyclic field is neutralised by the redactor before serialisation', () => {
  // Production always injects a redactor, and its deep clone replaces cycles with
  // `[Circular]`. That is what keeps a self-referential Graph payload from turning
  // one log call into a failed request. Without the redactor the same field
  // throws (see above), so this is the guarantee production actually relies on.
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

test('an out-of-vocabulary level name disables the filter entirely', () => {
  // TypeScript keeps `level` inside `LogLevel`, and `loadSettings` validates
  // `IG_LOG_LEVEL` against the same list — but the fixture and probe scripts are
  // plain `.mjs` and call `createLogger` untyped. A name outside the table yields
  // an undefined threshold, and `weight < undefined` is false, so EVERY record is
  // emitted, debug included. Pinned as an undocumented dependency on the callers:
  // failing open here means more output, and more output means more data.
  const sink = collector();
  const log = createLogger({
    level: 'verbose' as LogLevel,
    stream: sink.stream,
    clock: fakeClock(1),
  });

  log.debug('d');
  log.error('e');

  assert.deepEqual(
    sink.records().map((r) => r.level),
    ['debug', 'error'],
  );
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

test('caller fields shadow the reserved record keys — the current, deliberate order', () => {
  // `{ level, msg, time, ...extra }` puts the spread last, so a field (or a child
  // binding) named `level`/`msg`/`time` replaces the real one. Pinned here
  // because nothing else in the suite distinguishes the two spread orders, and
  // an unpinned key order is exactly the kind of thing that flips silently
  // during a refactor and quietly rewrites the audit trail.
  //
  // Worth revisiting: no legitimate caller needs to override its own severity,
  // and every log field on the write paths is at least partly Graph-derived.
  // Reserved-keys-win would be the safer contract. Changing it is a deliberate
  // decision, not a side effect — hence a test that states today's answer.
  const sink = collector();
  const log = createLogger({ level: 'info', stream: sink.stream, clock: fakeClock(1) });

  log.info('real message', { level: 'audit', msg: 'forged', time: 999, keep: 'me' });

  assert.deepEqual(sink.records()[0], {
    level: 'audit',
    msg: 'forged',
    time: 999,
    keep: 'me',
  });
});
