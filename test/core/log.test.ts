import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { createLogger } from '../../src/core/log.js';
import { createRedactor } from '../../src/core/redact.js';
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
