/**
 * Fixture-harness gate (workplan T-E1). Two jobs:
 *
 *  1. Prove the sanitizer (`test/helpers/sanitize.ts`) actually holds under
 *     adversarial input — a token in a nested `paging` URL, a token-shaped
 *     string in a field nobody declared, a token-shaped string smuggled into an
 *     allowlisted enum field, and an emoji/ZWJ caption.
 *  2. Gate the committed `test/fixtures/` directory: nothing shipped there may
 *     contain secret-shaped content, a real-looking ID or a real host.
 *
 * Runs from the repo root (cwd), like the other `test/release/*` gates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_URL_HOSTS,
  DEFAULT_FIELD_POLICY,
  SYNTHETIC_ID_RE,
  SYNTHETIC_OPAQUE_PREFIX,
  SYNTHETIC_URL_HOST,
  SYNTHETIC_USERNAME_PREFIX,
  assertFixtureSafe,
  createSanitizer,
  findSecretLeaks,
  sanitizeGraphResponse,
} from '../helpers/sanitize.js';
import { fixturesDirFor, listFixtures, loadFixture } from '../helpers/fixtures.js';

// --- Adversarial payload ----------------------------------------------------

/** Token-shaped but never issued: matches the redactor's `EAA…` backstop pattern. */
const FAKE_FB_TOKEN = `EAAG${'x'.repeat(64)}`;
/** Token-shaped but never issued: matches the redactor's `IG…` backstop pattern. */
const FAKE_IG_TOKEN = `IGQVJ${'y'.repeat(60)}`;
/** 64 hex chars — the `appsecret_proof` shape. */
const FAKE_PROOF = 'ab12'.repeat(16);
/** A secret with no distinguishing shape at all — only exact-value redaction catches it. */
const SHAPELESS_SECRET = 'correct-horse-battery-staple-42';

const EMOJI_CAPTION = 'café 👨‍👩‍👧 🎉 done';

/**
 * A real-looking Instagram object ID: the input a sanitizer is *handed*, never
 * anything it may emit. `178414…` is a prefix Graph actually allocates, which is
 * what makes it read as real — and why {@link SYNTHETIC_ID_RE} must reject it.
 */
const REAL_MEDIA_ID = '17841400000000001';

/** A realistic `{data, paging}` page with every leak vector planted in it. */
function adversarialPayload(): Record<string, unknown> {
  return {
    data: [
      {
        id: REAL_MEDIA_ID,
        caption: EMOJI_CAPTION,
        // An allowlisted `keep` field is the softest target: the allowlist waves
        // it through, so only the redactor backstop stands between it and disk.
        media_type: FAKE_FB_TOKEN,
        media_product_type: SHAPELESS_SECRET,
        media_url: 'https://scontent.cdninstagram.com/v/t51.29350-15/real.jpg?oh=abc&oe=123',
        permalink: 'https://www.instagram.com/p/CrEaLpErMa/',
        username: 'the_real_operator',
        like_count: 7,
        // Not in the policy at all — Meta adds fields without notice.
        surprise_field: FAKE_IG_TOKEN,
        another_surprise: { nested: SHAPELESS_SECRET },
      },
      {
        id: '17841400000000002',
        caption: 'second post',
        username: 'the_real_operator',
        like_count: 0,
      },
    ],
    paging: {
      cursors: { before: 'QVFIUmVhbEJlZm9yZQ==', after: 'QVFIUmVhbEFmdGVy' },
      next:
        `https://graph.facebook.com/v25.0/${REAL_MEDIA_ID}/media` +
        `?access_token=${FAKE_FB_TOKEN}&appsecret_proof=${FAKE_PROOF}` +
        '&after=QVFIUmVhbEFmdGVy&limit=25&fields=id,caption,media_url',
      previous: `https://graph.facebook.com/v25.0/${REAL_MEDIA_ID}/media?before=QVFIUmVhbEJlZm9yZQ==`,
    },
  };
}

interface SanitizedPage {
  data: Array<Record<string, unknown>>;
  paging: { cursors: { before: string; after: string }; next: string; previous?: string };
}

function sanitizeAdversarial(): { out: SanitizedPage; dropped: readonly string[] } {
  const sanitizer = createSanitizer({ extraSecrets: [SHAPELESS_SECRET] });
  const out = sanitizer.sanitize(adversarialPayload()) as SanitizedPage;
  return { out, dropped: sanitizer.droppedKeys };
}

/**
 * Every string leaf paired with the key it sits under, for assertions that depend
 * on the field rather than the value's shape. Array elements inherit their
 * container's key, which is what the sanitizer's by-name policy does too.
 */
function labeledStrings(
  value: unknown,
  key = '$',
  acc: { key: string; value: string }[] = [],
): { key: string; value: string }[] {
  if (typeof value === 'string') acc.push({ key, value });
  else if (Array.isArray(value)) for (const item of value) labeledStrings(item, key, acc);
  else if (value !== null && typeof value === 'object') {
    for (const [k, item] of Object.entries(value)) labeledStrings(item, k, acc);
  }
  return acc;
}

/** Every string anywhere in `value`, for whole-document assertions. */
function allStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, acc);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      acc.push(key);
      allStrings(item, acc);
    }
  }
  return acc;
}

/**
 * Every ID-shaped run of digits anywhere inside `value`.
 *
 * Anchoring the test at both ends — which is what this gate did until 2026-09-23 —
 * judges only a string that is an ID and nothing else. Graph does not hand those
 * out alone: a comment id is `{media}_{comment}`, and an ID appears again in the
 * path of every `paging` URL. Measured on that date, a fixture carrying the
 * composite `17841400008460056_17877854240352520` and the URL
 * `https://graph.facebook.com/17841400008460056/comments?after=QVFI` passed the
 * entire suite, because neither string is all digits from end to end
 * (CC-PROC-170). Scanning for runs judges the parts instead of the wrapper, so how
 * an ID is packaged stops mattering.
 */
