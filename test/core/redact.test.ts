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

// --- The marker itself ------------------------------------------------------

test("the redaction marker is the literal '[REDACTED]'", () => {
  // Every other test in this file compares against the exported constant, so a
  // change to the constant moves both sides of the assertion and stays invisible.
  // The literal is a published interface: `docs/security.md` tells operators to
  // grep logs for it, the fixture sanitizer asserts on it, and an empty or
  // whitespace marker would silently *delete* the field instead of marking it —
  // making a leak and a successful mask indistinguishable in an audit.
  assert.equal(REDACTED, '[REDACTED]');
  const redact = createRedactor();
  const out = redact({ access_token: 'plain' }) as Record<string, unknown>;
  assert.equal(out.access_token, '[REDACTED]');
  assert.equal(redact('EAA' + 'q'.repeat(30)), '[REDACTED]');
});

// --- Secret-key matching ----------------------------------------------------

test('a secret-named key matches as a substring, not as a prefix or a whole word', () => {
  // `page_access_token` is a real Graph field — it is what `/me/accounts` returns
  // for every page, and it carries a usable token. Anchoring the pattern to the
  // start of the key, or wrapping the alternatives in word boundaries, would let
  // every one of those through in the clear while the plain `access_token` case
  // kept passing, so the regression would look green.
  const redact = createRedactor();
  const out = redact({
    page_access_token: 'plain-page-token',
    user_access_token: 'plain-user-token',
    proxy_authorization: 'Basic plain',
  }) as Record<string, unknown>;
  assert.equal(out.page_access_token, REDACTED);
  assert.equal(out.user_access_token, REDACTED);
  assert.equal(out.proxy_authorization, REDACTED);

  // FINDING, pinned deliberately: the vocabulary is spelled with underscores
  // only, so the hyphenated header spellings are *not* matched. Graph takes these
  // as underscore query parameters and as a bare `Authorization` header, so the
  // gap is not reachable from this server's own request builder today — but any
  // object handed to the logger or the write journal by a caller can carry them.
  const hyphenated = redact({ 'x-ig-app-secret': 'plain-app-secret' }) as Record<string, unknown>;
  assert.equal(hyphenated['x-ig-app-secret'], 'plain-app-secret');
});

test('ordinary identifying fields are not swept into the secret-key pattern', () => {
  // Over-redaction is preferred to under-redaction, but not at any price: the
  // discovery and insights tools log `username`, `id` and `permalink`, and those
  // are how an operator correlates a log line with an account. Widening the key
  // vocabulary to catch one more secret-ish name blanks out the diagnostic value
  // of every record at once, and nothing in this file would notice.
  const redact = createRedactor();
  const out = redact({
    username: 'coffeeshop',
    id: '17841400000000000',
    permalink: 'https://www.instagram.com/p/ABCdefGHI/',
    caption: 'morning brew',
  }) as Record<string, unknown>;
  assert.equal(out.username, 'coffeeshop');
  assert.equal(out.id, '17841400000000000');
  assert.equal(out.permalink, 'https://www.instagram.com/p/ABCdefGHI/');
  assert.equal(out.caption, 'morning brew');
});

test('key matching is ASCII case-insensitivity, not Unicode case folding', () => {
  // FINDING, pinned deliberately: the key test is `/…/i.test(key)`, which folds
  // ASCII only. A key spelled with U+212A KELVIN SIGN lowercases to `k` but does
  // not match `k` under the `i` flag, so `access_to<U+212A>en` reaches the log with
  // its value in the clear. Nothing in the server produces such a key today —
  // but keys come from Graph JSON bodies and from tool arguments, both attacker-
  // influenced, so this is an undocumented dependency rather than a safe one.
  // Pre-lowercasing the key would close it; this test exists so that change is a
  // deliberate one and not an accident.
  const redact = createRedactor();
  const homoglyph = 'access_to\u212Aen'; // U+212A KELVIN SIGN in place of `k`
  const out = redact({ [homoglyph]: 'plain-value' }) as Record<string, unknown>;
  assert.equal(out[homoglyph], 'plain-value');
  // The ordinary ASCII spelling in any casing is still masked.
  const ascii = redact({ ACCESS_TOKEN: 'plain-value' }) as Record<string, unknown>;
  assert.equal(ascii.ACCESS_TOKEN, REDACTED);
});

