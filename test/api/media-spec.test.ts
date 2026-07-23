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