function idShapedRuns(value: string): string[] {
  return [...value.matchAll(/\d{15,}/g)].map((match) => match[0]);
}

// --- Adversarial sanitizer tests -------------------------------------------

test('nothing token-shaped survives the adversarial payload', () => {
  const { out } = sanitizeAdversarial();
  const serialized = JSON.stringify(out);

  for (const secret of [FAKE_FB_TOKEN, FAKE_IG_TOKEN, FAKE_PROOF, SHAPELESS_SECRET]) {
    assert.ok(!serialized.includes(secret), `sanitized output still contains a secret: ${secret}`);
  }
  assert.ok(!serialized.includes('access_token'), 'no access_token param may survive');
  assert.ok(!serialized.includes('appsecret_proof'), 'no appsecret_proof param may survive');
  // The redactor is the authority on "secret-shaped"; ask it directly.
  assert.deepEqual(findSecretLeaks(out, { extraSecrets: [SHAPELESS_SECRET] }), []);
});

test('a token inside a nested paging URL is stripped, and the URL stays usable', () => {
  const { out } = sanitizeAdversarial();
  const next = out.paging.next;

  assert.ok(next.startsWith('https://graph.facebook.com/v25.0/'), `unexpected next URL: ${next}`);
  assert.ok(next.endsWith('/media?after=SYNTHETIC_OPAQUE_2&limit=25'), `unexpected query: ${next}`);
  assert.ok(!next.includes('access_token'));
  assert.ok(!next.includes('appsecret_proof'));
  // `fields` can embed a handle (business_discovery.username(<handle>)) — denied.
  assert.ok(!next.includes('fields'), '`fields` is not on the query allowlist');
  // The ID in the path went through the same mapping as the ID in the body, so
  // the fixture still describes the same object it described upstream.
  const bodyId = out.data[0]?.id as string;
  assert.ok(next.includes(`/${bodyId}/media`), 'path ID must reuse the body ID mapping');
});

test('cursors map consistently between paging.cursors and the paging URLs', () => {
  const { out } = sanitizeAdversarial();
  assert.ok(out.paging.cursors.after.startsWith(SYNTHETIC_OPAQUE_PREFIX));
  assert.ok(out.paging.cursors.before.startsWith(SYNTHETIC_OPAQUE_PREFIX));
  assert.notEqual(out.paging.cursors.after, out.paging.cursors.before);
  assert.ok(
    out.paging.next.includes(`after=${out.paging.cursors.after}`),
    'the same real cursor must yield the same synthetic cursor in both places',
  );
  assert.ok(out.paging.previous?.includes(`before=${out.paging.cursors.before}`));
});

test('a token-shaped string in an undeclared field is dropped and reported', () => {
  const { out, dropped } = sanitizeAdversarial();
  const first = out.data[0] ?? {};
  assert.equal(first.surprise_field, undefined, 'unknown keys must not be copied');
  assert.equal(first.another_surprise, undefined, 'unknown containers must not be copied');
  assert.ok(
    dropped.includes('$.data[].surprise_field'),
    `dropped keys were: ${dropped.join(', ')}`,
  );
  assert.ok(dropped.includes('$.data[].another_surprise'));
});

test('a secret in an allowlisted field is masked by the redactor backstop', () => {
  const { out } = sanitizeAdversarial();
  // Token-shaped: caught by pattern even if nobody registered it.
  assert.equal(out.data[0]?.media_type, '[REDACTED]');
  // Shapeless: only exact-value redaction can catch this, which is why capture
  // scripts register the live credentials before sanitizing anything.
  assert.equal(out.data[0]?.media_product_type, '[REDACTED]');
});

test('a unicode/emoji caption is replaced by a code-point-counted placeholder', () => {
  const { out } = sanitizeAdversarial();
  const expected = `[synthetic text: ${[...EMOJI_CAPTION].length} code points removed]`;
  assert.equal(out.data[0]?.caption, expected);
  // Code points, not UTF-16 units: the ZWJ family emoji must not be counted as
  // its surrogate pairs (that would be 8 more than the authored length).
  assert.notEqual([...EMOJI_CAPTION].length, EMOJI_CAPTION.length);
});

test('URLs are replaced with a reserved, never-resolvable host', () => {
  const { out } = sanitizeAdversarial();
  for (const field of ['media_url', 'permalink']) {
    const value = out.data[0]?.[field] as string;
    assert.ok(
      value.startsWith(`https://${SYNTHETIC_URL_HOST}/`),
      `${field} must be replaced, got ${value}`,
    );
  }
  assert.notEqual(out.data[0]?.media_url, out.data[0]?.permalink);
});

// --- Synthetic-ID mapping ---------------------------------------------------

test('synthetic IDs are stable across responses within one sanitizer', () => {
  const sanitizer = createSanitizer();
  const first = sanitizer.sanitize({ data: [{ id: '17841400000000009', like_count: 1 }] }) as {
    data: Array<{ id: string }>;
  };
  const second = sanitizer.sanitize({ id: '17841400000000009', media_count: 2 }) as { id: string };
  const third = sanitizer.sanitize({ media: { id: '17841400000000009' } }) as {
    media: { id: string };
  };

  const mapped = first.data[0]?.id;
  assert.ok(mapped !== undefined && SYNTHETIC_ID_RE.test(mapped), `bad synthetic ID: ${mapped}`);
  assert.equal(second.id, mapped, 'the same real ID must map to the same synthetic ID');
  assert.equal(third.media.id, mapped, 'stability must hold at any depth');
});