test('a secret-named key masks non-string values wholesale', () => {
  // The key is the evidence, not the value's type. Graph and our own tool results
  // put tokens in shapes that are not bare strings — `{ access_token, expires_in }`
  // under an `authorization` key, a list of header values, a numeric client id.
  // Narrowing the mask to string values would walk into those instead, and the
  // walk only masks what it *recognises*: an unregistered, non-token-shaped value
  // nested under `client_secret` would come back out in full.
  const redact = createRedactor();
  const out = redact({
    access_token: 12345,
    client_secret: { rotated: true, value: 'plain-nested' },
    authorization: ['Basic plain-one', 'Basic plain-two'],
    app_secret: false,
  }) as Record<string, unknown>;
  assert.equal(out.access_token, REDACTED);
  assert.equal(out.client_secret, REDACTED);
  assert.equal(out.authorization, REDACTED);
  assert.equal(out.app_secret, REDACTED);
});

// --- Shape backstop: the Facebook token pattern -----------------------------

test('the FB token backstop keys on the exact, case-sensitive prefix EAA', () => {
  // The prefix is the whole of the backstop's precision. Dropping a character
  // (`EA`) or adding the `i` flag turns it into a match for ordinary base64url
  // payload — media ids, signed URLs, cursors — and the redactor would start
  // eating the fields operators debug with. Both mutations still pass every
  // "a real token is masked" assertion in this file.
  const redact = createRedactor();
  const lower = 'eaa' + 'x'.repeat(30);
  const nearMiss = 'EAB' + 'x'.repeat(30);
  assert.equal(redact(lower), lower);
  assert.equal(redact(nearMiss), nearMiss);
});

test('the FB token backstop takes at least 20 characters after the prefix', () => {
  // The floor is what keeps `EAA`-prefixed prose out of the mask. One character
  // either way is invisible to every realistic token (they run to hundreds of
  // characters) but decides whether short `EAA…` identifiers survive, and a `+`
  // quantifier would mask the four-character string `EAAB`.
  const redact = createRedactor();
  const atFloor = 'EAA' + 'x'.repeat(20);
  const belowFloor = 'EAA' + 'x'.repeat(19);
  assert.equal(redact(atFloor), REDACTED);
  assert.equal(redact(belowFloor), belowFloor);
  assert.equal(redact('EAAB'), 'EAAB');
});

test('the FB token backstop runs through `-` and `_` to the end of the token', () => {
  // Graph tokens are base64url, so `-` and `_` appear inside them routinely.
  // Dropping either from the character class does not stop the match — it
  // *truncates* it, masking the head and printing the tail. A partial token next
  // to a `[REDACTED]` that claims the line is safe is the worst possible outcome:
  // the log looks redacted and still carries recoverable material.
  const redact = createRedactor();
  const withDash = 'EAA' + 'a'.repeat(20) + '-' + 'b'.repeat(20);
  const withUnderscore = 'EAA' + 'a'.repeat(20) + '_' + 'b'.repeat(20);
  assert.equal(redact(withDash), REDACTED);
  assert.equal(redact(withUnderscore), REDACTED);
});

test('the FB token alphabet stops at `.`, which is where a token ends and context begins', () => {
  // The character class is the *whole* definition of where a token ends, and it
  // has to be exactly base64url. `.` is the one character that most often sits
  // immediately after a token in real text, so admitting it is the mutation that
  // costs the most. This one over-redacts rather than leaking, and the damage is
  // to the artifact rather than to the secret:
  //
  //  - A dotted identifier that merely starts with `EAA` — a metric name, a class
  //    or module path, a hostname — is under the 20-character floor on its own but
  //    clears it once the dots and everything after them count. `registry.ts` runs
  //    this redactor over every tool result and `write-mode.ts` over every journal
  //    entry, so whole non-secret fields start disappearing from the audit trail.
  //  - Worse, the mask stops marking where the secret ended. A real token followed
  //    by `.` and the host it was sent to comes back as a bare `[REDACTED]` with
  //    the host eaten, so a `doctor` report or a log line can no longer answer
  //    *which* call carried the token — and an auditor reading `[REDACTED]` cannot
  //    tell whether one secret or a paragraph of context was removed.
  const redact = createRedactor();
  const dottedIdentifier = 'EAA-CACHE.metrics.counter.total.value';
  assert.equal(redact(dottedIdentifier), dottedIdentifier);
  assert.equal(redact('EAA' + 'x'.repeat(10) + '.' + 'y'.repeat(10)), 'EAAxxxxxxxxxx.yyyyyyyyyy');
  // A genuine token is still masked, and the mask ends exactly where the token does.
  assert.equal(
    redact('EAA' + 'x'.repeat(25) + '.example.internal'),
    `${REDACTED}.example.internal`,
  );
});

