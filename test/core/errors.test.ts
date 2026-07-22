import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError, isInstagramError } from '../../src/core/types.js';
import type { GraphErrorBody } from '../../src/core/types.js';
import { mapGraphError, toInstagramError } from '../../src/core/errors.js';

/** Build a Graph error envelope with the given `error` fields. */
function envelope(error: Partial<GraphErrorBody['error']>): GraphErrorBody {
  return { error: { message: 'default message', ...error } };
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
  for (const body of [null, undefined, 'a string', 42, {}, { error: null }, { error: 'nope' }]) {
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