test('synthetic IDs are collision-free and independent per sanitizer', () => {
  const sanitizer = createSanitizer();
  const realIds = Array.from(
    { length: 200 },
    (_, i) => `1784140000000${String(i).padStart(4, '0')}`,
  );
  const mapped = (
    sanitizer.sanitize({ data: realIds.map((id) => ({ id })) }) as {
      data: Array<{ id: string }>;
    }
  ).data.map((item) => item.id);

  assert.equal(mapped.length, realIds.length);
  assert.equal(new Set(mapped).size, realIds.length, 'distinct real IDs must never collide');
  for (const id of mapped) assert.match(id, SYNTHETIC_ID_RE);
  assert.equal(sanitizer.idMap.size, realIds.length);

  // A fresh sanitizer restarts the counter: fixtures from separate captures are
  // deliberately not cross-referenceable.
  const other = createSanitizer();
  assert.equal(
    (other.sanitize({ id: realIds[7] }) as { id: string }).id,
    '17800000000000001',
    'a new sanitizer must start its own numbering',
  );
});

test('handles are replaced with stable synthetic ones', () => {
  const sanitizer = createSanitizer();
  const out = sanitizer.sanitize({
    data: [{ username: 'real_one' }, { username: 'real_two' }, { username: 'real_one' }],
  }) as { data: Array<{ username: string }> };
  const handles = out.data.map((item) => item.username);
  assert.ok(handles.every((h) => h.startsWith(SYNTHETIC_USERNAME_PREFIX)));
  assert.equal(handles[0], handles[2]);
  assert.notEqual(handles[0], handles[1]);
});

// --- Purity & policy behavior ----------------------------------------------

test('the sanitizer never mutates its input', () => {
  const input = adversarialPayload();
  const pristine = structuredClone(input);
  sanitizeGraphResponse(input);
  assert.deepEqual(input, pristine);
});

test('an off-allowlist paging host is dropped rather than rewritten', () => {
  const out = sanitizeGraphResponse({
    paging: { next: 'https://evil.example.com/v25.0/1/media?access_token=x', cursors: {} },
  }) as { paging: { next?: string } };
  assert.equal(out.paging.next, undefined);
});

test('an unknown Graph path segment is neutralized, not echoed', () => {
  const out = sanitizeGraphResponse({
    paging: { next: 'https://graph.facebook.com/v25.0/real_handle/media?limit=5' },
  }) as { paging: { next: string } };
  assert.equal(out.paging.next, 'https://graph.facebook.com/v25.0/unknown-segment/media?limit=5');
});