test('the shape backstops have no left word boundary, so a glued token is still masked', () => {
  // Tokens do not arrive politely delimited. They turn up percent-encoded inside
  // a `state` parameter, concatenated into cache and dedup keys, and spliced into
  // error text by upstream libraries — in every one of those the character before
  // the prefix is a word character, so a leading `\b` would refuse to match and
  // the token would be logged whole.
  const redact = createRedactor();
  assert.equal(redact('state%22EAA' + 'x'.repeat(25)), 'state%22' + REDACTED);
  assert.equal(redact('cursor7IG' + 'y'.repeat(25)), 'cursor7' + REDACTED);
});

// --- Shape backstop: the Instagram token pattern ----------------------------

test('every IG token in a string is masked, anywhere in it', () => {
  // This is the `/g` flag and the absence of `^`/`$` in one assertion. A log line
  // routinely carries two tokens (the request URL and the error echoing it back);
  // without `/g` the second is printed in the clear. Anchoring the pattern would
  // limit the backstop to strings that are *nothing but* a token, which is the
  // one case the exact registry already covers.
  const redact = createRedactor();
  const first = 'IG' + 'a'.repeat(25);
  const second = 'IG' + 'b'.repeat(25);
  assert.equal(
    redact(`start=${first}&next=${second}&end`),
    `start=${REDACTED}&next=${REDACTED}&end`,
  );
});

test('the IG backstop keys on the exact, case-sensitive prefix IG', () => {
  // `IGQ…` is the common shape, but `IGAA…` is minted too, so the prefix cannot
  // be tightened past `IG`. It cannot be loosened either: a single `I` plus 20
  // characters matches ordinary uppercase identifiers, and the `i` flag makes it
  // match any lowercase word — either turns the backstop into a censor.
  const redact = createRedactor();
  const lower = 'ig' + 'x'.repeat(30);
  const otherFamily = 'IGAA' + 'x'.repeat(25);
  const constantName = 'IN' + 'X'.repeat(25);
  assert.equal(redact(lower), lower);
  assert.equal(redact(otherFamily), REDACTED);
  assert.equal(redact(constantName), constantName);
});

test('the IG backstop takes at least 20 characters after the prefix', () => {
  const redact = createRedactor();
  const atFloor = 'IG' + 'x'.repeat(20);
  const belowFloor = 'IG' + 'x'.repeat(19);
  assert.equal(redact(atFloor), REDACTED);
  assert.equal(redact(belowFloor), belowFloor);
});

// --- Shape backstop: the appsecret_proof pattern ----------------------------

test('every appsecret_proof in a string is masked', () => {
  // A retried signed request logs the proof once per attempt; a non-global regex
  // masks the first and prints the rest. The proof is derived from the app secret
  // and is replayable for the lifetime of the token it accompanies.
  const redact = createRedactor();
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  assert.equal(redact(`one ${first} two ${second}`), `one ${REDACTED} two ${REDACTED}`);
});

test('the proof pattern is exactly 64 hex characters, standing alone', () => {
  // FINDING, pinned deliberately: the `\b`-bounded `{64}` means a proof that is
  // *concatenated* into a longer hex run (two digests back to back, a proof glued
  // to a hex request id) is not masked at all — the run below is 128 hex
  // characters and comes back untouched. The bounds are load-bearing in the other
  // direction too: relaxing `{64}` to `{32,}` starts masking ordinary 32-hex
  // media checksums and ids, and widening the alphabet to `[a-z0-9]` masks any
  // 64-character lowercase slug. Dropping either `\b` would mask *part* of a long
  // run, which is worse than leaving it — it hides that the run was ever there.
  const redact = createRedactor();
  const longRun = 'b'.repeat(128);
  const shortRun = 'c'.repeat(32);
  const notHex = 'z' + 'a'.repeat(63);
  assert.equal(longRun.length, 128);
  assert.equal(notHex.length, 64);
  assert.equal(redact(longRun), longRun);
  assert.equal(redact(shortRun), shortRun);
  assert.equal(redact(notHex), notHex);
});

test('the shape patterns run token-first, so masking one creates the boundary the next needs', () => {
  // The three patterns are applied in order over the *output* of the previous
  // one, and that order is not decorative. A 64-hex proof immediately followed by
  // an `EAA…` token is one unbroken word run: the proof pattern cannot match it,
  // because it needs a word boundary at character 64. Masking the token first
  // inserts `[REDACTED]`, which *creates* that boundary, and the proof is then
  // caught. Run the proof pattern first and the proof is written out in full.
  const redact = createRedactor();
  const proof = 'a'.repeat(64);
  const token = 'EAA' + 'z'.repeat(25);
  const out = redact(proof + token);
  assert.equal(out, `${REDACTED}${REDACTED}`);
  assert.equal(typeof out === 'string' && out.includes(proof), false);
});

