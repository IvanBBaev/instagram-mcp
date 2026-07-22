import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createRedactor, registerSecret, REDACTED } from '../../src/core/redact.js';

test('masks the value of secret-named keys (case-insensitive, substring, nested)', () => {
  const redact = createRedactor();
  const input = {
    access_token: 'plain-value-under-a-secret-key',
    Authorization: 'Bearer abcdef',
    appsecret_proof: 'deadbeef',
    app_secret: 'shhh',
    client_secret: 'nope',
    'X-Authorization-Header': 'zzz',
    keep: 'visible',
    headers: { authorization: 'Bearer nested' },
  };
  const out = redact(input) as Record<string, any>;
  assert.equal(out.access_token, REDACTED);
  assert.equal(out.Authorization, REDACTED);
  assert.equal(out.appsecret_proof, REDACTED);
  assert.equal(out.app_secret, REDACTED);
  assert.equal(out.client_secret, REDACTED);
  assert.equal(out['X-Authorization-Header'], REDACTED);
  assert.equal(out.keep, 'visible');
  assert.equal(out.headers.authorization, REDACTED);
});

test('a secret-named key with a null/undefined value is left as-is', () => {
  const redact = createRedactor();
  const out = redact({ access_token: null, app_secret: undefined }) as Record<string, unknown>;
  assert.equal(out.access_token, null);
  assert.ok('app_secret' in out);
  assert.equal(out.app_secret, undefined);
});

test('masks a registered secret wherever it appears inside larger strings', () => {
  const secret = 'super-long-registered-secret-0xABCDEF';
  registerSecret(secret);
  const redact = createRedactor();
  const out = redact({
    note: `prefix ${secret} suffix`,
    list: ['a', `${secret}!`, 'b'],
  }) as Record<string, any>;
  assert.equal(out.note, `prefix ${REDACTED} suffix`);
  assert.ok(!out.note.includes(secret));
  assert.ok(!out.list[1].includes(secret));
  assert.equal(out.list[0], 'a');
  assert.equal(out.list[2], 'b');
});

test('a redactor created before registration still masks a later-registered secret (F-4)', () => {
  const redact = createRedactor();
  const minted = 'runtime-minted-token-9f8e7d6c5b4a3';
  assert.equal(redact(minted), minted); // not yet registered
  registerSecret(minted);
  assert.equal(redact(minted), REDACTED); // now masked, same redactor
});

test('masks token-shaped values in free strings even when unregistered', () => {
  const redact = createRedactor();
  const fbToken = 'EAA' + 'Gm0Bak' + 'Z'.repeat(60);
  const igToken = 'IGQ' + 'VjZ-Ab_9'.repeat(10);
  const proof = 'a'.repeat(64);
  const out = redact({
    fb: `token=${fbToken}`,
    ig: igToken,
    proof: `proof is ${proof} ok`,
    ignore: 'IGNORE this short word',
  }) as Record<string, any>;
  assert.ok(!out.fb.includes(fbToken));
  assert.ok(out.fb.includes(REDACTED));
  assert.equal(out.ig, REDACTED);
  assert.equal(out.proof, `proof is ${REDACTED} ok`);
  assert.ok(!out.proof.includes(proof));
  assert.equal(out.ignore, 'IGNORE this short word'); // short IG-prefixed word not masked
});

test('never mutates the input; returns a deep copy', () => {
  const secret = 'another-registered-secret-value-1234567';
  registerSecret(secret);
  const redact = createRedactor();
  const input = { a: secret, b: { c: [secret, 'x'] } };
  const snapshot = structuredClone(input);
  const out = redact(input) as any;
  // original object graph untouched
  assert.deepEqual(input, snapshot);
  // result is a fresh, independent object graph
  assert.notEqual(out, input);
  assert.notEqual(out.b, input.b);
  assert.notEqual(out.b.c, input.b.c);
  // and it is redacted
  assert.equal(out.a, REDACTED);
  assert.equal(out.b.c[0], REDACTED);
  assert.equal(out.b.c[1], 'x');
});

test("registering '' or a short string is a no-op (does not mask everything)", () => {
  registerSecret('');
  registerSecret('abcde'); // shorter than the minimum registration length
  const redact = createRedactor();
  assert.equal(redact('literally anything at all'), 'literally anything at all');
  assert.equal(redact('abcde'), 'abcde');
  const out = redact({ x: 'hello world', y: 'abcde' }) as Record<string, unknown>;
  assert.equal(out.x, 'hello world');
  assert.equal(out.y, 'abcde');
});

test('passes non-string primitives through and honors extraSecrets', () => {
  const redact = createRedactor({ extraSecrets: ['scoped-extra-secret-value-xyz'] });
  assert.equal(redact(42), 42);
  assert.equal(redact(true), true);
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  const out = redact({ n: 1, b: false, s: 'has scoped-extra-secret-value-xyz here' }) as Record<
    string,
    any
  >;
  assert.equal(out.n, 1);
  assert.equal(out.b, false);
  assert.ok(!out.s.includes('scoped-extra-secret-value-xyz'));
  assert.ok(out.s.includes(REDACTED));
});

test('guards against reference cycles instead of overflowing the stack', () => {
  const redact = createRedactor();
  const cyclic: Record<string, unknown> = { name: 'root' };
  cyclic.self = cyclic;
  const out = redact(cyclic) as Record<string, unknown>;
  assert.equal(out.name, 'root');
  assert.equal(out.self, '[Circular]');
});

const alnum = fc
  .array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
    { minLength: 12, maxLength: 40 },
  )
  .map((chars) => chars.join(''));

test('property: a registered secret never survives redaction, and input never mutates', () => {
  fc.assert(
    fc.property(alnum, fc.string(), (secret, filler) => {
      registerSecret(secret);
      const redact = createRedactor();
      const input = {
        secret,
        wrapped: `head-${secret}-tail`,
        nested: { deep: [secret, filler] },
      };
      const snapshot = structuredClone(input);
      const out = redact(input);
      assert.deepEqual(input, snapshot); // no mutation of the original
      assert.ok(!JSON.stringify(out).includes(secret)); // secret fully masked
    }),
    { numRuns: 200 },
  );
});