test('policy overrides widen a single field without weakening the rest', () => {
  const raw = { data: [{ name: 'reach', period: 'day', values: [{ value: 12 }] }] };
  const strict = sanitizeGraphResponse(raw) as { data: Array<{ name: string }> };
  assert.match(strict.data[0]?.name ?? '', /^\[synthetic text:/);

  const widened = sanitizeGraphResponse(raw, { overrides: { name: 'keep' } }) as {
    data: Array<{ name: string; values: Array<{ value: number }> }>;
  };
  assert.equal(widened.data[0]?.name, 'reach');
  assert.equal(widened.data[0]?.values[0]?.value, 12);
});

test('findSecretLeaks pinpoints a surviving secret by path', () => {
  const leaks = findSecretLeaks({ data: [{ note: `see ${FAKE_FB_TOKEN}` }] });
  assert.deepEqual(leaks, ['$.data[0].note']);
  assert.deepEqual(findSecretLeaks({ data: [{ note: 'nothing to see' }] }), []);
});

test('assertFixtureSafe refuses a leaking fixture, naming the fixture and the path', () => {
  // The last gate a capture script passes before touching disk. A token that
  // reaches git history cannot be un-leaked, so the message has to say which
  // fixture was refused and where the leak is — an operator who only learns
  // "unsafe" will re-run the capture and get the same silent failure.
  assert.throws(
    () => assertFixtureSafe({ data: [{ id: '178', note: `see ${FAKE_FB_TOKEN}` }] }, 'media-list'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // The whole message, not two phrases from it. The pair this replaces
      // proved the fixture name and the leak path were each present somewhere
      // and said nothing about the words between or after them: "secret-shaped
      // content at" could become "possible match at", or the message could grow
      // a hint pointing at a bypass switch that does not exist, and both
      // matches stayed green. `scripts/capture-fixtures.mjs` prints this string
      // verbatim, so its wording is the operator-facing contract.
      assert.equal(
        err.message,
        'Refusing to write fixture "media-list": secret-shaped content at $.data[0].note',
      );
      return true;
    },
  );
  // The sanitizer's own output is what this gate is expected to wave through.
  assertFixtureSafe(sanitizeAdversarial().out, 'sanitized-adversarial');
});

// --- Rule engine: the arms a well-behaved capture never reaches --------------
//
// The tests above drive the sanitizer the way a capture run does. The ones below
// aim at the arms that only fire when Graph returns a shape nobody planned for —
// a scalar that grew into an object, a relative `next`, a cycle — because those
// are precisely the shapes where "it dropped the field" and "it copied the field
// verbatim" look identical from the outside.

test('an explicit `drop` override deletes a field the shared policy keeps', () => {
  // `drop` is how a capture site denies a field the shared policy allows: the
  // same key can be harmless on one endpoint and identifying on another. Without
  // the rule the field is copied verbatim by `keep`, which is the whole risk.
  const raw = { data: [{ id: REAL_MEDIA_ID, timestamp: '2026-01-02T03:04:05+0000' }] };
  const out = sanitizeGraphResponse(raw, { overrides: { timestamp: 'drop' } }) as {
    data: Array<Record<string, unknown>>;
  };
  assert.equal(out.data[0]?.timestamp, undefined, 'a dropped field must not reach the fixture');
  assert.match(out.data[0]?.id as string, SYNTHETIC_ID_RE, 'the rest of the record survives');
});

test('`keepDeep` copies a subtree verbatim but still meets the redactor backstop', () => {
  // The demographics capture opts into this for `value`: the payload is an
  // aggregate map whose KEYS are dimension values (`"US"`, `"13-17"`), not field
  // names, so the by-name allowlist has nothing to match and the default-deny
  // walk would empty it. Verbatim is only defensible because the backstop runs
  // afterwards over everything, escape hatch included.
  const raw = { data: [{ value: { US: 1201, '13-17': 4, leaked: FAKE_FB_TOKEN } }] };
  const out = sanitizeGraphResponse(raw, { overrides: { value: 'keepDeep' } }) as {
    data: Array<{ value: Record<string, unknown> }>;
  };
  assert.equal(out.data[0]?.value.US, 1201);
  assert.equal(out.data[0]?.value['13-17'], 4, 'a key the allowlist cannot name is still kept');
  assert.equal(out.data[0]?.value.leaked, '[REDACTED]', 'the backstop still runs over keepDeep');
});

test('a scalar rule applied to an array maps every element, not the array', () => {
  // `target_ids` arrives as a list. Handing the array itself to the container
  // walk would find no keys to match and copy the real IDs straight through.
  const out = sanitizeGraphResponse({
    data: [{ target_ids: ['17841400000000007', '17841400000000008', '17841400000000007'] }],
  }) as { data: Array<{ target_ids: string[] }> };

  const ids = out.data[0]?.target_ids ?? [];
  assert.equal(ids.length, 3);
  for (const id of ids) assert.match(id, SYNTHETIC_ID_RE);
  assert.notEqual(ids[0], ids[1], 'distinct real IDs stay distinct');
  assert.equal(ids[0], ids[2], 'a repeated real ID keeps its mapping inside the array too');
});

test('numeric identifiers and cursors are mapped, not waved through as numbers', () => {
  // Graph documents `user_id` as a number and returns offset-style cursors as
  // integers on some edges. A number is no less of a real identifier than its
  // string form — treating "not a string" as "not sensitive" copies it verbatim.
  const out = sanitizeGraphResponse({
    data: [{ user_id: 178414000000001 }],
    paging: { cursors: { after: 42 } },
  }) as { data: Array<{ user_id: string }>; paging: { cursors: { after: string } } };

  assert.match(out.data[0]?.user_id as string, SYNTHETIC_ID_RE);
  assert.equal(out.paging.cursors.after, `${SYNTHETIC_OPAQUE_PREFIX}1`);
});

test('a scalar rule handed a container re-enters the default-deny walk', () => {
  // Meta has turned scalars into envelopes before (`error` grew from a string
  // into an object). A field the policy classifies as scalar must therefore not
  // copy an unexpected container: it falls back to the allowlist walk, where
  // known children follow their own rule and unknown ones are dropped.
  const out = sanitizeGraphResponse({
    data: [
      {
        id: { id: REAL_MEDIA_ID, surprise: FAKE_IG_TOKEN },
        username: { username: 'the_real_operator' },
        caption: { text: 'hi' },
        media_url: { url: 'https://scontent.cdninstagram.com/v/real.jpg' },
        after: { id: '17841400000000002' },
      },
    ],
  }) as { data: Array<Record<string, Record<string, string>>> };

  const record = out.data[0] ?? {};
  assert.match(record.id?.id ?? '', SYNTHETIC_ID_RE, 'a nested id still goes through the map');
  assert.equal(record.id?.surprise, undefined, 'an unknown child of a container is dropped');
  assert.ok(record.username?.username?.startsWith(SYNTHETIC_USERNAME_PREFIX));
  assert.match(record.caption?.text ?? '', /^\[synthetic text: 2 code points removed\]$/);
  assert.ok(record.media_url?.url?.startsWith(`https://${SYNTHETIC_URL_HOST}/`));
  assert.match(record.after?.id ?? '', SYNTHETIC_ID_RE);
});

test('`keep` on a container walks it rather than smuggling its children through', () => {
  // `keep` means "this scalar is Meta vocabulary". Applied to an object it would
  // be a hole straight through the allowlist: every child, named or not, copied.
  const out = sanitizeGraphResponse({
    data: [{ count: { total_count: 3, leaked: FAKE_FB_TOKEN } }],
  }) as { data: Array<{ count: Record<string, unknown> }> };

  assert.equal(out.data[0]?.count.total_count, 3, 'a known child keeps its own rule');
  assert.equal(out.data[0]?.count.leaked, undefined, 'an unknown child is still dropped');
});

test('a paging URL that is not a string is dropped, never coerced', () => {
  // `next` is the one field whose non-string fallback is DROP rather than the
  // walk: it is where the token rides, so an unrecognised shape there is refused
  // outright instead of being picked apart for whatever looks safe.
  const out = sanitizeGraphResponse({
    paging: {
      next: { href: `https://graph.facebook.com/v25.0/me/media?access_token=${FAKE_FB_TOKEN}` },
    },
  }) as { paging: Record<string, unknown> };
  assert.equal(out.paging.next, undefined);
});

test('an unparseable paging URL is dropped rather than copied', () => {
  // A relative `next` does not parse without a base, and `new URL` throws. The
  // catch is what stops the raw string — query string and all — from being
  // copied into the fixture as "not a URL, must be harmless text".
  const out = sanitizeGraphResponse({
    paging: { next: `/v25.0/${REAL_MEDIA_ID}/media?access_token=${FAKE_FB_TOKEN}` },
  }) as { paging: Record<string, unknown> };
  assert.equal(out.paging.next, undefined);
});

test('a Graph URL whose query is entirely off-allowlist keeps only its path', () => {
  // Rebuilding from parts means the result can legitimately have no query left.
  // It must then be the bare URL: a dangling `?` is not what Graph returns and
  // makes the fixture's URL differ from the shape the client parses.
  const out = sanitizeGraphResponse({
    paging: {
      next: `https://graph.instagram.com/v25.0/me/media?access_token=${FAKE_FB_TOKEN}&fields=id,caption`,
    },
  }) as { paging: { next: string } };
  assert.equal(out.paging.next, 'https://graph.instagram.com/v25.0/me/media');
});

test('a URL under a non-alphabetic key still names a path segment', () => {
  // Insights breakdowns are keyed by dimension value (`"13-17"`), and a capture
  // may widen one of those buckets. The key becomes the synthetic URL's path
  // segment, so stripping it to nothing would emit `https://example.invalid//1`
  // — an empty segment that says nothing about which field was replaced.
  const out = sanitizeGraphResponse(
    { results: { '13-17': 'https://scontent.cdninstagram.com/v/real.jpg' } },
    { overrides: { '13-17': 'url' } },
  ) as { results: Record<string, string> };
  assert.equal(out.results['13-17'], `https://${SYNTHETIC_URL_HOST}/url/1`);
});

test('the same URL under the same field maps to one synthetic URL', () => {
  // Two records can share a thumbnail. Minting a second synthetic URL for it
  // would make the fixture claim two distinct assets where the capture saw one,
  // and a de-duplication test replaying that fixture would pass for free.
  const sanitizer = createSanitizer();
  const out = sanitizer.sanitize({
    data: [
      { thumbnail_url: 'https://scontent.cdninstagram.com/v/thumb.jpg' },
      { thumbnail_url: 'https://scontent.cdninstagram.com/v/thumb.jpg' },
      { thumbnail_url: 'https://scontent.cdninstagram.com/v/other.jpg' },
    ],
  }) as { data: Array<{ thumbnail_url: string }> };

  assert.equal(out.data[0]?.thumbnail_url, out.data[1]?.thumbnail_url);
  assert.notEqual(out.data[0]?.thumbnail_url, out.data[2]?.thumbnail_url);
});

test('a string where a container was expected is treated as free text', () => {
  // `error` is an envelope in the policy, but Graph also returns a bare message
  // string under that name. Falling through to the scalar `return value` would
  // copy it — and an error message quotes back the caller's own input.
  const out = sanitizeGraphResponse({
    error: 'Invalid OAuth access token for user the_real_operator',
  }) as { error: string };
  assert.match(out.error, /^\[synthetic text: \d+ code points removed\]$/);
});

test('a circular reference is cut instead of overflowing the stack', () => {
  // A JSON-parsed wire body cannot be cyclic, but the sanitizer is also pointed
  // at objects assembled in memory by the probe helper. A cycle there must cost
  // one dropped key, not the whole capture run.
  const node: Record<string, unknown> = { id: REAL_MEDIA_ID };
  node.media = node;
  const out = sanitizeGraphResponse({ data: [node] }) as {
    data: Array<Record<string, unknown>>;
  };
  assert.match(out.data[0]?.id as string, SYNTHETIC_ID_RE);
  assert.equal(out.data[0]?.media, undefined, 'the cycle is cut, not followed');
});

test('per-call overrides apply to that call only, and both calls share the ID map', () => {
  // One sanitizer per capture run is what makes fixtures cross-referenceable, so
  // widening `name` for the insights response must not widen it for the account
  // response captured seconds later by the same instance — `name` is a metric
  // name on one and the operator's own display name on the other.
  const sanitizer = createSanitizer();
  const insights = sanitizer.sanitize(
    { data: [{ id: REAL_MEDIA_ID, name: 'reach', period: 'day' }] },
    { name: 'keep' },
  ) as { data: Array<{ id: string; name: string }> };
  const account = sanitizer.sanitize({ id: REAL_MEDIA_ID, name: 'Ivan Real' }) as {
    id: string;
    name: string;
  };

  assert.equal(insights.data[0]?.name, 'reach');
  assert.match(account.name, /^\[synthetic text:/, 'the override did not outlive its call');
  assert.equal(account.id, insights.data[0]?.id, 'the ID mapping is shared across both calls');
});

// --- The committed fixtures directory ---------------------------------------

test('test/fixtures documents that its contents are synthetic', () => {
  const dir = fixturesDirFor(process.cwd());
  assert.ok(existsSync(dir), 'test/fixtures/ must exist');
  const readme = path.join(dir, 'README.md');
  assert.ok(existsSync(readme), 'test/fixtures/README.md must explain the directory');
  assert.match(readFileSync(readme, 'utf8'), /synthetic/i);
});

/**
 * The floor the two gates below stand on, and the one thing neither can check for
 * itself. `listFixtures()` reads the directory with a single non-recursive
 * `readdirSync` and keeps the names ending in `.json` (`test/helpers/fixtures.ts`).
 * A capture committed one directory down, or under any other extension, is
 * therefore never reported as unscanned — it is simply absent from the list, and
 * every loop below walks past it without a word. An empty directory reads the same
 * way: both gates state a per-fixture claim, and a corpus of nothing satisfies them
 * for free.
 *
 * Both facts are checked against the directory itself rather than against the
 * helper's view of it, because the discrepancy between the two is the whole defect.
 */
test('every file under test/fixtures is one the gates below can actually read', () => {
  const dir = fixturesDirFor(process.cwd());
  const onDisk = readdirSync(dir, { encoding: 'utf8', recursive: true }).filter((name) =>
    statSync(path.join(dir, name)).isFile(),
  );
  const listed = listFixtures();

  assert.ok(
    listed.length > 0,
    'test/fixtures/ holds no fixture, so both gates below report clean while reading nothing.',
  );

  // A dotfile is editor or operating-system furniture, never content. The
  // assertion after this one is what stops that exemption becoming a hiding place.
  const unreadable = onDisk
    .filter((name) => !name.startsWith('.') && name !== 'README.md' && !listed.includes(name))
    .sort();
  assert.deepEqual(
    unreadable,
    [],
    `test/fixtures/ holds file(s) listFixtures() cannot see: ${unreadable.join(', ')}. A ` +
      'capture in a subdirectory or under another extension is not reported as unswept by ' +
      'the gates below, it is invisible to them. File it beside the others as `*.json`.',
  );
  assert.deepEqual(
    listed.filter((name) => name.startsWith('.')),
    [],
    'a dotfile is exempted from the scan above, so it may not also be a fixture',
  );
});

/** Small cardinals as prose spells them; the gate below reads one back out of a comment. */
const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
});