// --- Registration and the exact-value pass ----------------------------------

test('a registered secret is stored and matched byte for byte, without trimming', () => {
  // Secrets reach `registerSecret` straight out of an env var or a JSON body and
  // can carry surrounding whitespace. The value that will appear in a log line is
  // the value the caller holds, padding included, so the registry stores exactly
  // what it was handed: measuring the length after a trim would silently reject a
  // padded short value, and storing the trimmed copy would mask only its middle
  // and leave the padding as a visible fingerprint of the original.
  registerSecret('  abc123  '); // ten characters raw, six after trimming
  const redact = createRedactor();
  assert.equal(redact('v=  abc123  ;'), `v=${REDACTED};`);
});

test('an extra secret of exactly the minimum length is kept, and a short one is dropped', () => {
  // `doctor` builds its redactor from `[profile.accessToken, profile.appSecret]`
  // with no length filter of its own, so both ends of this boundary are live: an
  // off-by-one drops a real (if short) app secret from the report's redactor,
  // while removing the filter altogether registers whatever short junk a profile
  // holds and blanks out unrelated text everywhere it happens to occur.
  const redact = createRedactor({ extraSecrets: ['s3cr3t-9', 'ab'] });
  assert.equal(redact('ab s3cr3t-9 ab'), `ab ${REDACTED} ab`);
});

test('extra secrets are matched with the casing they were registered with', () => {
  // Tokens are case-sensitive. Normalising a registered secret to lower case
  // means the exact-value pass looks for a string that never appears in the log,
  // so the primary mechanism (F-4) quietly stops working and only the shape
  // backstop is left — and the backstop does not cover app secrets at all.
  const redact = createRedactor({ extraSecrets: ['MixedCaseSecret123'] });
  assert.equal(redact('v=MixedCaseSecret123'), `v=${REDACTED}`);
});

test('a non-iterable extraSecrets fails loudly instead of silently redacting nothing', () => {
  // `??` and `||` differ for exactly one class of input: a value that is present
  // but falsy. `createRedactor` is called from `doctor` and from the MCP registry
  // with values assembled at runtime, and a compiled-from-JS embedder can hand
  // over anything. Under `||` a bad `extraSecrets` is replaced by `[]` and the
  // redactor is built with no scoped secrets at all — the doctor report would
  // then print the operator's token with nothing raising a hand.
  assert.throws(() => createRedactor({ extraSecrets: 0 as unknown as string[] }), TypeError);
  // The nullish cases stay silent, which is what `??` is actually there for.
  assert.doesNotThrow(() => createRedactor({}));
  assert.doesNotThrow(() => createRedactor({ extraSecrets: undefined }));
});

test('two different secrets in one string are both masked', () => {
  // The loop accumulates: each round must mask into the *result* of the previous
  // round, not into the original input. Restarting from the input makes the last
  // secret processed the only one masked and silently un-masks the earlier ones.
  // One log line holding both an access token and an app secret is the norm, not
  // the exception — a signed request URL carries both.
  const redact = createRedactor({
    extraSecrets: ['first-secret-value-11', 'second-secret-value-22'],
  });
  assert.equal(
    redact('a=first-secret-value-11&b=second-secret-value-22'),
    `a=${REDACTED}&b=${REDACTED}`,
  );
});

test('each secret is looked for in the partially-masked text, not in the original input', () => {
  // Same accumulator, one step subtler: the marker is spliced *into* the text, so
  // a registered secret can straddle it and exist only in the partially-masked
  // string. Testing the original input for presence skips that secret entirely.
  // The registry holds values the operator handed us and we do not get to assume
  // none of them overlaps the marker.
  const redact = createRedactor({ extraSecrets: ['LONGSECRETVALUE1', 'XY[REDACT'] });
  const out = redact('XYLONGSECRETVALUE1');
  assert.equal(typeof out, 'string');
  assert.equal(typeof out === 'string' && out.includes('LONGSECRETVALUE1'), false);
  assert.equal(typeof out === 'string' && out.startsWith('XY'), false);
});

