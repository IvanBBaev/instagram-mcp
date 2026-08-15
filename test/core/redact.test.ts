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

test('registering a non-string is a no-op rather than a poisoned registry entry', () => {
  // The signature says `string`, but the callers are config load and the token
  // mint path — both reading values that arrive from an env file or a Graph JSON
  // body, where a compiled-from-JS embedder can hand over anything. A non-string
  // in the registry would be compared with `String(...)` on every redaction and
  // could mask an unrelated substring (`null`, `42`) across every log line.
  for (const bad of [undefined, null, 42, {}, ['a-long-enough-looking-secret']]) {
    registerSecret(bad as string);
  }
  const redact = createRedactor();
  assert.equal(redact('null 42 [object Object] undefined'), 'null 42 [object Object] undefined');
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

// --- Masking mechanics ------------------------------------------------------
//
// The tests above prove that secrets get masked. These prove *how*: the exact
// boundary of what is registrable, and the three ways a partial mask could leave
// a readable secret behind while every assertion above still passes. They are
// last in the file on purpose — each registers a literal into the process-wide
// registry, and running after the property test keeps that registry out of the
// earlier "a short registration is a no-op" assertions.

test('a secret of exactly the minimum length is registered, not rejected', () => {
  // The floor is a `<` comparison, so the shortest accepted secret is the one
  // most likely to be lost to an off-by-one. Nothing in production is this
  // short today, but the boundary is what the constant means.
  registerSecret('s3cr3t-8'); // exactly 8 characters
  registerSecret('s3cr3t7'); // one short — must stay ignored
  const redact = createRedactor();
  assert.equal(redact('token=s3cr3t-8 here'), `token=${REDACTED} here`);
  assert.equal(redact('token=s3cr3t7 here'), 'token=s3cr3t7 here');
});

test('an overlapping pair is masked longest-first, leaving no readable remainder', () => {
  // Real registries hold overlapping values: `refresh` registers the new token
  // while the old one is still registered, and an `appsecret_proof` can appear
  // inside a longer signed URL. Masking the shorter one first splits the longer
  // one in half — the surviving halves are then unmatchable and get written to
  // the log, which is exactly the leak the registry exists to prevent.
  const inner = 'inner-token-abc';
  const outer = `wrapper-${inner}-tail`;
  registerSecret(inner);
  registerSecret(outer);
  const redact = createRedactor();
  assert.equal(redact(`see ${outer} here`), `see ${REDACTED} here`);
  assert.equal(redact(`see ${inner} here`), `see ${REDACTED} here`);
});

test('every occurrence of a secret in one string is masked, not just the first', () => {
  // A retry log line, a URL echoed inside its own error message, a request and
  // its response in one record — a secret repeats constantly. `String.replace`
  // with a string pattern only replaces the first match; the second copy would
  // be written in the clear right next to a `[REDACTED]` that says otherwise.
  const secret = 'repeated-secret-value-9876';
  registerSecret(secret);
  const redact = createRedactor();
  assert.equal(
    redact(`first ${secret} then ${secret} end`),
    `first ${REDACTED} then ${REDACTED} end`,
  );
});

test('the token-shape backstop masks every match in a string, in either hex case', () => {
  // Same repetition problem, one layer down: the shape patterns are the backstop
  // for the mint→register window, so they run on strings nobody has registered
  // anything for. A non-global regex would mask the first token and print the
  // second. And the proof pattern is case-insensitive because a hex digest that
  // came back uppercased from an intermediary is still the same secret.
  const redact = createRedactor();
  const a = 'EAA' + 'Gm0Bak1'.repeat(5);
  const b = 'EAA' + 'Zx9Qw2e'.repeat(5);
  const both = redact(`one ${a} two ${b} end`);
  assert.equal(both, `one ${REDACTED} two ${REDACTED} end`);

  const upperProof = 'ABCDEF0123456789'.repeat(4); // 64 hex chars, uppercase
  assert.equal(upperProof.length, 64);
  assert.equal(redact(`proof is ${upperProof} ok`), `proof is ${REDACTED} ok`);
});

test('a node reachable twice is redacted twice, not reported as a cycle', () => {
  // The cycle guard tracks the path being walked, not every node ever seen, so
  // it has to unwind on the way out. Without that, the second reference to a
  // shared node renders as `[Circular]` — a log record that silently drops real
  // fields, and the failure only appears for object graphs that share a node,
  // which is what a Graph response with a repeated paging cursor looks like.
  const secret = 'shared-node-secret-value-4321';
  registerSecret(secret);
  const redact = createRedactor();
  const shared = { token: secret, kind: 'page' };
  const out = redact({ a: shared, b: shared, list: [shared, shared] }) as Record<string, any>;

  assert.deepEqual(out.a, { token: REDACTED, kind: 'page' });
  assert.deepEqual(out.b, { token: REDACTED, kind: 'page' }, 'the second reference is not a cycle');
  assert.deepEqual(out.list, [
    { token: REDACTED, kind: 'page' },
    { token: REDACTED, kind: 'page' },
  ]);
  // Still a deep copy: the two outputs are separate objects, not the shared input.
  assert.notEqual(out.a, shared);
  assert.notEqual(out.a, out.b);
});