/**
 * `normalizeDetail` in `src/api/media.ts` records an assumption it cannot settle —
 * whether Graph’s inline `children{…}` expansion carries a `paging` envelope of its
 * own — and states its reason as a fact about this directory: hand-written examples
 * only, no captured `media-detail` response, so nothing in the repository has ever
 * seen the real shape. A reason phrased as a count of files is a reason that goes
 * stale, and this one had: it still said one hand-written example after a second
 * was committed beside it.
 *
 * The count is the smaller half. The load-bearing half is the absence. The day the
 * `media-detail` capture CC-DATA-9 waits for is committed, the evidence arrives and
 * nothing points back at the paragraph saying it never did. Measured 2026-09-23:
 * committing exactly that fixture left the whole suite passing — an empty killer
 * diff — while an unreadable file in the same directory was killed by two gates.
 * The scan sees a new file perfectly well; it simply had nothing to say about this one.
 *
 * Read the failure as a tripwire, not a prohibition. A capture landing here is
 * progress; the gate fails so the paragraph is re-read against it and either
 * confirmed or deleted, instead of outliving the ignorance that justified it.
 */
test('the fixture assumption recorded in src/api/media.ts still describes this directory', () => {
  const source = readFileSync(path.join(process.cwd(), 'src', 'api', 'media.ts'), 'utf8');
  // Strip the JSDoc continuation markers before flattening the whitespace, or a
  // wrapped sentence reads `holds two hand-written * listing examples`.
  const prose = source.replace(/^[ \t]*\*[ \t]?/gm, ' ').replace(/\s+/g, ' ');

  const stated = /holds (\w+) hand-written listing examples?/.exec(prose);
  assert.notEqual(
    stated,
    null,
    'src/api/media.ts no longer states how many hand-written examples test/fixtures holds. ' +
      'The assumption that count justifies is still recorded there — reword this gate rather ' +
      'than deleting it.',
  );
  const claimed = NUMBER_WORDS[stated?.[1] ?? ''];
  assert.notEqual(
    claimed,
    undefined,
    `src/api/media.ts spells the count as "${stated?.[1] ?? ''}", which this gate cannot read`,
  );

  const handWritten = listFixtures().filter((name) => {
    const fixture = loadFixture(name);
    return typeof fixture === 'object' && fixture !== null && '_synthetic' in fixture;
  });
  // Floored on purpose: if the marker scan broke, an empty list would agree with a
  // comment claiming zero and this gate would pass for the one reason that means
  // nothing. The same floor the walk above stands on.
  assert.ok(handWritten.length > 0, 'no fixture carries the `_synthetic` marker — the scan broke');
  assert.equal(
    claimed,
    handWritten.length,
    `src/api/media.ts says test/fixtures holds ${String(claimed)} hand-written example(s); it ` +
      `holds ${String(handWritten.length)}: ${handWritten.join(', ')}.`,
  );

  assert.deepEqual(
    listFixtures().filter((name) => name.includes('media-detail')),
    [],
    'a media-detail capture is committed, so the paragraph above `normalizeDetail` in ' +
      'src/api/media.ts no longer describes this directory. Read the capture first: if its ' +
      '`children` edge carries a `paging` envelope, the flattening there is wrong (CC-DATA-9). ' +
      'Then rewrite that paragraph and this assertion together.',
  );
});

