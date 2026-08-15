/**
 * Unit tests for the client-side media validators (src/api/media-spec.ts).
 * Pure functions, no network: caption code-point/hashtag/mention limits, the
 * https URL guard, the non-JPEG format hint, carousel bounds, and the container
 * media_type enum. These encode the SSRF reality — only structural checks are
 * possible before Instagram fetches the URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import {
  analyzeCaption,
  assertCaptionWithinLimits,
  assertCarouselSize,
  assertHttpsUrl,
  containerMediaTypeSchema,
  httpsUrlSchema,
  imageUrlFormatWarning,
  isHttpsUrl,
  userTagSchema,
  CAROUSEL_MAX,
  CAROUSEL_MIN,
  CONTAINER_MEDIA_TYPES,
  MAX_CAPTION_CODEPOINTS,
  MAX_HASHTAGS,
  MAX_MENTIONS,
} from '../../src/api/media-spec.js';

// --- caption analysis -------------------------------------------------------

test('analyzeCaption counts code points, hashtags, and mentions', () => {
  const stats = analyzeCaption('Hello #sun #sea @alice @bob.smith');
  assert.equal(stats.hashtags, 2);
  assert.equal(stats.mentions, 2);
  assert.equal(stats.codePoints, [...'Hello #sun #sea @alice @bob.smith'].length);
});

test('analyzeCaption counts an emoji as a single code point, not UTF-16 units', () => {
  // A rocket emoji is one code point but two UTF-16 units.
  const stats = analyzeCaption('gm 🚀');
  assert.equal(stats.codePoints, 4);
});

test('assertCaptionWithinLimits returns stats when a caption is within every limit', () => {
  const stats = assertCaptionWithinLimits('a nice #caption with @one mention');
  assert.equal(stats.hashtags, 1);
  assert.equal(stats.mentions, 1);
});

test('assertCaptionWithinLimits throws (validation) over the code-point cap', () => {
  const long = 'x'.repeat(MAX_CAPTION_CODEPOINTS + 1);
  assert.throws(
    () => assertCaptionWithinLimits(long),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
});

test('assertCaptionWithinLimits accepts a caption exactly at the code-point cap', () => {
  const exact = 'y'.repeat(MAX_CAPTION_CODEPOINTS);
  const stats = assertCaptionWithinLimits(exact);
  assert.equal(stats.codePoints, MAX_CAPTION_CODEPOINTS);
});

test('assertCaptionWithinLimits throws over the hashtag cap', () => {
  const many = Array.from({ length: MAX_HASHTAGS + 1 }, (_v, i) => `#t${i}`).join(' ');
  assert.throws(
    () => assertCaptionWithinLimits(many),
    (e: unknown) =>
      e instanceof InstagramError && e.kind === 'validation' && /hashtag/.test(e.message),
  );
});

test('assertCaptionWithinLimits throws over the mention cap', () => {
  const many = Array.from({ length: MAX_MENTIONS + 1 }, (_v, i) => `@u${i}`).join(' ');
  assert.throws(
    () => assertCaptionWithinLimits(many),
    (e: unknown) =>
      e instanceof InstagramError && e.kind === 'validation' && /mention/.test(e.message),
  );
});

// --- caption limits: boundaries pinned to literals --------------------------

test('the caption limits are the exact numbers Instagram documents', () => {
  // These three numbers are the contract, not an implementation detail — they are
  // quoted verbatim in the tool descriptions and in docs/tools.md. Every other test
  // in this section is written in terms of the constants, so a cap that silently
  // widened would drag them all along and the operator would first learn the real
  // limit from a container Meta rejected after the quota slot was already spent.
  assert.equal(MAX_CAPTION_CODEPOINTS, 2200);
  assert.equal(MAX_HASHTAGS, 30);
  assert.equal(MAX_MENTIONS, 20);
});

test('assertCaptionWithinLimits rejects the first caption past 2200 code points', () => {
  // 2200 is accepted, 2201 is refused, and the refusal names both numbers so the
  // operator can trim by hand. A cap loosened past Instagram's own turns this free
  // client-side check into a no-op: the caption reaches Meta, the container create
  // fails with an opaque Graph error, and one of the 25 publishes per 24 hours is
  // gone with nothing published.
  assert.doesNotThrow(() => assertCaptionWithinLimits('x'.repeat(2200)));
  assert.throws(
    () => assertCaptionWithinLimits('x'.repeat(2201)),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message === 'Caption exceeds 2200 characters (got 2201).',
  );
});

test('the 2200 cap counts code points, so an all-emoji caption is not halved', () => {
  // 2200 rockets are 2200 code points but 4400 UTF-16 units. Counting `.length`
  // instead would reject a caption Instagram publishes happily, and emoji-dense
  // captions are the normal case for this product — the server would become the
  // thing blocking a legal post, with no override and no explanation the operator
  // could act on.
  const exactly = '🚀'.repeat(2200);
  assert.equal(exactly.length, 4400);
  assert.deepEqual(assertCaptionWithinLimits(exactly), {
    codePoints: 2200,
    hashtags: 0,
    mentions: 0,
  });
  assert.throws(
    () => assertCaptionWithinLimits('🚀'.repeat(2201)),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message === 'Caption exceeds 2200 characters (got 2201).',
  );
});

test('assertCaptionWithinLimits accepts exactly 30 hashtags and rejects the 31st', () => {
  // 30 hashtags is a caption Instagram accepts. Refusing it — an off-by-one in the
  // guard — makes this server the thing blocking a legal post, with no override for
  // the operator. The mirror failure, letting 31 through or widening the cap, spends
  // a publish slot on a container Meta then refuses.
  const thirty = Array.from({ length: 30 }, (_v, i) => `#tag${i}`).join(' ');
  assert.deepEqual(assertCaptionWithinLimits(thirty), {
    codePoints: 199,
    hashtags: 30,
    mentions: 0,
  });
  assert.throws(
    () => assertCaptionWithinLimits(`${thirty} #onetoomany`),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message === 'Caption has more than 30 hashtags (got 31).',
  );
});

test('assertCaptionWithinLimits accepts exactly 20 @mentions and rejects the 21st', () => {
  // The same boundary on the other axis. An over-tight guard blocks a caption that
  // would have published; a loose one lets a caption Instagram will reject consume
  // one of the 25 publishes available per 24 hours, and the operator only finds out
  // from the container-create failure, after the fact.
  const twenty = Array.from({ length: 20 }, (_v, i) => `@user${i}`).join(' ');
  assert.deepEqual(assertCaptionWithinLimits(twenty), {
    codePoints: 149,
    hashtags: 0,
    mentions: 20,
  });
  assert.throws(
    () => assertCaptionWithinLimits(`${twenty} @onetoomany`),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message === 'Caption has more than 20 @mentions (got 21).',
  );
});

test('analyzeCaption counts hashtags that contain digits and underscores', () => {
  // `#2026`, `#_draft` and `#tag_1` are tags people actually post. Narrow the
  // pattern to letters only and they stop being counted at all: the 30-hashtag
  // guard silently stops guarding, and a caption carrying forty numeric campaign
  // tags walks past the client check into a container Instagram refuses.
  assert.deepEqual(analyzeCaption('#2026 #_draft #tag_1 #日本語'), {
    codePoints: 25,
    hashtags: 4,
    mentions: 0,
  });
});

test('analyzeCaption counts @mentions of capitalised handles', () => {
  // Handles are case-insensitive on Instagram and brands are written capitalised
  // (`@NASA`, `@BBCNews`). A lowercase-only pattern under-counts every caption that
  // tags one, so the 20-mention guard waves through captions Meta rejects — again
  // only after the publish slot is gone.
  assert.deepEqual(analyzeCaption('@Alice @BOB @carol'), {
    codePoints: 18,
    hashtags: 0,
    mentions: 3,
  });
});

// --- URL validation ---------------------------------------------------------

test('isHttpsUrl accepts https and rejects http, ftp, and garbage', () => {
  assert.equal(isHttpsUrl('https://cdn.example.com/a.jpg'), true);
  assert.equal(isHttpsUrl('http://example.com/a.jpg'), false);
  assert.equal(isHttpsUrl('ftp://example.com/a.jpg'), false);
  assert.equal(isHttpsUrl('not a url'), false);
});

test('assertHttpsUrl throws (validation) naming the field on a non-https URL', () => {
  assert.throws(
    () => assertHttpsUrl('http://example.com/a.jpg', 'imageUrl'),
    (e: unknown) =>
      e instanceof InstagramError && e.kind === 'validation' && /imageUrl/.test(e.message),
  );
});

test('assertHttpsUrl passes for a well-formed https URL', () => {
  assert.doesNotThrow(() => assertHttpsUrl('https://example.com/a.jpg', 'imageUrl'));
});

test('imageUrlFormatWarning warns on a clearly non-JPEG extension but not on jpg/jpeg', () => {
  assert.ok(imageUrlFormatWarning('https://example.com/pic.png')?.includes('non-JPEG'));
  assert.ok(imageUrlFormatWarning('https://example.com/pic.webp'));
  assert.equal(imageUrlFormatWarning('https://example.com/pic.jpg'), undefined);
  assert.equal(imageUrlFormatWarning('https://example.com/pic.jpeg'), undefined);
});

test('imageUrlFormatWarning stays silent when the extension is absent or ambiguous', () => {
  assert.equal(imageUrlFormatWarning('https://example.com/image'), undefined);
  assert.equal(imageUrlFormatWarning('https://example.com/photo?id=5'), undefined);
  assert.equal(imageUrlFormatWarning('not a url'), undefined);
});

test('imageUrlFormatWarning ignores query strings and is case-insensitive on the extension', () => {
  assert.ok(imageUrlFormatWarning('https://example.com/pic.PNG?width=1080'));
});

/**
 * The exact warning {@link imageUrlFormatWarning} returns for extension `ext`,
 * restated here rather than imported so a reworded warning has to be re-approved.
 */
