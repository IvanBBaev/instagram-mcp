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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
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

/** A realistic `{data, paging}` page with every leak vector planted in it. */
function adversarialPayload(): Record<string, unknown> {
  return {
    data: [
      {
        id: '17841400000000001',
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
        'https://graph.facebook.com/v25.0/17841400000000001/media' +
        `?access_token=${FAKE_FB_TOKEN}&appsecret_proof=${FAKE_PROOF}` +
        '&after=QVFIUmVhbEFmdGVy&limit=25&fields=id,caption,media_url',
      previous:
        'https://graph.facebook.com/v25.0/17841400000000001/media?before=QVFIUmVhbEJlZm9yZQ==',
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
      assert.match(err.message, /Refusing to write fixture "media-list"/);
      assert.match(err.message, /\$\.data\[0\]\.note/);
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
  const raw = { data: [{ id: '17841400000000001', timestamp: '2026-01-02T03:04:05+0000' }] };
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
        id: { id: '17841400000000001', surprise: FAKE_IG_TOKEN },
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
    paging: { next: `/v25.0/17841400000000001/media?access_token=${FAKE_FB_TOKEN}` },
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
  const node: Record<string, unknown> = { id: '17841400000000001' };
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
    { data: [{ id: '17841400000000001', name: 'reach', period: 'day' }] },
    { name: 'keep' },
  ) as { data: Array<{ id: string; name: string }> };
  const account = sanitizer.sanitize({ id: '17841400000000001', name: 'Ivan Real' }) as {
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

test('every committed fixture is secret-free and obviously synthetic', () => {
  for (const name of listFixtures()) {
    const fixture = loadFixture(name);
    assert.deepEqual(findSecretLeaks(fixture), [], `${name} contains secret-shaped content`);

    for (const value of allStrings(fixture)) {
      const digits = /^\d{15,}$/.exec(value);
      if (digits !== null) {
        assert.match(
          value,
          SYNTHETIC_ID_RE,
          `${name}: ID-shaped string "${value}" is not synthetic`,
        );
      }
      if (value.startsWith('https://') || value.startsWith('http://')) {
        const host = new URL(value).hostname;
        assert.ok(
          host === SYNTHETIC_URL_HOST || host.endsWith('.invalid') || host.startsWith('graph.'),
          `${name}: URL host "${host}" is neither reserved nor a Graph host`,
        );
      }
    }
  }
});

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

  for (const name of listFixtures()) {
    for (const { key, value } of labeledStrings(loadFixture(name))) {
      const rule = DEFAULT_FIELD_POLICY[key];
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
});