/**
 * IDs that must never be mistaken for a sanitizer’s output. The first three are
 * shaped the way Graph allocates — `178414…` and `178956…` are prefixes it really
 * issues — the fourth is a bare 17-digit run, and the last is what the minter emits
 * once its counter overruns the room {@link SYNTHETIC_ID_RE} leaves it.
 *
 * Until 2026-09-23 the pattern read `/^178\d{14}$/` and this list existed nowhere:
 * every gate asserted that a synthetic ID matches, none that a real one fails.
 * Measured that day, a fixture carrying `17895695668004550` passed all 1955 tests,
 * because `178` is also what a real ID starts with (CC-PROC-170). A pattern tested
 * in one direction only constrains nothing.
 */
const REAL_LOOKING_IDS = [
  REAL_MEDIA_ID,
  '17841400008460056',
  '17895695668004550',
  '12345678901234567',
  '178000000000100000',
] as const;

test('the synthetic-ID pattern rejects the real IDs this file hands the sanitizer', () => {
  const page = createSanitizer().sanitize({
    data: [{ id: REAL_MEDIA_ID }, { id: '17841400008460056' }],
  }) as { data: Array<{ id: string }> };
  const minted = page.data.map((node) => node.id);

  // The positive direction, taken from what the minter actually emits rather than
  // from a literal: should the two ever drift, this fails here instead of the
  // corpus gate mysteriously rejecting a freshly captured fixture.
  for (const id of minted) {
    assert.match(id, SYNTHETIC_ID_RE, `the minter emitted ${id}, which its own pattern rejects`);
  }
  assert.equal(
    new Set(minted).size,
    minted.length,
    'the minter is counter-based, so two distinct inputs may never share an output',
  );

  // The negative direction, which is the whole of what makes the pattern a gate.
  for (const real of REAL_LOOKING_IDS) {
    assert.doesNotMatch(
      real,
      SYNTHETIC_ID_RE,
      `${real} passes for a synthetic ID, so a fixture carrying it would clear every gate in ` +
        'this file. The pattern has to recognise the sanitizer’s output, not the shape of an ' +
        'Instagram ID.',
    );
  }
});