test('registered exact values are masked before the shape backstop runs', () => {
  // F-4 makes the exact registry the primary mechanism and the shapes a backstop,
  // and the order encodes that. A registered value that merely *contains* an
  // `EAA…` run — a signed URL, a `Bearer`-prefixed header value, a token with a
  // key id glued in front — is masked as one unit only if the exact pass goes
  // first. Let the shape pass go first and it carves the middle out, leaving the
  // registered prefix readable and the exact pass with nothing left to match.
  const registered = 'sig-AAAEAA' + 'x'.repeat(25);
  const redact = createRedactor({ extraSecrets: [registered] });
  assert.equal(redact(`v=${registered}`), `v=${REDACTED}`);
});

test('on a length tie the globally registered secret is masked first', () => {
  // The merge order decides which of two equal-length overlapping secrets wins,
  // and the global registry goes first on purpose: it is populated at startup
  // from the profile and from `IG_HTTP_TOKEN`, so it holds the long-lived
  // credentials. Per-call extras are derived, shorter-lived values. Flipping the
  // order would let a derived value split the profile token and leave a readable
  // head behind.
  registerSecret('ABCDEFGH12');
  const redact = createRedactor({ extraSecrets: ['FGH12XYZQR'] });
  assert.equal(redact('v=ABCDEFGH12XYZQR;'), `v=${REDACTED}XYZQR;`);
});

// --- Traversal ---------------------------------------------------------------

test('a function value is passed through by reference, not flattened to an empty object', () => {
  // FINDING, pinned deliberately: functions are treated as primitives. They are
  // neither walked nor copied, so a callback in a log field keeps its identity —
  // and its closure and source text, neither of which is ever scanned for
  // secrets. Walking them instead would collapse every function to `{}` (a
  // function has no own enumerable properties), destroying the reference the
  // caller can still use. The current behaviour is the useful one; this test
  // makes it a decision.
  const redact = createRedactor();
  const fn = (): string => 'x';
  const out = redact(fn);
  assert.equal(typeof out, 'function');
  assert.equal(out, fn);
});

test('a cycle that runs through an array is detected, not followed forever', () => {
  // The cycle guard has to be one set threaded through the whole walk. Handing
  // arrays a fresh set makes any cycle whose path crosses an array invisible, and
  // the redactor recurses until the stack dies. `log.ts` does not wrap `emit` in
  // a try/catch, so that throw takes down the caller — the redactor becomes a
  // denial of service triggered by a self-referential object graph.
  const redact = createRedactor();
  const root: Record<string, unknown> = { name: 'root' };
  root.items = [root];
  const out = redact(root) as Record<string, unknown>;
  assert.equal(out.name, 'root');
  assert.deepEqual(out.items, ['[Circular]']);
});

test('the cycle guard is scoped to a single top-level call', () => {
  // The guard is created inside the returned closure, once per redaction, so two
  // redactions of the same object are independent. Hoisting it to the redactor
  // would make a lazily-computed field that itself redacts see the object as
  // already-visited and report `[Circular]` for a record that has no cycle at
  // all — a silently truncated log line rather than a loud failure.
  const redact = createRedactor();
  const root: Record<string, unknown> = { name: 'root' };
  let depth = 0;
  Object.defineProperty(root, 'lazy', {
    enumerable: true,
    get(): unknown {
      depth += 1;
      return depth > 2 ? 'stop' : redact(root);
    },
  });
  const out = redact(root) as Record<string, unknown>;
  assert.notEqual(out.lazy, '[Circular]');
  assert.equal(typeof out.lazy, 'object');
  assert.equal(depth, 3);
});

test('key insertion order is preserved', () => {
  // The output is what gets JSON-serialised into the log stream and into the
  // write journal, and both are diffed byte for byte — by the fixture harness in
  // this repo and by whatever the operator greps with. Reordering keys turns
  // every redacted record into a spurious diff and makes the journal unstable
  // across versions for no behavioural reason.
  const redact = createRedactor();
  const out = redact({ alpha: 1, beta: 2, gamma: 3 }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ['alpha', 'beta', 'gamma']);
});

test('only own enumerable properties are copied out', () => {
  // `Object.entries` is the same own-enumerable rule `JSON.stringify` uses, so
  // redaction never *widens* a record: what the log would have shown without the
  // redactor is exactly what it shows with it, minus the secrets. Switching to
  // `getOwnPropertyNames` would start surfacing hidden state that the logger was
  // never going to print — including whatever a library stashed on a
  // non-enumerable property — and each newly surfaced field is a fresh chance to
  // publish something nobody reviewed.
  const redact = createRedactor();
  const input: Record<string, unknown> = { visible: 'ok' };
  Object.defineProperty(input, 'hidden', { value: 'plain-hidden-value', enumerable: false });
  const out = redact(input) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ['visible']);
  assert.equal('hidden' in out, false);
});