function expectedFormatWarning(ext: string): string {
  return (
    `URL extension ".${ext}" suggests a non-JPEG image; Instagram feed images must be JPEG. ` +
    'Format, byte size, and dimensions cannot be verified before Instagram fetches the URL.'
  );
}

test('every extension in the clearly-not-JPEG list produces the exact warning', () => {
  // This hint is the only pre-flight signal that the operator is about to spend a
  // publish slot on a container Instagram will refuse for format. `.heic` is the
  // entry that matters most in practice — it is what an iPhone photo is called
  // before anyone converts it — and dropping any single entry makes the warning
  // quietly stop appearing for that format, with nothing failing and nothing logged.
  for (const ext of ['png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'svg']) {
    assert.equal(
      imageUrlFormatWarning(`https://cdn.example.com/pic.${ext}`),
      expectedFormatWarning(ext),
      `".${ext}" must warn`,
    );
  }
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/pic.jpg'), undefined);
});

test('imageUrlFormatWarning reads the extension after the LAST dot, not the first', () => {
  // Versioned and dated CDN filenames (`summer.v2.png`) are ordinary. Split on the
  // first dot and the extension becomes `v2.png`, which matches nothing in the list,
  // so a PNG travels to Meta unflagged and the operator loses the one warning that
  // would have saved the publish slot.
  assert.equal(
    imageUrlFormatWarning('https://cdn.example.com/photos/summer.v2.png'),
    expectedFormatWarning('png'),
  );
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/photos/summer.v2.jpg'), undefined);
});

test('httpsUrlSchema rejects every non-https URL with its exact message', () => {
  // This schema is what validates `imageUrl`/`videoUrl`/`coverUrl` before any tool
  // body runs, and the server never fetches those URLs itself — so the scheme check
  // IS the control, not a convenience. Neutered, it forwards `http://` (and worse)
  // to Meta, and the SSRF promise in docs/security.md becomes untrue with nothing
  // in the logs to show for it.
  assert.equal(httpsUrlSchema.safeParse('https://cdn.example.com/a.jpg').success, true);
  for (const bad of ['http://cdn.example.com/a.jpg', 'ftp://example.com/a.jpg', 'not a url']) {
    const result = httpsUrlSchema.safeParse(bad);
    assert.equal(result.success, false, `"${bad}" must be rejected`);
    const message = result.success ? '' : (result.error.issues[0]?.message ?? '');
    assert.equal(message, 'must be a well-formed https:// URL');
  }
});

// --- carousel bounds --------------------------------------------------------

test('assertCarouselSize accepts the inclusive 2–10 range and rejects outside it', () => {
  assert.doesNotThrow(() => assertCarouselSize(CAROUSEL_MIN));
  assert.doesNotThrow(() => assertCarouselSize(CAROUSEL_MAX));
  assert.throws(
    () => assertCarouselSize(CAROUSEL_MIN - 1),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
  assert.throws(
    () => assertCarouselSize(CAROUSEL_MAX + 1),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
});

test('the carousel bounds are exactly 2 and 10, both sides pinned', () => {
  // A one-item "carousel" is not a carousel: the create call would go out with a
  // CAROUSEL media_type and a single child and fail at Meta after the child
  // containers had already been created and paid for. An eleventh child fails the
  // same way. The range test above is written in terms of the constants and follows
  // them anywhere they move, so these are asserted against literals.
  assert.equal(CAROUSEL_MIN, 2);
  assert.equal(CAROUSEL_MAX, 10);
  assert.doesNotThrow(() => assertCarouselSize(2));
  assert.doesNotThrow(() => assertCarouselSize(10));
  assert.throws(
    () => assertCarouselSize(1),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message === 'A carousel needs 2–10 items (got 1).',
  );
  assert.throws(
    () => assertCarouselSize(11),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message === 'A carousel needs 2–10 items (got 11).',
  );
});

// --- media_type enum & user tags -------------------------------------------

test('containerMediaTypeSchema accepts REELS/STORIES/CAROUSEL and rejects IMAGE/VIDEO', () => {
  assert.deepEqual([...CONTAINER_MEDIA_TYPES], ['REELS', 'STORIES', 'CAROUSEL']);
  for (const t of CONTAINER_MEDIA_TYPES)
    assert.equal(containerMediaTypeSchema.safeParse(t).success, true);
  // A feed image sends NO media_type, so IMAGE is intentionally not a valid value.
  assert.equal(containerMediaTypeSchema.safeParse('IMAGE').success, false);
  assert.equal(containerMediaTypeSchema.safeParse('VIDEO').success, false);
});

test('userTagSchema requires a username and bounds coordinates to 0–1', () => {
  assert.equal(userTagSchema.safeParse({ username: 'alice' }).success, true);
  assert.equal(userTagSchema.safeParse({ username: 'alice', x: 0.5, y: 0.9 }).success, true);
  assert.equal(userTagSchema.safeParse({ username: '' }).success, false);
  assert.equal(userTagSchema.safeParse({ username: 'alice', x: 1.5 }).success, false);
});

test('userTagSchema bounds BOTH coordinates to 0–1, not just x', () => {
  // x and y are relative positions on the image and Meta rejects anything outside
  // 0-1. Leave y unbounded and a tag at y: 42 is accepted here, the container create
  // fails at Meta with an error that names no field, and the operator is left
  // guessing which of their tags was wrong instead of being told before the request
  // ever left the machine.
  assert.equal(userTagSchema.safeParse({ username: 'alice', x: 0, y: 0 }).success, true);
  assert.equal(userTagSchema.safeParse({ username: 'alice', x: 1, y: 1 }).success, true);
  assert.equal(userTagSchema.safeParse({ username: 'alice', y: 1.5 }).success, false);
  assert.equal(userTagSchema.safeParse({ username: 'alice', y: -0.1 }).success, false);
  assert.equal(userTagSchema.safeParse({ username: 'alice', x: -0.1 }).success, false);
});