test('every committed fixture is secret-free and obviously synthetic', () => {
  for (const name of listFixtures()) {
    const fixture = loadFixture(name);
    assert.deepEqual(findSecretLeaks(fixture), [], `${name} contains secret-shaped content`);

    for (const value of allStrings(fixture)) {
      for (const run of idShapedRuns(value)) {
        assert.match(
          run,
          SYNTHETIC_ID_RE,
          `${name}: ID-shaped string "${run}" (inside "${value}") is not synthetic`,
        );
      }
      if (value.startsWith('https://') || value.startsWith('http://')) {
        const host = new URL(value).hostname;
        // `host.startsWith('graph.')` stood here until 2026-09-23 and admitted any
        // host under any registry whose name merely begins that way. The sanitizer
        // already decides which Graph hosts it will keep; judging a committed URL
        // against that same set is both narrower and impossible to drift from.
        assert.ok(
          ALLOWED_URL_HOSTS.has(host) || host.endsWith('.invalid'),
          `${name}: URL host "${host}" is neither reserved (RFC 2606 .invalid) nor one of ` +
            `the Graph hosts the sanitizer keeps (${[...ALLOWED_URL_HOSTS].join(', ')})`,
        );
      }
    }
  }
});

/**
 * {@link DEFAULT_FIELD_POLICY} restated as the partition it induces: every rule the
 * sanitizer can name, against the sorted list of keys it governs. Ninety-three keys
 * of duplication, bought deliberately — the policy IS the sanitizer’s security
 * decision, and a gate that reads the policy to judge the policy agrees with
 * whatever it finds there. Measured 2026-09-23, flipping `biography` from `text` to
 * `keep` — which lets a real bio through the sanitizer and into a committed fixture
 * — broke nothing at all, and the gate below silently stopped judging biographies,
 * because it asks the policy which rule the key has (CC-PROC-170). Restated here,
 * that flip costs two edits in two files, and the reviewer sees the second one.
 *
 * `keepDeep` and `drop` are listed empty on purpose: both are rules the sanitizer
 * can apply, and an empty list says no field is currently given them — which is a
 * claim worth breaking when it stops being true.
 */
const POLICY_PARTITION: Readonly<Record<string, readonly string[]>> = {
  keep: [
    'code',
    'comments_count',
    'count',
    'data_access_expires_at',
    'end_time',
    'error_subcode',
    'expires_at',
    'followers_count',
    'follows_count',
    'hidden',
    'is_comment_enabled',
    'is_shared_to_feed',
    'is_transient',
    'is_valid',
    'issued_at',
    'like_count',
    'limit',
    'media_count',
    'media_product_type',
    'media_type',
    'period',
    'quota_duration',
    'quota_total',
    'scope',
    'scopes',
    'status_code',
    'success',
    'timestamp',
    'total_count',
    'type',
  ],
  keepDeep: [],
  id: [
    'account_id',
    'app_id',
    'comment_id',
    'container_id',
    'creation_id',
    'hashtag_id',
    'id',
    'ig_id',
    'media_id',
    'owner_id',
    'page_id',
    'parent_id',
    'target_ids',
    'user_id',
  ],
  username: ['username'],
  text: [
    'application',
    'biography',
    'caption',
    'category',
    'description',
    'error_user_msg',
    'error_user_title',
    'message',
    'name',
    'status',
    'text',
    'title',
  ],
  url: [
    'image_url',
    'link',
    'media_url',
    'permalink',
    'picture',
    'profile_pic_url',
    'profile_picture_url',
    'thumbnail_url',
    'url',
    'video_url',
    'website',
  ],
  graphUrl: ['next', 'previous'],
  opaque: ['after', 'before', 'fbtrace_id'],
  recurse: [
    'breakdowns',
    'business_discovery',
    'children',
    'config',
    'cursors',
    'data',
    'dimension_values',
    'error',
    'from',
    'granular_scopes',
    'instagram_business_account',
    'media',
    'paging',
    'quota_usage',
    'replies',
    'results',
    'summary',
    'total_value',
    'value',
    'values',
  ],
  drop: [],
};

