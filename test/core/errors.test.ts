import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstagramError, isInstagramError } from '../../src/core/types.js';
import type { GraphErrorBody } from '../../src/core/types.js';
import {
  mapGraphError,
  MAX_GRAPH_MESSAGE_LENGTH,
  quoteGraphId,
  quoteGraphText,
  toInstagramError,
} from '../../src/core/errors.js';
import { createRedactor, REDACTED } from '../../src/core/redact.js';

/** Build a Graph error envelope with the given `error` fields. */
function envelope(error: Partial<GraphErrorBody['error']>): GraphErrorBody {
  return { error: { message: 'default message', ...error } };
}

/** An `Error` whose message and name are both blank — the bottom of the chain. */
function blankError(message: string, name: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

// --- mapGraphError: code -> kind (docs/operations.md §3) --------------------

test('code 190 -> auth, with status/code/subcode/message populated', () => {
  const err = mapGraphError(
    401,
    envelope({
      message: 'Error validating access token: Session has expired.',
      code: 190,
      error_subcode: 463,
      fbtrace_id: 'Abc123Trace',
    }),
  );
  assert.ok(err instanceof InstagramError);
  assert.equal(err.kind, 'auth');
  assert.equal(err.status, 401);
  assert.equal(err.code, 190);
  assert.equal(err.subcode, 463);
  assert.equal(err.fbtraceId, 'Abc123Trace');
  assert.equal(err.message, 'Error validating access token: Session has expired.');
});

test('a code or subcode that is not a number is dropped, never coerced — "190" is not 190', () => {
  // The Graph contract types `code` and `error_subcode` as numbers, and the
  // taxonomy ladder keys on them. A numeric string, a one-element array (which
  // `Number()` happily reads as 190) or a boolean is a malformed envelope, not a
  // session-expired signal: the classification falls through to the HTTP status
  // and the typed fields stay absent rather than carrying a coerced value.
  const cases: Array<Record<string, unknown>> = [
    { code: '190', error_subcode: '2207008' },
    { code: [190], error_subcode: [2207008] },
    { code: true, error_subcode: true },
    { code: '', error_subcode: '' },
    { code: ' 190 ', error_subcode: '463' },
  ];
  for (const fields of cases) {
    const err = mapGraphError(400, { error: { message: 'malformed', ...fields } });
    assert.deepEqual(
      { kind: err.kind, status: err.status, code: err.code, subcode: err.subcode },
      { kind: 'upstream', status: 400, code: undefined, subcode: undefined },
      JSON.stringify(fields),
    );
  }
});

test('code 10 and the 200-299 band -> permission', () => {
  for (const code of [10, 200, 230, 299]) {
    const err = mapGraphError(403, envelope({ code, message: 'permission denied' }));
    assert.equal(err.kind, 'permission', `code ${code}`);
  }
});

test('throttling codes -> rate_limit (docs/operations.md §1)', () => {
  for (const code of [4, 17, 32, 613, 80002, 429]) {
    const err = mapGraphError(400, envelope({ code, message: 'throttled' }));
    assert.equal(err.kind, 'rate_limit', `code ${code}`);
  }
});

test('code 9 / subcode 2207042 -> rate_limit (publishing quota exceeded)', () => {
  assert.equal(mapGraphError(400, envelope({ code: 9 })).kind, 'rate_limit');
  assert.equal(
    mapGraphError(400, envelope({ code: 9, error_subcode: 2207042 })).kind,
    'rate_limit',
  );
});

test('code 100 -> validation', () => {
  const err = mapGraphError(400, envelope({ code: 100, message: 'Invalid parameter' }));
  assert.equal(err.kind, 'validation');
  assert.equal(err.code, 100);
});

test('container expired (code 24 / subcode 2207008) -> validation', () => {
  assert.equal(mapGraphError(400, envelope({ code: 24 })).kind, 'validation');
  assert.equal(
    mapGraphError(400, envelope({ code: 24, error_subcode: 2207008 })).kind,
    'validation',
  );
});

test('media not ready (code 9007 / subcode 2207027) -> upstream', () => {
  assert.equal(mapGraphError(400, envelope({ code: 9007 })).kind, 'upstream');
  assert.equal(
    mapGraphError(400, envelope({ code: 9007, error_subcode: 2207027 })).kind,
    'upstream',
  );
});

test('transient Meta-side codes 1 and 2 -> upstream', () => {
  assert.equal(mapGraphError(500, envelope({ code: 1 })).kind, 'upstream');
  assert.equal(mapGraphError(500, envelope({ code: 2 })).kind, 'upstream');
});

// --- subcode precedence & integrity restriction ----------------------------

test('subcode 2207051 (spam/integrity) -> upstream and never mislabeled as throttle', () => {
  const err = mapGraphError(
    400,
    envelope({ error_subcode: 2207051, error_user_msg: 'Action blocked to protect the community' }),
  );
  assert.equal(err.kind, 'upstream');
  assert.equal(err.subcode, 2207051);
});

test('a known subcode overrides the code (2207051 wins over a validation code 100)', () => {
  // Precedence guard: the integrity subcode must not be downgraded by the code.
  const err = mapGraphError(400, envelope({ code: 100, error_subcode: 2207051 }));
  assert.equal(err.kind, 'upstream');
});

// --- mapGraphError: HTTP-status fallback ------------------------------------

test('status fallback when the code is absent: 401->auth, 403->permission, 429->rate_limit', () => {
  assert.equal(mapGraphError(401, envelope({ message: 'no code' })).kind, 'auth');
  assert.equal(mapGraphError(403, envelope({ message: 'no code' })).kind, 'permission');
  assert.equal(mapGraphError(429, envelope({ message: 'no code' })).kind, 'rate_limit');
});

test('status fallback: any 5xx -> upstream; unrecognized status -> upstream (default)', () => {
  // Note for anyone mutation-testing this file: the explicit 5xx rule and the
  // rule-4 default both answer `upstream`, so the band's boundaries are not
  // observable through `kind` — no test can distinguish `>= 500` from `> 500`.
  // The rule stays because it states the intent at the point of decision; if the
  // default ever stops being `upstream`, this line is what keeps 5xx correct.
  assert.equal(mapGraphError(500, envelope({ message: 'boom' })).kind, 'upstream');
  assert.equal(mapGraphError(503, envelope({ message: 'boom' })).kind, 'upstream');
  assert.equal(mapGraphError(418, envelope({ message: 'teapot' })).kind, 'upstream');
});

// --- message selection ------------------------------------------------------

test('error_user_msg is preferred over error.message for the human message', () => {
  const err = mapGraphError(
    400,
    envelope({ message: 'developer detail', error_user_msg: 'operator-facing text' }),
  );
  assert.equal(err.message, 'operator-facing text');
});

test('falls back to error.message, then to a status-only message', () => {
  assert.equal(
    mapGraphError(400, envelope({ message: 'only the dev message' })).message,
    'only the dev message',
  );
  // No usable message field at all.
  const bare = mapGraphError(502, { error: { message: '   ' } });
  assert.equal(bare.message, 'Instagram Graph API error (HTTP 502)');
});

// --- fbtrace id handling ----------------------------------------------------

test("fbtrace id prefers the body's value, else the arg", () => {
  const fromBody = mapGraphError(400, envelope({ fbtrace_id: 'body-trace' }), 'header-trace');
  assert.equal(fromBody.fbtraceId, 'body-trace');

  const fromArg = mapGraphError(400, envelope({ code: 100 }), 'header-trace');
  assert.equal(fromArg.fbtraceId, 'header-trace');

  const neither = mapGraphError(400, envelope({ code: 100 }));
  assert.equal(neither.fbtraceId, undefined);
});

// --- security: no token leakage, raw body only on cause --------------------

test('token-shaped substrings are stripped from the surfaced message', () => {
  const token = `EAA${'A'.repeat(60)}`;
  const err = mapGraphError(400, envelope({ message: `Invalid OAuth token ${token} supplied` }));
  assert.equal(err.message.includes(token), false);
  assert.ok(err.message.includes('[redacted]'));
});

test('the raw body is retained on cause but never dumped into the message', () => {
  const body = envelope({ code: 190, message: 'Session has expired', fbtrace_id: 'trace-xyz' });
  const err = mapGraphError(401, body);
  assert.deepEqual(err.cause, body);
  // The message is the human field only — not a JSON dump of the body.
  assert.equal(err.message, 'Session has expired');
  assert.equal(err.message.includes('fbtrace_id'), false);
  assert.equal(err.message.includes('{'), false);
});

// --- malformed / defensive parsing ------------------------------------------

test('malformed bodies do not throw; kind derives from status', () => {
  // `body` is whatever the JSON parse produced, so every one of these is a shape
  // a broken upstream (or a captive-portal proxy) really can hand back. The
  // mapper is the last thing standing between that and a crash inside the code
  // whose only job is to describe a failure. `{ error: undefined }` and
  // `{ error: [] }` are the two that matter most: the key is present, so a
  // narrowing that only tests for the key would step straight into a property
  // read on `undefined`.
  for (const body of [
    null,
    undefined,
    'a string',
    42,
    true,
    {},
    [],
    [{ error: { code: 190 } }],
    { error: null },
    { error: undefined },
    { error: 'nope' },
    { error: 42 },
    { error: [] },
    { error: Object.create(null) as object },
    { error: () => 'nope' },
  ]) {
    const err = mapGraphError(500, body);
    assert.ok(err instanceof InstagramError);
    assert.equal(err.kind, 'upstream');
    assert.equal(err.code, undefined);
    assert.equal(err.subcode, undefined);
    assert.equal(err.message, 'Instagram Graph API error (HTTP 500)');
  }
});

test('non-numeric code/subcode are ignored (treated as absent)', () => {
  const err = mapGraphError(403, { error: { message: 'x', code: 'oops', error_subcode: null } });
  assert.equal(err.code, undefined);
  assert.equal(err.subcode, undefined);
  assert.equal(err.kind, 'permission'); // falls through to the 403 status rule

  // Numeric but not finite is the same case. `JSON.parse` cannot produce these,
  // but `body` is typed `unknown` and this is the only place that decides what
  // lands on the error — a `NaN` code would serialize to `null` in the log line
  // and read as "Meta sent no code" while the guard says otherwise.
  const nonFinite = mapGraphError(403, {
    error: { message: 'x', code: Number.NaN, error_subcode: Number.POSITIVE_INFINITY },
  });
  assert.equal(nonFinite.code, undefined);
  assert.equal(nonFinite.subcode, undefined);
  assert.equal(nonFinite.kind, 'permission');
});

// --- toInstagramError -------------------------------------------------------

test('toInstagramError returns an existing InstagramError unchanged (identity)', () => {
  const original = new InstagramError('already mapped', { kind: 'validation', code: 100 });
  const out = toInstagramError(original);
  assert.equal(out, original);
  assert.equal(out.kind, 'validation');
});

test('toInstagramError wraps a generic Error as upstream, preserving message and cause', () => {
  const network = new Error('ECONNRESET: connection reset by peer');
  const err = toInstagramError(network);
  assert.ok(isInstagramError(err));
  assert.equal(err.kind, 'upstream');
  assert.equal(err.message, 'ECONNRESET: connection reset by peer');
  assert.equal(err.cause, network);
});

test('toInstagramError keeps AbortError / timeout as upstream', () => {
  const abort = new Error('The operation was aborted');
  abort.name = 'AbortError';
  assert.equal(toInstagramError(abort).kind, 'upstream');

  const timeout = new Error('Request timed out');
  timeout.name = 'TimeoutError';
  assert.equal(toInstagramError(timeout).kind, 'upstream');
});

test('toInstagramError honors an explicit fallbackKind', () => {
  const err = toInstagramError(new Error('bad input'), 'validation');
  assert.equal(err.kind, 'validation');
});

test('toInstagramError does not stringify non-Error objects into the message', () => {
  const thrown = { secret: 'do-not-leak', nested: { a: 1 } };
  const err = toInstagramError(thrown);
  assert.equal(err.message, 'Unknown error');
  assert.equal(err.message.includes('do-not-leak'), false);
  assert.equal(err.cause, thrown); // still retained for logging
});

test('toInstagramError uses a thrown string as the (scrubbed) message', () => {
  assert.equal(toInstagramError('plain failure').message, 'plain failure');
  const token = `IGQ${'B'.repeat(40)}`;
  const err = toInstagramError(`leaked ${token} here`);
  assert.equal(err.message.includes(token), false);
  assert.ok(err.message.includes('[redacted]'));
});

test('an Error with a blank message falls back to its name, then to "Unknown error"', () => {
  // `new Error()` with no argument has `message === ''`, and libraries that
  // subclass without calling `super(msg)` produce the same thing. Surfacing the
  // empty string would give the operator a tool failure with no text at all, so
  // the name is the next-best label — and a blank name has to bottom out too.
  const named = new Error('');
  assert.equal(named.name, 'Error');
  assert.equal(toInstagramError(named).message, 'Error');

  const anonymous = new Error('');
  anonymous.name = '   ';
  assert.equal(toInstagramError(anonymous).message, 'Unknown error');
});

/**
 * What this catches: the `Unknown error` fallback is exercised by exactly two
 * shapes today — a plain object with no `message` field, and an `Error` whose
 * message and name are both blank — so the SET of values that must produce that
 * sentence is not pinned, only two members of it. Two plausible rewrites of
 * `toInstagramError` were measured surviving the whole suite because of that.
 *
 * Why the wording is behaviour: this string is not one field of a structured
 * error somebody else re-renders. It IS the `message` of the InstagramError that
 * an MCP tool result carries to the model and that a `catch` in a CLI prints to
 * the operator before the process exits, and it is the only place the fact "the
 * thrown value carried no usable text" is stated anywhere in the repo. If it
 * comes out empty the operator gets a tool failure with no text at all; if it
 * comes out as an untrusted object's own `message` the module has broken the
 * promise in its own docstring ("non-`Error` objects are never stringified into
 * the message") and the operator reads a sentence this repo did not author.
 *
 * Mutants measured as SURVIVING the suite without this test (both restored):
 *  - `err instanceof Error` → `typeof (err as {message?: unknown})?.message ===
 *    'string'` — the cross-realm "fix" a maintainer reaches for when
 *    `instanceof` stops working across a vm/worker boundary. 122/122 passed: the
 *    one non-Error fixture in the suite has no `message` key, so nothing noticed
 *    that a duck-typed `{ message: … }` now gets its text surfaced.
 *  - `nonEmptyString(err) ?? 'Unknown error'` → `typeof err === 'string' ? err :
 *    'Unknown error'` — 122/122 passed: a thrown `''` or `'   '` was never fed
 *    in, so an empty-message InstagramError went unseen.
 * Both are killed by the table below (the duck-typed rows and the blank-string
 * rows respectively).
 *
 * The table is every input spelling that reaches the sentence, not the one
 * convenient case: the non-`Error` branch (nullish, falsy primitives, blank and
 * whitespace-only strings, plain/duck-typed/prototype-less objects, arrays,
 * functions, symbols) and the `Error` branch bottoming out through a blank name.
 * The expected sentence is restated here rather than imported from `src/`.
 */
test('every thrown value with no usable text of its own bottoms out at "Unknown error"', () => {
  const cases: ReadonlyArray<{ label: string; thrown: unknown }> = [
    // --- the non-Error branch: nothing here is an Error, so nothing here may
    //     contribute text to the surfaced message.
    { label: 'undefined', thrown: undefined },
    { label: 'null', thrown: null },
    { label: 'the number zero', thrown: 0 },
    { label: 'a non-zero number', thrown: 42 },
    { label: 'false', thrown: false },
    { label: 'NaN', thrown: Number.NaN },
    { label: 'a bigint', thrown: 7n },
    { label: 'an empty string', thrown: '' },
    { label: 'a whitespace-only string', thrown: '   ' },
    { label: 'a tab/newline-only string', thrown: '\n\t' },
    { label: 'an empty object', thrown: {} },
    { label: 'an empty array', thrown: [] },
    { label: 'an array of strings', thrown: ['boom', 'again'] },
    { label: 'a function', thrown: () => 'nope' },
    { label: 'a symbol', thrown: Symbol('boom') },
    { label: 'a prototype-less object', thrown: Object.create(null) as object },
    // The duck-typed rows. A plain object that merely LOOKS like an error is the
    // realistic non-Error throw — a rejected promise carrying a parsed JSON
    // payload, an SDK that rejects with a POJO — and it is exactly what a
    // structural `typeof err.message === 'string'` check would start reading.
    {
      label: 'a duck-typed object with a string message',
      thrown: { message: 'duck-typed detail' },
    },
    {
      label: 'a duck-typed object with a message and a name',
      thrown: { message: 'do-not-surface', name: 'TypeError' },
    },
    { label: 'a duck-typed object with a blank message', thrown: { message: '   ' } },
    { label: 'a duck-typed object with a non-string message', thrown: { message: 42 } },
    { label: 'an object carrying only a name', thrown: { name: 'AbortError' } },
    {
      label: 'an object whose toString would produce text',
      thrown: { toString: () => 'do-not-stringify-me' },
    },
    // --- the Error branch, bottoming out: message blank AND name blank.
    { label: 'an Error with an empty message and an empty name', thrown: blankError('', '') },
    {
      label: 'an Error with a whitespace message and a whitespace name',
      thrown: blankError('   ', '   '),
    },
    { label: 'an Error with a newline-only name', thrown: blankError('', '\n') },
  ];

  for (const { label, thrown } of cases) {
    const err = toInstagramError(thrown);
    assert.ok(isInstagramError(err), label);
    // The whole clause, not a fragment: an empty message and somebody else's
    // sentence both have to fail here.
    assert.equal(err.message, 'Unknown error', label);
    assert.equal(err.kind, 'upstream', label);
  }

  // The explicit fallbackKind still rides along on the same fallback sentence.
  const kinded = toInstagramError({ message: 'do-not-surface' }, 'validation');
  assert.equal(kinded.message, 'Unknown error');
  assert.equal(kinded.kind, 'validation');
});

// --- precedence, isolated from the status fallback ---------------------------
//
// Most classification tests above pair a code with the status Meta really sends
// alongside it — 190 with 401, the permission band with 403. That is realistic,
// but it means the status rule would produce the same answer on its own, so the
// code rules are not actually under test there. These pin the code rules at a
// status that classifies differently, which is what makes them assertions about
// precedence rather than coincidences.

test('the code decides even when the HTTP status would say something else', () => {
  // 400 is the neutral status: it matches no fallback rule and lands on the
  // `upstream` default, so anything but `upstream` here came from the code.
  assert.equal(mapGraphError(400, envelope({ code: 190 })).kind, 'auth');
  assert.equal(mapGraphError(400, envelope({ code: 10 })).kind, 'permission');

  // And the reverse direction: an explicit transient code must not be upgraded
  // by a status that disagrees. `error.code` is documented as the more specific
  // signal (§3); the status is labelled "when the code is absent/unrecognized".
  for (const code of [1, 2, 9007]) {
    assert.equal(mapGraphError(401, envelope({ code })).kind, 'upstream', `code ${code} vs 401`);
    assert.equal(mapGraphError(403, envelope({ code })).kind, 'upstream', `code ${code} vs 403`);
  }
  assert.equal(mapGraphError(429, envelope({ code: 100 })).kind, 'validation');
});

test('the permission band is exactly 200-299, both ends included', () => {
  // Asserted at status 400 so the 403 rule cannot supply the same answer. The
  // band is a Meta convention, not a range someone picked: 199 and 300 are other
  // things entirely, and widening it would silently relabel unrelated failures
  // as "you are missing a scope" — the one message that sends an operator off
  // to re-run the whole permission review.
  for (const code of [10, 200, 201, 250, 298, 299]) {
    assert.equal(mapGraphError(400, envelope({ code })).kind, 'permission', `code ${code}`);
  }
  for (const code of [199, 300, 301]) {
    assert.notEqual(mapGraphError(400, envelope({ code })).kind, 'permission', `code ${code}`);
  }
});

test('every token-shaped substring in a message is stripped, not just the first', () => {
  // The strip is defense-in-depth for the message that gets surfaced to the
  // model. Meta echoes the offending input back in `error.message`, so a request
  // that carried a token twice (a URL plus its retry) comes back with two — and
  // a non-global regex would return one masked and one in the clear.
  const a = `EAA${'A'.repeat(30)}`;
  const b = `IGQ${'B'.repeat(30)}`;
  const err = mapGraphError(400, envelope({ message: `first ${a} second ${b} end` }));
  assert.equal(err.message, 'first [redacted] second [redacted] end');
});

// --- InstagramError itself (src/core/types.ts) ------------------------------

test('the error names itself, so it stays identifiable once the class is gone', () => {
  // `isInstagramError` is an `instanceof` check, and `instanceof` is exactly what
  // does not survive a boundary: a stack trace written to the stderr log, a
  // crash report, a `String(err)` interpolated into an MCP error frame. On the
  // other side of any of those, `name` is the only thing left that separates a
  // mapped Graph failure from an arbitrary JS bug — it is what an operator greps
  // for, and what tells them to go read docs/operations.md rather than a
  // stack. Pinned on the rendered forms too, since those are what actually ship.
  const err = new InstagramError('token expired', { kind: 'auth', status: 401 });
  assert.equal(err.name, 'InstagramError');
  assert.equal(String(err), 'InstagramError: token expired');
  assert.ok(err.stack?.startsWith('InstagramError: token expired'));
});

test('an error with no cause carries no cause property at all, not an undefined one', () => {
  // `new Error(msg, { cause: undefined })` is not the same as `new Error(msg)`:
  // the options form installs an OWN `cause` property whose value is undefined,
  // so `'cause' in err` flips from false to true. That distinction is the one
  // every error renderer keys on — `util.inspect` (and therefore anything that
  // console-logs the error) prints a trailing `[cause]: undefined` block, and
  // serializers that walk `while ('cause' in e)` step into a dead end instead of
  // stopping. The result is a diagnostic that claims there was an underlying
  // failure to look at when there was none.
  const bare = new InstagramError('validation failed', { kind: 'validation' });
  assert.equal('cause' in bare, false);
  assert.deepEqual(Object.getOwnPropertyNames(bare).includes('cause'), false);

  // The other direction: a real cause must still be chained, or the mutation is
  // "killed" by an assertion that would also pass on an error that drops causes.
  const root = new Error('socket hang up');
  const chained = new InstagramError('upstream failed', { kind: 'upstream', cause: root });
  assert.equal('cause' in chained, true);
  assert.equal(chained.cause, root);
});

// --- the docstring may only name modules that exist --------------------------

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

const REPO_ROOT = findRepoRoot();
const ERRORS_SOURCE = readFileSync(join(REPO_ROOT, 'src', 'core', 'errors.ts'), 'utf8');

test('every module path the errors.ts docstrings name resolves to a real file', () => {
  // A comment that points at a module which was never built is worse than no
  // comment: it tells the next maintainer that some other layer is handling the
  // problem, so nobody checks. This file used to name `mcp/redact.ts` as "the
  // authoritative redaction layer"; that module has never existed (CC-PROC-17).
  // The check is deliberately mechanical rather than a hardcoded denylist of the
  // one bad name — any future reference to a module that is not on disk fails it.
  //
  // It does not require backticks. Until 2026-09-23 it did, which made the guard
  // depend on the MARKUP of the claim rather than on the claim: re-stating the
  // original phantom as plain prose — "the authoritative redaction layer in
  // mcp/redact.ts" — restored the exact defect CC-PROC-17 records while this test
  // stayed green. Swept at the same time: today every `.ts` token in the file is
  // backticked, so the widening changes no verdict, only what it can see.
  //
  // The trailing boundary is `(?![\w-])` and not `(?![\w./-])`: the first draft
  // excluded a following dot, which is exactly the character a module path wears
  // when it ends a sentence — so the phantom restated as prose ending in
  // "... is mcp/redact.ts." survived the widened sweep too, and the positive
  // control caught it (CC-PROC-112, CC-PROC-129).
  const referenced = [
    ...new Set(
      [...ERRORS_SOURCE.matchAll(/(?<![\w./-])([\w.-]+(?:\/[\w.-]+)*\.ts)(?![\w-])/g)]
        .map((match) => match[1])
        .filter((ref): ref is string => ref !== undefined),
    ),
  ];

  assert.ok(referenced.length > 0, 'expected the docstrings to name at least one sibling module');
  for (const ref of referenced) {
    // A bare `foo.ts` is how a docstring names a SIBLING, so `src/core` is a
    // candidate root as well; without it the widening above would fail on prose
    // that is correct.
    const found = [
      join(REPO_ROOT, 'src', 'core', ref),
      join(REPO_ROOT, 'src', ref),
      join(REPO_ROOT, ref),
    ].some((path) => existsSync(path));
    assert.ok(
      found,
      `src/core/errors.ts names \`${ref}\`, which does not exist — describe the control that ` +
        'was actually built, not one that was only ever promised.',
    );
  }
});

// --- token-shape dictionary: no drift against core/redact.ts -----------------
//
// `core/errors.ts` carries its own copy of the token vocabulary because it is a
// pure Layer-0 mapper: it must not depend on `createRedactor`, whose output also
// varies with the process-global secret registry. Two copies of one vocabulary
// is the classic drift defect, and the weaker copy is the one that runs at the
// moment it matters — so the copies are pinned to each other here, behaviourally.

/** The marker `stripTokens` splices into a message (deliberately not `REDACTED`). */
const ERRORS_MARKER = '[redacted]';

/**
 * Marker-agnostic view of a redaction: *which* spans were masked, not what with.
 * `core/redact.ts` writes `[REDACTED]`, `core/errors.ts` writes `[redacted]`;
 * normalizing both to one sentinel lets the two dictionaries be compared for the
 * only property that has to match — the set of substrings each recognizes.
 */
function maskShape(text: string, marker: string): string {
  return text.split(marker).join('<masked>');
}

/**
 * The inputs the two dictionaries are compared over: the token shapes this
 * codebase genuinely produces, the boundaries around them, and the non-token
 * lookalikes that must survive. Every value is obviously synthetic — repeated
 * filler characters, never a captured credential.
 */
const TOKEN_CORPUS: ReadonlyArray<{ label: string; input: string }> = [
  { label: 'a Facebook EAA token', input: `prefix EAA${'X'.repeat(60)} suffix` },
  { label: 'an Instagram IGQ token', input: `prefix IGQ${'Y'.repeat(40)} suffix` },
  { label: 'an Instagram IGAA token', input: `prefix IGAA${'Z'.repeat(40)} suffix` },
  {
    label: 'an IG-prefixed token at the 22-character floor',
    input: `edge IGQ${'W'.repeat(19)} up`,
  },
  {
    label: 'an IG-prefixed run one character below the floor',
    input: `edge IGQ${'W'.repeat(18)} x`,
  },
  { label: 'a lowercase 64-hex appsecret_proof', input: `proof=${'a1b2c3d4'.repeat(8)} end` },
  { label: 'an uppercase 64-hex appsecret_proof', input: `proof=${'A1B2C3D4'.repeat(8)} end` },
  { label: 'a 63-hex run (one short of a proof)', input: `short ${'a'.repeat(63)} end` },
  { label: 'a 65-hex run (one over a proof)', input: `long ${'a'.repeat(65)} end` },
  { label: 'a 32-hex app secret (shape-invisible by design)', input: `secret ${'b'.repeat(32)} x` },
  {
    label: 'two different token shapes in one message',
    input: `first EAA${'X'.repeat(30)} second IGQ${'Y'.repeat(30)} end`,
  },
  // Repetition of one shape, per pattern: two shapes in one message only proves
  // that two *different* patterns fired, which a non-global regex also manages.
  {
    label: 'the same EAA shape twice',
    input: `first EAA${'X'.repeat(30)} second EAA${'Y'.repeat(30)} end`,
  },
  {
    label: 'the same IG shape twice',
    input: `first IGQ${'X'.repeat(30)} second IGAA${'Y'.repeat(30)} end`,
  },
  {
    label: 'the same proof shape twice',
    input: `a=${'a1b2c3d4'.repeat(8)} b=${'0f0f0f0f'.repeat(8)} end`,
  },
  // The EAA floor, both sides of it — the IG floor above is pinned but this one
  // was not, so a dictionary that quietly stopped matching short EAA tokens (or
  // started matching `EAA` in prose) would have passed.
  { label: 'an EAA token at the 23-character floor', input: `edge EAA${'X'.repeat(20)} up` },
  { label: 'an EAA run one character below the floor', input: `edge EAA${'X'.repeat(19)} x` },
  {
    label: 'an EAA token whose body carries base64url - and _',
    input: `t EAA${'aB9_-'.repeat(6)} e`,
  },
  // Nothing else here is long enough to notice an UPPER bound on the EAA body. A
  // long-lived Facebook token runs past two hundred characters, so a copy that
  // quietly capped the body would mask a token's head and pass every fixture
  // above — all of which are short enough to fit under any plausible cap.
  { label: 'an EAA token of several hundred characters', input: `t EAA${'X'.repeat(400)} e` },
  // The prefix and the hex class, from the over-redaction side: both dictionaries
  // must leave these alone. `EAB…` is not a Facebook token, and a 64-character
  // lowercase run that is not hex is not a proof.
  { label: 'an EA-prefixed run that is not an EAA token', input: `session EAB${'X'.repeat(30)} x` },
  {
    label: 'a 64-character alphanumeric run that is not hex',
    input: `hash ${'zyxwvuts'.repeat(8)} x`,
  },
  // Pattern order, in both directions. A proof directly abutting an IG token is
  // only masked because the IG pattern runs first and splices in the boundary the
  // `\b`-bounded proof pattern needs; an EAA token whose body starts `IG` is only
  // masked whole because EAA runs first. Reordering the list breaks one or other.
  {
    label: 'a proof abutting an IG token',
    input: `proof=${'a1b2c3d4'.repeat(8)}IG${'x'.repeat(20)}`,
  },
  { label: 'an EAA token whose body starts IG', input: `token EAAIG${'a'.repeat(20)} end` },
  { label: 'hashtags', input: '#instagood #IGNORE #IG #photooftheday' },
  { label: 'a media permalink', input: 'https://www.instagram.com/p/CxSYNTHETIC0/' },
  { label: 'a 17-digit Graph object id', input: 'ig_id=17841400000000000' },
  { label: 'an 18-digit Graph object id', input: 'media_id=123456789012345678' },
  { label: 'an ISO-8601 timestamp', input: 'created 2026-08-29T12:34:56+0000' },
  { label: 'prose that merely mentions IG', input: 'Check the IG account and IGNORE the rest' },
  {
    label: 'a long IG-prefixed identifier (agreed over-redaction)',
    input: 'const IGNORE_THIS_VERY_LONG_CONSTANT_NAME = 1',
  },
  // The one character that separates a token from this server's own environment
  // variable names: `IG` then an underscore (or a hyphen) is a name, and a
  // "set IG_…" error must keep naming the key (CC-PROC-72). Both dictionaries
  // must leave these alone while still masking a body that CONTAINS underscores.
  { label: 'an IG_* environment-variable name', input: 'set IG_PROFILE_BRAND_ACCESS_TOKEN first' },
  { label: 'an IG- prefixed run', input: `id IG-${'x'.repeat(25)} end` },
  { label: 'an IG token whose body is all underscores', input: `t IGQ${'_'.repeat(25)} e` },
  // The IG body class and the IG version character. The base64url and digit
  // fixtures above exercise only the EAA pattern, and every other `IG…` value
  // here happens to put a letter after `IG` and a single repeated character in
  // its body — so each of these classes could be narrowed in one copy alone and
  // nothing in this file objected.
  {
    label: 'an IG token whose body carries base64url - and _',
    input: `t IGQ${'aB9_-'.repeat(6)} e`,
  },
  {
    label: 'an IG token whose hyphen falls past the length floor',
    input: `t IGAA${'a'.repeat(30)}-${'b'.repeat(30)} e`,
  },
  { label: 'an IG token whose version character is a digit', input: `t IG7${'x'.repeat(30)} e` },
  {
    label: 'an IG_* key whose profile slug hides a second IG',
    input: 'set IG_PROFILE_DIGITALSTORE_ACCESS_TOKEN and retry',
  },
  {
    label: 'an IG token glued onto an identifier that merely contains IG_',
    input: `key CONFIG_IGQ${'x'.repeat(25)} end`,
  },
  { label: 'an IG token whose body carries digits', input: `t IGQ${'ab12cd34'.repeat(4)} e` },
  // Case. The IG pattern is case-SENSITIVE in both copies and the hex one is not;
  // a copy that went case-insensitive here would both drift and start eating
  // ordinary lowercase identifiers out of an operator's diagnostics.
  {
    label: 'a long lowercase ig-prefixed identifier',
    input: 'at ignore_this_very_long_symbol_name here',
  },
];

test('the token vocabulary in errors.ts recognizes exactly what core/redact.ts does', () => {
  // The drift guard. It compares the two dictionaries over real shapes rather
  // than comparing two regex sources, so it stays true however either side is
  // spelled — and it bites in both directions: it fails if `errors.ts` loses a
  // shape `redact.ts` masks (the original defect: `IGAA…` and the 64-hex
  // `appsecret_proof` both walked straight through), and equally if `errors.ts`
  // starts masking something `redact.ts` leaves alone.
  //
  // Nothing in this file calls `registerSecret`, so the redactor's exact-value
  // pass is empty here and only its token-shape pass is under comparison — which
  // is the only part `errors.ts` is supposed to mirror.
  const redact = createRedactor();
  for (const { label, input } of TOKEN_CORPUS) {
    const viaErrors = maskShape(
      mapGraphError(400, envelope({ message: input })).message,
      ERRORS_MARKER,
    );
    const viaRedactor = maskShape(String(redact(input)), REDACTED);
    assert.equal(
      viaErrors,
      viaRedactor,
      `token-shape dictionaries disagree on ${label} — core/errors.ts and core/redact.ts must ` +
        'recognize the same shapes; converge them rather than weakening either.',
    );
  }
});

test('an IG_* key is named in full even when its profile slug hides a second IG', () => {
  // This mapper is the only thing between Meta's `error.message` and the model,
  // and it is also what phrases "set <key> and retry". Its `IG` shape exempted
  // the `IG_` at the front of such a key but nothing further in, so a slug
  // spelling `IG` inside itself — `DIGITALSTORE`, `ZIGZAGMEDIA`, `BIGWAVESURF` —
  // put a token-shaped run in the middle of the key and the mapper answered
  // `set IG_PROFILE_D[redacted] and retry`, naming no key at all (CC-PROC-186).
  //
  // The drift corpus above pinned only `BRAND`, one of the two slugs with no
  // embedded `IG`, so both copies of the vocabulary were wrong in step and the
  // drift test — which compares them to each other — stayed green. A drift
  // test proves agreement, not correctness; each side needs its own kill
  // (CC-PROC-187).
  const key = 'IG_PROFILE_DIGITALSTORE_ACCESS_TOKEN';
  const err = mapGraphError(400, envelope({ message: `set ${key} and retry` }));
  assert.equal(err.message, `set ${key} and retry`);
  assert.equal(toInstagramError(new Error(`set ${key} and retry`)).message, `set ${key} and retry`);

  // The exemption must not spill onto a token that merely follows the key.
  const token = `IGQ${'x'.repeat(25)}`;
  assert.equal(
    mapGraphError(400, envelope({ message: `${key}=${token}` })).message,
    `${key}=[redacted]`,
  );
});

// Each character that can sit in front of `IG_` inside a longer run — an
// uppercase letter, a lowercase one, a digit, `_` and `-` — makes that `IG_`
// someone else's, and each has its own entry: dropping any one from the anchor
// class re-opens the leak for exactly that spelling.
const GLUED_IG_PREFIXES = [
  'CONFIG_',
  'SIG_',
  'cacheIG_',
  'v2IG_',
  'key_IG_',
  'key-IG_',
  'ig_user_',
];

test('the IG_ exemption needs IG_ to start the run, and then spans any slug', () => {
  // Unanchored, the lookbehind exempted a token glued onto any identifier that
  // merely contains `IG_` — `CONFIG_`, `SIG_` — and this mapper handed it to the
  // model whole. A lowercase `ig_` run is not a name this server owns either.
  const token = `IGQ${'x'.repeat(25)}`;
  for (const prefix of GLUED_IG_PREFIXES) {
    const err = mapGraphError(400, envelope({ message: `k ${prefix}${token} e` }));
    assert.equal(err.message, `k ${prefix}[redacted] e`);
  }

  // The other direction: a name that starts the string or sits in quotes, and
  // slugs whose run carries a digit and a hyphen or pushes the embedded `IG`
  // past 64 characters, are all still named in full.
  for (const key of [
    'IG_PROFILE_DIGITALSTORE_ACCESS_TOKEN',
    'IG_PROFILE_SHOP-2-DIGITALSTORE_ACCESS_TOKEN',
    `IG_PROFILE_${'A'.repeat(60)}DIGITALSTORE_ACCESS_TOKEN`,
  ]) {
    for (const shown of [key, `"${key}"`]) {
      assert.equal(mapGraphError(400, envelope({ message: shown })).message, shown);
    }
  }
});

test('an IGAA-prefixed Instagram token is stripped from the surfaced message', () => {
  // Instagram mints both `IGQ…` and `IGAA…` (docs/security.md §2, and the `IG`
  // prefix rule in core/redact.ts). The dictionary here recognized only `IGQ…`,
  // so an `IGAA…` token echoed back inside `error.message` reached the model.
  const token = `IGAA${'Z'.repeat(40)}`;
  const err = mapGraphError(400, envelope({ message: `Invalid OAuth token ${token} supplied` }));
  assert.equal(err.message.includes(token), false);
  assert.equal(err.message, 'Invalid OAuth token [redacted] supplied');

  // The same shape must also be scrubbed on the no-envelope path.
  assert.equal(toInstagramError(new Error(`thrown ${token}`)).message, 'thrown [redacted]');
});

test('an Instagram token whose body carries base64url - and _ is stripped whole', () => {
  // `IG…` tokens are base64url, so a real one carries `-` and `_` in its body —
  // which is exactly why the body class is `[A-Za-z0-9_-]` in both copies of the
  // vocabulary. Only the `EAA…` fixtures witnessed that class, so dropping `-`
  // from the IG body alone passed every other assertion in this file while
  // cutting the match short at the first hyphen: the tail shipped in the clear.
  const token = `IGQ${'aB9_-'.repeat(8)}`;
  const err = mapGraphError(400, envelope({ message: `Invalid OAuth token ${token} supplied` }));
  assert.equal(err.message.includes(token), false);
  assert.equal(err.message, 'Invalid OAuth token [redacted] supplied');

  // The tail is what a truncated match hands over, so pin the case where the head
  // alone already clears the length floor and a narrowed match would stop there.
  const late = `IGAA${'a'.repeat(30)}-${'b'.repeat(30)}`;
  assert.equal(mapGraphError(400, envelope({ message: `t ${late} e` })).message, 't [redacted] e');
  assert.equal(toInstagramError(new Error(`thrown ${late}`)).message, 'thrown [redacted]');
});

test('an Instagram token whose version character is a digit is stripped like any other', () => {
  // The character after `IG` is the mint's version tag and both copies spell it
  // `[A-Za-z0-9]`, not `[A-Za-z]`. Every other `IG…` value in this file happens
  // to carry a letter there, so narrowing that one class was invisible.
  const token = `IG7${'x'.repeat(30)}`;
  assert.equal(
    mapGraphError(400, envelope({ message: `Invalid OAuth token ${token} supplied` })).message,
    'Invalid OAuth token [redacted] supplied',
  );

  // Digits inside the body are the same blind spot one position along: a body of
  // one repeated letter cannot tell `[A-Za-z0-9_-]` from `[A-Za-z_-]`.
  const digits = `IGQ${'ab12cd34'.repeat(4)}`;
  assert.equal(
    mapGraphError(400, envelope({ message: `t ${digits} e` })).message,
    't [redacted] e',
  );
});

test('a Facebook token of several hundred characters is stripped whole, not just its head', () => {
  // The `EAA…` body is bounded below (`{20,}`) and deliberately not above: a
  // long-lived Facebook token runs well past two hundred characters. The longest
  // fixture in this file is sixty, so capping the body would mask a token's head,
  // leave its tail in the message, and pass everything else here — and a tail is
  // as usable as a whole token to anyone holding the head from a second error.
  const token = `EAA${'X'.repeat(400)}`;
  const err = mapGraphError(400, envelope({ message: `Invalid OAuth access token ${token}` }));
  assert.equal(err.message.includes('X'.repeat(20)), false);
  assert.equal(err.message, 'Invalid OAuth access token [redacted]');
});

test('a 64-hex appsecret_proof is stripped from the surfaced message', () => {
  // The proof is an HMAC-SHA256 of the token under the app secret: 64 hex chars
  // with no distinguishing prefix. It travels as a request parameter, so Meta
  // echoes it back in `error.message` on a malformed-parameter failure — and a
  // prefix-only dictionary cannot see it.
  const proof = 'a1b2c3d4'.repeat(8);
  assert.equal(proof.length, 64);
  const err = mapGraphError(400, envelope({ message: `Invalid appsecret_proof ${proof}` }));
  assert.equal(err.message.includes(proof), false);
  assert.equal(err.message, 'Invalid appsecret_proof [redacted]');

  // Case-insensitively, since hex renders either way.
  const upper = 'A1B2C3D4'.repeat(8);
  assert.equal(mapGraphError(400, envelope({ message: `x ${upper}` })).message, 'x [redacted]');
});

test('ordinary Instagram vocabulary is not mistaken for a token', () => {
  // The counterweight to the two tests above: widening a redaction dictionary is
  // only free if it does not start eating the operator's diagnostics. These are
  // the strings a Graph error message genuinely carries.
  for (const safe of [
    '#instagood and #IGNORE are fine',
    'https://www.instagram.com/p/CxSYNTHETIC0/',
    'Object with ID 17841400000000000 does not exist',
    'media_id=123456789012345678 was not found',
    'expires at 2026-08-29T12:34:56+0000',
  ]) {
    assert.equal(
      mapGraphError(400, envelope({ message: safe })).message,
      safe,
      `over-redacted: ${safe}`,
    );
  }
});

test('a lowercase ig-prefixed identifier is left in the message', () => {
  // The IG pattern is case-SENSITIVE in both copies of the vocabulary; only the
  // 64-hex one is not, because hex renders either way. Nothing pinned that
  // asymmetry, so adding `/i` to the IG pattern here both drifted the copies
  // apart and started eating ordinary lowercase identifiers out of an operator's
  // diagnostics — with every assertion in this file still green.
  const safe = 'at ignore_this_very_long_symbol_name here';
  assert.equal(mapGraphError(400, envelope({ message: safe })).message, safe);
});

// --- security: one shape, twice, per pattern --------------------------------

test('a message carrying the same token shape twice has both occurrences stripped', () => {
  // The existing "every token-shaped substring" test uses two *different* shapes,
  // so it passes even if each individual pattern is non-global — it only proves
  // two patterns fired once each. This is the case that actually bites: Meta
  // echoes the offending input back, so a request whose URL carried a token and
  // whose retry carried the same one comes back with a pair of the same shape,
  // and a non-global pattern masks the first and hands the second over in the
  // clear. Asserted per pattern, since the flag is per pattern.
  const cases: ReadonlyArray<[string, string]> = [
    [`EAA${'X'.repeat(30)}`, `EAA${'Y'.repeat(30)}`],
    [`IGQ${'X'.repeat(30)}`, `IGAA${'Y'.repeat(30)}`],
    ['a1b2c3d4'.repeat(8), '0f0f0f0f'.repeat(8)],
  ];
  for (const [first, second] of cases) {
    const err = mapGraphError(400, envelope({ message: `one ${first} two ${second} end` }));
    assert.equal(err.message, 'one [redacted] two [redacted] end');
  }
});

// --- publishing subcodes, isolated from the code and the status --------------

test('each publishing subcode classifies on its own, not via its usual code', () => {
  // Every subcode assertion above pairs the subcode with the code Meta really
  // sends beside it — 2207042 with code 9, 2207008 with 24, 2207027 with 9007 —
  // and each of those codes already yields the same kind. Realistic, but it means
  // deleting a whole `case` from the subcode switch changes nothing those tests
  // can see. These pin each subcode at a status/code combination that answers
  // differently, so only rule 1 can produce the expected kind.
  //
  // The stakes are the retry policy: `isRetryableKind` in core/http.ts derives
  // straight from `kind`. A quota subcode that stops being `rate_limit` loses the
  // backoff budget; a container-expired subcode that stops being `validation`
  // starts being retried against a container that can never succeed.
  assert.equal(mapGraphError(400, envelope({ error_subcode: 2207042 })).kind, 'rate_limit');
  assert.equal(mapGraphError(400, envelope({ error_subcode: 2207008 })).kind, 'validation');
  assert.equal(mapGraphError(401, envelope({ error_subcode: 2207027 })).kind, 'upstream');
  assert.equal(mapGraphError(429, envelope({ error_subcode: 2207051 })).kind, 'upstream');

  // And the exact constants, not a neighbouring one: an off-by-one subcode falls
  // out of rule 1 entirely and lands on the status default.
  for (const subcode of [2207041, 2207043, 2207007, 2207009, 2207026, 2207028]) {
    assert.equal(
      mapGraphError(400, envelope({ error_subcode: subcode })).kind,
      'upstream',
      `subcode ${subcode} must not be recognized`,
    );
  }
});

test('the integrity subcode outranks a throttling code rather than merging with it', () => {
  // 2207051 arrives on a publish or comment write; code 4 is the generic
  // application-throttle. If the code won, the failure would be reported as a
  // throttle, which tells the operator (and any backoff policy reading `kind`)
  // that waiting clears it. It does not — an integrity block is cleared by
  // changing what is being posted, not by waiting.
  assert.equal(mapGraphError(400, envelope({ code: 4, error_subcode: 2207051 })).kind, 'upstream');
});

// --- message and trace id: blank fields are not values -----------------------

test('a blank error_user_msg falls through to the developer message', () => {
  // Meta sends `error_user_msg` as an empty string on failures that have no
  // localized operator text. Preferring it because the key exists would replace
  // the one line describing the failure with nothing, and the operator would get
  // a tool error whose message is the empty string.
  for (const blank of ['', '   ', '\n\t']) {
    const err = mapGraphError(
      400,
      envelope({ message: 'developer detail', error_user_msg: blank }),
    );
    assert.equal(err.message, 'developer detail');
  }
});

test('a blank fbtrace_id in the body falls through to the header value', () => {
  // CC-DATA-21: present-but-empty is not a trace id. The trace id exists to be
  // pasted into a Meta support ticket, so surfacing `''` because the key was
  // present — while a real id sat in the `x-fb-trace-id` header — costs the
  // operator the only handle Meta will act on.
  for (const blank of ['', '   ']) {
    const err = mapGraphError(400, envelope({ fbtrace_id: blank }), 'header-trace');
    assert.equal(err.fbtraceId, 'header-trace');
  }
  assert.equal(mapGraphError(400, envelope({ fbtrace_id: '  ' })).fbtraceId, undefined);
});

test("Meta's text is surfaced exactly as sent, not reformatted", () => {
  // The blank checks above must stay tests of *emptiness*, not licence to
  // normalize. What Meta wrote is what an operator will search for in Meta's own
  // documentation and error reference, so trimming, collapsing or re-casing it
  // silently breaks that lookup — and any consumer matching on the string.
  const spaced = '  Action blocked to protect the community.  ';
  assert.equal(mapGraphError(400, envelope({ error_user_msg: spaced })).message, spaced);
  assert.equal(mapGraphError(400, { error: { message: spaced } }).message, spaced);
  assert.equal(toInstagramError(new Error(spaced)).message, spaced);
});

// --- untrusted Graph text is bounded and defused (CC-DATA-91/92) ----------

test('a Graph message with a newline, U+2028 or ESC is escaped, not echoed (CC-DATA-91)', () => {
  // A raw newline lets the upstream text forge a second line in the operator's
  // log or the model's tool result; ESC repaints a terminal.
  const forged = 'Bad request\nOK  Health check passed\u2028\u001b[2J\u202Egnp.exe';
  const expected = 'Bad request\\u{a}OK  Health check passed\\u{2028}\\u{1b}[2J\\u{202e}gnp.exe';
  assert.equal(mapGraphError(400, envelope({ message: forged })).message, expected);
  assert.equal(mapGraphError(400, envelope({ error_user_msg: forged })).message, expected);
});

test('a Graph message past MAX_GRAPH_MESSAGE_LENGTH code points is cut with its length stated (CC-DATA-91)', () => {
  assert.equal(MAX_GRAPH_MESSAGE_LENGTH, 1000);
  const words = 'word '.repeat(400); // 2000 code points
  const err = mapGraphError(400, envelope({ message: words }));
  assert.equal(err.message, `${'word '.repeat(200)}… (2000 characters in all)`);
  const user = mapGraphError(400, envelope({ error_user_msg: words }));
  assert.equal(user.message, err.message);
});

test('a Graph message of exactly MAX_GRAPH_MESSAGE_LENGTH code points is not cut', () => {
  const exact = `${'word '.repeat(199)}word`.padEnd(1000, 'x');
  assert.equal(Array.from(exact).length, 1000);
  assert.equal(mapGraphError(400, envelope({ message: exact })).message, exact);
  const over = `${exact} y`;
  assert.match(
    mapGraphError(400, envelope({ message: over })).message,
    /… \(1002 characters in all\)$/,
  );
});

test('a secret straddling the cap is dropped whole, never cut to a prefix (CC-DATA-92)', () => {
  // A 32-hex app secret has no token shape, so only the downstream exact-value
  // registry masks it — and that registry cannot match half of it.
  const secret = '0123456789abcdef0123456789abcdef';
  const message = `${'a'.repeat(990)} ${secret} tail`;
  const err = mapGraphError(400, envelope({ message }));
  assert.equal(
    err.message,
    `${'a'.repeat(990)} … (${Array.from(message).length} characters in all)`,
  );
  assert.ok(!err.message.includes('0123456789'));
  // The downstream redactor then sees nothing of it at all.
  const redact = createRedactor({ extraSecrets: [secret] });
  assert.ok(!String(redact(err.message)).includes('01234'));
});

test('tokens are stripped over the whole text before the cut (CC-DATA-92)', () => {
  const token = `EAA${'T'.repeat(60)}`;
  // Raw, the token straddles the cap (code points 981..1043 of 1049).
  const message = `${'a'.repeat(980)} ${token} tail`;
  assert.ok(Array.from(message).length > MAX_GRAPH_MESSAGE_LENGTH);
  const err = mapGraphError(400, envelope({ message }));
  // Stripping first shrinks the text under the cap, so nothing is cut at all.
  assert.equal(err.message, `${'a'.repeat(980)} ${ERRORS_MARKER} tail`);
});

// --- the envelope wrapper is required ----------------------------------------

test('an error-shaped body with no `error` wrapper is not read as a Graph error', () => {
  // This is not a Graph envelope — it is the shape a proxy, gateway or SDK uses
  // for its own errors. Interpreting the top level would let anything that
  // happens to carry a `code` drive the taxonomy, so a load balancer answering
  // `{"code":190}` would be reported as an expired Instagram token and send the
  // operator to re-authenticate a token that is fine.
  const err = mapGraphError(400, { code: 190, message: 'Session has expired', error_subcode: 463 });
  assert.equal(err.kind, 'upstream');
  assert.equal(err.code, undefined);
  assert.equal(err.subcode, undefined);
  assert.equal(err.message, 'Instagram Graph API error (HTTP 400)');
});

// --- the code is carried through, whatever its value -------------------------

test('a finite but unexpected code is still carried onto the error', () => {
  // `code` and `error_subcode` are what an operator quotes to Meta support, and
  // this is the only place that decides whether they survive. The guard is about
  // usability as a number (`NaN`, `Infinity`, a string), not about the value
  // being one this file recognizes — narrowing it to, say, integers would
  // silently erase a code Meta did send, leaving a record that says Meta sent
  // none. Unrecognized is a classification question; it is not licence to drop
  // the evidence.
  assert.equal(mapGraphError(400, envelope({ code: 200.5 })).code, 200.5);
  assert.equal(mapGraphError(400, envelope({ code: -1 })).code, -1);
  assert.equal(mapGraphError(400, envelope({ code: 0 })).code, 0);
  assert.equal(mapGraphError(400, envelope({ error_subcode: 1.5 })).subcode, 1.5);
});

// --- the text fields must be strings, not merely present -------------------

test('a non-string message, error_user_msg or fbtrace_id is treated as absent, never coerced', () => {
  // The blank-string rows above pin *emptiness*; this pins the *type*. `body` is
  // whatever `JSON.parse` produced, and a broken upstream can put a number, a
  // boolean or an object in any of the three text slots. Coercing would surface
  // `'42'` or `'[object Object]'` as the operator-facing failure text, or hand
  // `'123'` to Meta support as a trace id — while the header carried the real
  // one. Each wrong-typed field falls through exactly as a missing one does.
  for (const wrong of [42, 0, true, false, { text: 'x' }, ['x'], null]) {
    const label = JSON.stringify(wrong);
    const err = mapGraphError(
      502,
      { error: { message: wrong, error_user_msg: wrong, fbtrace_id: wrong } },
      'header-trace',
    );
    assert.equal(err.message, 'Instagram Graph API error (HTTP 502)', label);
    assert.equal(err.fbtraceId, 'header-trace', label);
    // A wrong-typed `error_user_msg` still lets a real `message` through.
    const partial = mapGraphError(400, {
      error: { message: 'developer detail', error_user_msg: wrong },
    });
    assert.equal(partial.message, 'developer detail', label);
  }
});

// --- error.type: the OAuthException tie-breaker (CC-AUTH-23) ----------------
//
// Meta stamps `type: 'OAuthException'` on every authentication failure. Until
// 2026-09-19 no source module read that field, so a dead token whose envelope
// carried no recognised `code` fell into the status fallback, where HTTP 400
// answers `upstream` — and `upstream` is retried on every GET. Every test below
// classifies at status 400, the neutral status that matches no fallback rule,
// so anything but `upstream` came from the `type` rule and nowhere else.

test('an OAuthException with no code at HTTP 400 classifies as auth, not upstream', () => {
  // Measured before the rule existed: this exact envelope answered `upstream`.
  const err = mapGraphError(
    400,
    envelope({ type: 'OAuthException', message: 'Error validating access token' }),
  );
  assert.equal(err.kind, 'auth');
  assert.equal(err.code, undefined, 'no code was sent, so none is invented');
  assert.equal(err.status, 400);
  assert.equal(err.message, 'Error validating access token');
});

test('an OAuthException with an unrecognised code still classifies as auth', () => {
  // The code ladder declines 999, so the envelope reaches the `type` rule with
  // the code intact — classification and evidence are separate concerns.
  const err = mapGraphError(400, envelope({ type: 'OAuthException', code: 999 }));
  assert.equal(err.kind, 'auth');
  assert.equal(err.code, 999, 'the unrecognised code is still carried onto the error');
});

test('a recognised code outranks the OAuthException type: code 4 stays rate_limit', () => {
  // Meta also stamps `OAuthException` on throttles and permission failures.
  // Those numbered codes are the more specific signal and are decided by rule 2
  // before the type is consulted — a throttled token is not a dead one, and
  // telling the operator to re-authenticate would not clear it.
  assert.equal(
    mapGraphError(400, envelope({ type: 'OAuthException', code: 4 })).kind,
    'rate_limit',
  );
  assert.equal(
    mapGraphError(400, envelope({ type: 'OAuthException', code: 17 })).kind,
    'rate_limit',
  );
  assert.equal(
    mapGraphError(400, envelope({ type: 'OAuthException', code: 32 })).kind,
    'rate_limit',
  );
  assert.equal(
    mapGraphError(400, envelope({ type: 'OAuthException', code: 10 })).kind,
    'permission',
  );
  assert.equal(
    mapGraphError(400, envelope({ type: 'OAuthException', code: 200 })).kind,
    'permission',
  );
  assert.equal(
    mapGraphError(400, envelope({ type: 'OAuthException', code: 100 })).kind,
    'validation',
  );
  assert.equal(mapGraphError(400, envelope({ type: 'OAuthException', code: 190 })).kind, 'auth');
  // And a known subcode still outranks everything, the type included.
  assert.equal(
    mapGraphError(400, envelope({ type: 'OAuthException', error_subcode: 2207042 })).kind,
    'rate_limit',
  );
});

test('a non-OAuthException type with no code at HTTP 400 still falls through to upstream', () => {
  // The rule is a tie-breaker for ONE class name. `GraphMethodException` is
  // Meta's "no such node / method" class and says nothing about the credential.
  const err = mapGraphError(400, envelope({ type: 'GraphMethodException' }));
  assert.equal(err.kind, 'upstream');
});

test('the OAuthException match is exact: a case or whitespace near-miss is not auth', () => {
  // `type` is Meta's own enumerated class name, spelled one way. A looser match
  // would let a proxy's or a gateway's own `type` field — which the envelope
  // shape cannot rule out — promote an unrelated failure into "re-login".
  for (const near of ['oauthexception', 'OAUTHEXCEPTION', ' OAuthException', 'OAuthException ']) {
    assert.equal(
      mapGraphError(400, envelope({ type: near })).kind,
      'upstream',
      `type ${JSON.stringify(near)} must not match`,
    );
  }
});

test('a non-string type is treated as absent and falls through to the status rules', () => {
  // The same rule as the other text fields: `body` is whatever `JSON.parse`
  // produced, and a wrong-typed `type` is not coerced into a string that could
  // then be compared.
  for (const wrong of [42, 0, true, false, { name: 'OAuthException' }, ['OAuthException'], null]) {
    const label = JSON.stringify(wrong);
    assert.equal(mapGraphError(400, { error: { type: wrong } }).kind, 'upstream', label);
    // The status rules still apply behind a wrong-typed `type`.
    assert.equal(mapGraphError(401, { error: { type: wrong } }).kind, 'auth', label);
  }
});

// --- invisible text, integer codes, trace ids (CC-DATA-96..CC-DATA-99) -------

test('an error_user_msg of only zero-width or bidi characters loses to error.message (CC-DATA-96)', () => {
  // `trim()` keeps these, so the old check let the field win and the escaped
  // message came out as a row of `\u{…}` escapes in place of Meta's useful text.
  for (const invisible of ['\u200b', '\u200b\u200e', ' \u202e \u2066 ', '\u0000', '\ufeff']) {
    const err = mapGraphError(
      400,
      envelope({ message: 'developer detail', error_user_msg: invisible }),
    );
    assert.equal(err.message, 'developer detail', JSON.stringify(invisible));
  }
  const bothInvisible = mapGraphError(
    400,
    envelope({ message: '\u200b', error_user_msg: '\u200b' }),
  );
  assert.equal(bothInvisible.message, 'Instagram Graph API error (HTTP 400)');
});

test('an invisible type or fbtrace_id is treated as absent (CC-DATA-96)', () => {
  const err = mapGraphError(400, envelope({ type: '\u200bOAuthException\u200b' }));
  assert.equal(err.kind, 'upstream', 'a padded type is a near-miss, not OAuthException');
  assert.equal(mapGraphError(400, envelope({ type: '\u200b' })).kind, 'upstream');
  const trace = mapGraphError(400, envelope({ fbtrace_id: '\u200b' }), 'header-trace');
  assert.equal(trace.fbtraceId, 'header-trace');
});

test('a fractional code is carried but never classified (CC-DATA-97)', () => {
  // 250.5 sits inside the 200-299 permission band by comparison, but Meta's codes
  // are integers: a fraction is not a code this ladder recognises, so the status
  // decides — and the value itself is still kept as evidence.
  const band = mapGraphError(400, envelope({ code: 250.5 }));
  assert.equal(band.kind, 'upstream');
  assert.equal(band.code, 250.5);
  assert.equal(mapGraphError(500, envelope({ code: 190.5 })).kind, 'upstream');
  assert.equal(mapGraphError(401, envelope({ code: 4.5 })).kind, 'auth');
  // The integer neighbours still classify as before.
  assert.equal(mapGraphError(400, envelope({ code: 250 })).kind, 'permission');
  assert.equal(mapGraphError(500, envelope({ code: 190 })).kind, 'auth');
});

test('a long or control-laden fbtrace_id is bounded and escaped, from the body or the header (CC-DATA-98)', () => {
  const forged = 'Abc123\nOK  Health check passed\u2028\u001b[2J';
  const expected = 'Abc123\\u{a}OK  Health check passed\\u{2028}\\u{1b}[2J';
  assert.equal(mapGraphError(400, envelope({ fbtrace_id: forged })).fbtraceId, expected);
  assert.equal(mapGraphError(400, envelope({}), forged).fbtraceId, expected);

  const long = 'T'.repeat(5000);
  assert.equal(
    mapGraphError(400, envelope({ fbtrace_id: long })).fbtraceId,
    '… (5000 characters in all)',
  );
  const spaced = `${'ab '.repeat(100)}`;
  assert.equal(
    mapGraphError(400, envelope({}), spaced).fbtraceId,
    `${'ab '.repeat(42)}ab… (300 characters in all)`,
  );
  // A header with nothing visible in it is no trace id, same as the body's.
  for (const blank of ['   ', '\u200b', '\t\u2028']) {
    assert.equal(
      mapGraphError(400, envelope({}), blank).fbtraceId,
      undefined,
      JSON.stringify(blank),
    );
  }
  // A real trace id is short and printable, and passes through unchanged.
  const real = 'AbCdEfGh1_-23xYz';
  assert.equal(mapGraphError(400, envelope({ fbtrace_id: real })).fbtraceId, real);
  assert.equal(
    mapGraphError(400, envelope({ fbtrace_id: 'x'.repeat(128) })).fbtraceId,
    'x'.repeat(128),
  );
});

test('toInstagramError escapes and bounds the thrown text like a Graph message (CC-DATA-99)', () => {
  const forged = 'socket hang up\nOK  Health check passed\u202e';
  const expected = 'socket hang up\\u{a}OK  Health check passed\\u{202e}';
  assert.equal(toInstagramError(new Error(forged)).message, expected);
  assert.equal(toInstagramError(forged).message, expected);
  const words = 'word '.repeat(400);
  assert.equal(
    toInstagramError(new Error(words)).message,
    `${'word '.repeat(200)}… (2000 characters in all)`,
  );
  // A name of only invisible characters is no better than a blank one.
  assert.equal(toInstagramError(blankError('\u200b', '\u200b')).message, 'Unknown error');
  assert.equal(toInstagramError('\u200b').message, 'Unknown error');
});

test('quoteGraphText quotes, escapes, strips tokens and cuts word-safe (CC-DATA-95)', () => {
  const token = `EAA${'T'.repeat(60)}`;
  assert.equal(quoteGraphText(`bad "${token}"`, 100), `"bad \\"${ERRORS_MARKER}\\""`);
  assert.equal(quoteGraphText('a\u2028b', 100), '"a\\u{2028}b"');
  assert.equal(quoteGraphText('keep 0123456789abcdef', 8), '"keep …" (21 characters in all)');
});

test('quoteGraphId renders an overlong single-run wire id by its length only, never a hard-cut prefix (CC-DATA-111)', () => {
  // By decision. The cut is word-safe (CC-DATA-92): a hard cut through a
  // registered secret with no token shape would leave a prefix the exact-value
  // registry downstream can no longer match.
  assert.equal(quoteGraphId('1'.repeat(64)), '1'.repeat(64));
  assert.equal(quoteGraphId('1'.repeat(65)), '"…" (65 characters in all)');
  assert.equal(quoteGraphId(`12 ${'3'.repeat(70)}`), '"12 …" (73 characters in all)');
});

// --- CC-DATA-121: the IG exemption is linear, and equal to the lookbehind ----

/** This copy's token-shape pass as it was spelled until 2026-09-26 (the reference). */
function lookbehindStrip(text: string): string {
  return text
    .replace(/EAA[A-Za-z0-9_-]{20,}/g, ERRORS_MARKER)
    .replace(
      /IG[A-Za-z0-9](?<!(?<![A-Za-z0-9_-])IG_[A-Za-z0-9_-]*)[A-Za-z0-9_-]{19,}/g,
      ERRORS_MARKER,
    )
    .replace(/\b[a-f0-9]{64}\b/gi, ERRORS_MARKER);
}

test('the IG exemption strips exactly what the lookbehind it replaced did (CC-DATA-121)', () => {
  // The drift test holds this copy equal to core/redact.ts; this holds it equal
  // to its own former spelling, so the two copies cannot go wrong in step.
  const pieces = ['IG', 'IG_', 'IGQ', 'CONFIG_', 'EAA', '_', '-', ' ', 'a', '7', 'x'.repeat(10)];
  let seed = 7;
  for (let i = 0; i < 2000; i += 1) {
    let text = 'm ';
    const count = i % 40;
    for (let j = 0; j < count; j += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      text += pieces[seed % pieces.length];
    }
    text += ' end';
    assert.equal(mapGraphError(400, envelope({ message: text })).message, lookbehindStrip(text));
  }
});

test('a long IG_-rooted run in a Graph message is stripped in linear time (CC-DATA-121)', () => {
  // The strip runs over the whole wire text before the 1 000-code-point cap, and
  // a Graph body may be 16 MiB: the lookbehind took 15 s on this 200 000.
  const run = `IG_${'IGa'.repeat(66_666)}`;
  const started = performance.now();
  const masked = mapGraphError(400, envelope({ message: `Q${run}` })).message;
  assert.ok(performance.now() - started < 1000, 'stripping 200 000 characters took over 1 s');
  assert.ok(masked.startsWith(`QIG_${ERRORS_MARKER}`));
  const own = mapGraphError(400, envelope({ message: `set ${run.slice(0, 40)} now` })).message;
  assert.equal(own, `set ${run.slice(0, 40)} now`);
});