test('the sanitizer field policy is the partition this file agreed to', () => {
  const grouped: Record<string, string[]> = Object.fromEntries(
    Object.keys(POLICY_PARTITION).map((rule) => [rule, [] as string[]]),
  );
  for (const [key, rule] of Object.entries(DEFAULT_FIELD_POLICY)) {
    const bucket = grouped[rule];
    assert.ok(
      bucket !== undefined,
      `the policy gives "${key}" the rule "${rule}", which this file does not list. Add the ` +
        'rule to POLICY_PARTITION — and decide whether the gates below owe it a branch.',
    );
    bucket?.push(key);
  }
  for (const keys of Object.values(grouped)) keys.sort();

  assert.deepEqual(
    grouped,
    Object.fromEntries(Object.entries(POLICY_PARTITION).map(([rule, keys]) => [rule, [...keys]])),
    'the sanitizer’s field policy no longer matches the one restated above. Every key there ' +
      'is a decision about what may reach disk, so moving one between rules changes what this ' +
      'repository will commit: it takes an edit in both places, on purpose.',
  );
});

/**
 * The rules {@link DEFAULT_FIELD_POLICY} may name, for which the gate below writes
 * a branch, and the number of such branches read back out of this file's own
 * source. Both halves of the pair are load-bearing: a rule listed here that no
 * fixture carries is a branch that never runs, and a branch written below without
 * a line here is a claim this file makes about a field it never sees. A hand list
 * five lines from the code it mirrors is exactly the kind that stops mirroring it,
 * so the branches are scraped rather than typed.
 *
 * What is scraped is the rule NAMES. Until 2026-09-23 only the number of branch
 * sites was, and a count agrees with any three rules whatsoever: measured that day,
 * retargeting the `opaque` branch at `keepDeep` — a rule no field in the policy
 * carries — left the count at three, the coverage assertion below satisfied by a
 * name it no longer branched on, and the suite green (CC-PROC-170). The regex still
 * cannot match itself: its source spells the parenthesis `\\(`, not `(`.
 */
const BRANCHED_RULES = ['username', 'text', 'opaque'] as const;
const BRANCHED_RULE_SITES = [
  ...readFileSync(fileURLToPath(import.meta.url), 'utf8').matchAll(
    /if \(rule === '([a-zA-Z]+)'\)/g,
  ),
].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

/**
 * The checks above cover the shapes a scanner can recognise — token-like strings,
 * long digit runs, real hosts. A real **handle** or a real **caption** has no such
 * shape: `ivan.real.handle` is not ID-shaped, not a URL and not token-shaped, so
 * every gate above would wave it through. What identifies those is not their shape
 * but the field they sit in, which is exactly what the sanitizer's policy already
 * knows. Deriving the field list from {@link DEFAULT_FIELD_POLICY} rather than
 * restating it keeps this gate honest when the policy grows a new text field.
 */
test('committed fixtures carry synthetic handles and synthetic free text', () => {
  const SYNTHETIC_TEXT_RE = /^\[synthetic text: \d+ code points removed\]$/;
  const exercised = new Set<string>();

  for (const name of listFixtures()) {
    for (const { key, value } of labeledStrings(loadFixture(name))) {
      const rule = DEFAULT_FIELD_POLICY[key];
      // The sanitizer is default-deny: a field it does not recognise is dropped
      // rather than copied through, because an unrecognised field is precisely
      // where a handle or a token hides. Judging only the keys the policy names
      // inverts that, which would make the sanitizer's strictest case this gate's
      // one blind spot — and a hand-written example never passed through the
      // sanitizer at all, so nothing else stands between it and the repository.
      // The provenance marker is the single documented exception (see
      // test/fixtures/README.md: a hand-written example carries a top-level
      // `_synthetic`), written as a rule so a second marker needs no edit here.
      assert.ok(
        rule !== undefined || key.startsWith('_'),
        `${name}: "${key}" is in no sanitizer policy, so nothing here judged its value ` +
          `("${value}"). The sanitizer drops a key it does not know; a fixture may not ` +
          'carry one back in by hand.',
      );
      if (rule !== undefined) exercised.add(rule);
      if (rule === 'username') {
        assert.ok(
          value.startsWith(SYNTHETIC_USERNAME_PREFIX),
          `${name}: handle at "${key}" is "${value}", not a synthetic ${SYNTHETIC_USERNAME_PREFIX}* handle`,
        );
      }
      if (rule === 'text') {
        assert.match(value, SYNTHETIC_TEXT_RE, `${name}: free text at "${key}" is not synthetic`);
      }
      if (rule === 'opaque') {
        assert.ok(
          value.startsWith(SYNTHETIC_OPAQUE_PREFIX),
          `${name}: opaque value at "${key}" is "${value}", not a synthetic placeholder`,
        );
      }
    }
  }

  // Every branch above is a conditional over a committed corpus, so whether it
  // ever runs is a property of the repository rather than of a particular run.
  // Until a fixture carried a handle, the handle branch was unreachable and
  // deleting it would have cost nothing — which is the state this file was in
  // before test/fixtures/example-list-comments.json was committed.
  assert.deepEqual(
    [...BRANCHED_RULE_SITES].sort(),
    [...BRANCHED_RULES].sort(),
    `this test branches on ${BRANCHED_RULE_SITES.join(', ')} but names ` +
      `${BRANCHED_RULES.join(', ')}. A branch nothing here names is unaccounted for, and a ` +
      'name nothing branches on makes the coverage assertion below vacuous: add its rule to ' +
      'BRANCHED_RULES, or point the branch back at a rule the policy actually gives a field.',
  );
  for (const rule of BRANCHED_RULES) {
    assert.ok(
      exercised.has(rule),
      `no committed fixture carries a \`${rule}\` field, so the branch guarding it never ` +
        'ran and this test asserts nothing about such a field. Commit a synthetic fixture ' +
        'that carries one rather than dropping the branch.',
    );
  }
});
