/**
 * Unit tests for the client-side media validators (src/api/media-spec.ts).
 * Pure functions, no network: caption code-point/hashtag/mention limits, the
 * https URL guard, the non-JPEG format hint, carousel bounds, and the container
 * media_type enum. These encode the SSRF reality — only structural checks are
 * possible before Instagram fetches the URL.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
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

// --- Hermetic guard ---------------------------------------------------------

/**
 * This module's whole reason to exist is that the server never fetches a
 * user-supplied media URL (SSRF policy — docs/security.md): it decides on the
 * URL *string*, never on what is behind it. A module-level trap makes that
 * structural rather than a claim in a comment — if any validator here ever grew
 * a "let me just HEAD the URL to check the format" shortcut, it would be handed
 * an attacker-chosen URL and would die offline with a named error instead of
 * quietly turning this process into a request proxy.
 */
const realFetch = globalThis.fetch;
const offlineFetch: typeof fetch = () => {
  throw new Error('offline: media-spec validators must never fetch a user-supplied URL');
};
globalThis.fetch = offlineFetch;
after(() => {
  globalThis.fetch = realFetch;
});

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

test('a lone # or @ is punctuation, not a token', () => {
  // Captions in this product are written by a model and read by a human, and prose
  // like "call me @ 5pm" is ordinary. If a bare sigil (or a sigil followed by a space)
  // were counted, every such caption would drift toward the 30/20 caps from noise
  // alone: the server would start refusing captions Instagram publishes happily, the
  // refusal names a number the operator cannot reconcile with what they can see, and
  // there is no override — the post simply does not go out.
  assert.deepEqual(analyzeCaption('call me @ 5pm # ready'), {
    codePoints: 21,
    hashtags: 0,
    mentions: 0,
  });
});

test('analyzeCaption counts handles that begin with a digit, dot, or underscore', () => {
  // `@_night`, `@2026`, `@.tag` are all handles Instagram issues. A mention pattern
  // that drops any one class member under-counts silently — the 20-mention guard stops
  // guarding for exactly the captions that use those handles, so a caption Meta will
  // reject sails through the free client check and burns one of the day's publishes.
  // The trailing "@ home" additionally pins that an empty match is never a mention.
  assert.deepEqual(analyzeCaption('@_night @2026 @.tag @b and mail me @ home'), {
    codePoints: 41,
    hashtags: 0,
    mentions: 4,
  });
});

test('the caption is measured exactly as it will be sent, whitespace included', () => {
  // Nothing trims the caption between here and the Graph request, so the length this
  // guard measures must be the length Meta receives. Measure a trimmed copy and a
  // caption that is 2200 visible characters plus padding passes the check and is then
  // refused at container-create — the one failure mode this whole module exists to
  // prevent, and the one that costs a publish slot to discover.
  assert.equal(analyzeCaption('  hi  ').codePoints, 6);
  assert.throws(
    () => assertCaptionWithinLimits(` ${'x'.repeat(2200)}`),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message === 'Caption exceeds 2200 characters (got 2201).',
  );
});

test('a caption that breaks several limits is refused for its length first', () => {
  // The three checks run in a fixed order and the operator only ever sees the first
  // failure. Length is the one that cannot be fixed by deleting a few tags, so it has
  // to be reported first; reorder them and a 2408-character caption comes back as a
  // hashtag complaint, the operator trims tags, resubmits, and is refused again — a
  // loop that costs a round trip each time and never names the real problem.
  const tags = Array.from({ length: 31 }, (_v, i) => `#tag${i}`).join(' ');
  assert.throws(
    () => assertCaptionWithinLimits(`${'x'.repeat(2201)} ${tags}`),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message === 'Caption exceeds 2200 characters (got 2408).',
  );
});

test('a caption over both token caps is refused for its hashtags, not its mentions', () => {
  // The second and third checks are ordered too, and only the first failure is ever
  // shown. Swap them and a caption carrying 31 tags and 21 mentions comes back as a
  // mention complaint: the operator deletes mentions — the part Instagram was going
  // to render as links to real accounts — resubmits, and is refused again for the
  // tags that were the actual problem all along. The length test above pins the
  // first position in that order; this pins the other two against each other.
  const tags = Array.from({ length: 31 }, (_v, i) => `#tag${i}`).join(' ');
  const mentions = Array.from({ length: 21 }, (_v, i) => `@user${i}`).join(' ');
  assert.deepEqual(analyzeCaption(`${tags} ${mentions}`), {
    codePoints: 364,
    hashtags: 31,
    mentions: 21,
  });
  assert.throws(
    () => assertCaptionWithinLimits(`${tags} ${mentions}`),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message === 'Caption has more than 30 hashtags (got 31).',
  );
});

test('analyzeCaption is stateless: the shared /g regexes carry no lastIndex between calls', () => {
  // HASHTAG_RE and MENTION_RE are module-level `/g` regexes shared by every call, and
  // a global regex is stateful under `test`/`exec`. `String.prototype.match` is the
  // one API that zeroes `lastIndex` before it collects, which is why it is used — but
  // that is a property of the call, not of the regex, and the rewrites this shape
  // invites (`while (re.test(s))`, `re.exec(s)` until null) do not have it. Under one
  // of those, the SECOND publish in a session would count a different number of
  // hashtags than the first for the identical caption: the 30-tag guard would start
  // firing on captions it just accepted, or stop firing on ones it just refused, and
  // nothing in the failure would point at a regex. Proven rather than assumed.
  const caption = '#a #b #c @x @y';
  const first = analyzeCaption(caption);
  assert.deepEqual(first, { codePoints: 14, hashtags: 3, mentions: 2 });
  for (let i = 0; i < 5; i += 1) {
    // Interleave a different caption so a stale index would have somewhere to come from.
    analyzeCaption('#other @handle and some longer trailing text');
    assert.deepEqual(analyzeCaption(caption), first, `call ${i} must match the first`);
  }
});

test('the 2200 cap counts code points, not graphemes: a ZWJ emoji costs seven', () => {
  // A family emoji is ONE thing on screen and seven code points on the wire
  // (four people joined by three U+200D). Instagram's limit is on the wire form, so
  // counting graphemes — the tempting "fix" via Intl.Segmenter — would accept a
  // caption of ~314 family emoji that Meta then rejects at container create, and the
  // operator would be staring at a caption they can count on their fingers. A lone
  // surrogate (a caption truncated mid-emoji by some upstream tool) is one unit, and
  // a decomposed accent is two: this guard measures units, never appearances.
  // Written as escapes so no assertion here can drift with the file's own encoding.
  const family = '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
  assert.equal([...family].length, 7);
  assert.equal(family.length, 11);
  assert.deepEqual(analyzeCaption(`family ${family}`), {
    codePoints: 14,
    hashtags: 0,
    mentions: 0,
  });
  assert.equal(analyzeCaption('cafe\u0301').codePoints, 5);
  assert.equal(analyzeCaption('a\uD83Db').codePoints, 3);
});

test('an email address is counted as a mention, deliberately', () => {
  // The counter is documented as best-effort and over-counting: it exists to stop an
  // obviously-invalid caption before it costs a Graph call, not to reproduce
  // Instagram's parser. `ivan@example.com` yields one "mention" and that is the
  // accepted price — tightening it with a lookbehind would be a real behaviour change
  // (captions right at the 20-mention line would start passing) and needs to be a
  // decision, not a drive-by. Pinned so it has to be one.
  assert.deepEqual(analyzeCaption('write to me at ivan@example.com please'), {
    codePoints: 38,
    hashtags: 0,
    mentions: 1,
  });
});

test('a rejected caption is described by numbers only — never quoted back', () => {
  // Captions are model-authored and can contain anything the operator pasted into the
  // conversation. These three messages travel to the model through `errorResult` and
  // into the operator's log, so quoting even a fragment of the caption would turn a
  // client-side length check into a copy of arbitrary text in a second sink. The
  // messages name the limit and the count and stop there.
  const secret = 'EAAsecretlookingtokenvalue1234567890';
  for (const caption of [
    `${secret} ${'x'.repeat(2201)}`,
    `${secret} ${Array.from({ length: 31 }, (_v, i) => `#t${i}`).join(' ')}`,
    `${secret} ${Array.from({ length: 21 }, (_v, i) => `@u${i}`).join(' ')}`,
  ]) {
    assert.throws(
      () => assertCaptionWithinLimits(caption),
      (e: unknown) =>
        e instanceof InstagramError &&
        e.kind === 'validation' &&
        !e.message.includes(secret) &&
        !e.message.includes('EAA'),
    );
  }
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

test('isHttpsUrl parses the URL instead of matching an "https://" prefix', () => {
  // The scheme check is the SSRF control (docs/security.md): the server never fetches
  // these URLs, so "is it https" is decided here once and trusted downstream. A textual
  // prefix test and a parse disagree in both directions — `HTTPS://` is a perfectly
  // valid https URL that a prefix test rejects, and a string can start with `https://`
  // while parsing to something else entirely. Deciding scheme by substring is how a
  // scheme check gets bypassed, so the parse is pinned here explicitly.
  // (`https:/cdn…` used to be pinned here as accepted too; it is the parser
  // repairing a missing slash, and is refused since CC-PUB-58 — see below.)
  assert.equal(isHttpsUrl('HTTPS://cdn.example.com/a.jpg'), true);
  assert.equal(isHttpsUrl('https://'), false);
});

test('a URL the parser has to re-slash before it reads a host is not the URL that gets forwarded (CC-PUB-58)', () => {
  // For https the WHATWG parser repairs the authority delimiter: one slash, no
  // slash, three slashes and backslashes all come out as `https://cdn…/`. The
  // tools forward the RAW string, and an RFC 3986 reader of `https:/cdn/a.jpg`
  // finds no host at all — Meta would be asked to fetch a URL whose verdict was
  // earned by a different string. Each shape is refused through all three entry
  // points with the ordinary wording.
  for (const url of [
    'https:/cdn.example.com/a.jpg',
    'https:cdn.example.com/a.jpg',
    'https:///cdn.example.com/a.jpg',
    'https:\\\\cdn.example.com\\a.jpg',
    'https:/\\cdn.example.com/a.jpg',
    'https://cdn.example.com\\a.jpg',
    'https://cdn.example.com/photos\\a.jpg?v=1',
    // A later `://` in the query must not stand in for the missing one.
    'https:/cdn.example.com/a.jpg?next=https://cdn.example.com/b',
  ]) {
    assert.equal(isHttpsUrl(url), false, JSON.stringify(url));
    assert.throws(
      () => assertHttpsUrl(url, 'imageUrl'),
      (e: unknown) =>
        e instanceof InstagramError &&
        e.kind === 'validation' &&
        e.message ===
          'imageUrl must be a well-formed https:// URL (Instagram fetches media over HTTPS).',
      JSON.stringify(url),
    );
    assert.equal(httpsUrlSchema.safeParse(url).success, false, JSON.stringify(url));
  }
  // A backslash in the query or fragment is kept verbatim by the parser, so the
  // forwarded string names the same resource and it stays accepted, as do a
  // `://` inside the query and an upper-case scheme.
  assert.equal(isHttpsUrl('https://cdn.example.com/a.jpg?sig=a\\b'), true);
  assert.equal(isHttpsUrl('https://cdn.example.com/a.jpg#x\\y'), true);
  assert.equal(isHttpsUrl('https://cdn.example.com/a.jpg?next=https://x/y'), true);
  assert.equal(isHttpsUrl('HTTPS://cdn.example.com/a.jpg'), true);
  assert.equal(isHttpsUrl(' https://cdn.example.com/a.jpg '), true);
});

test('a scheme that merely begins with or contains "https" is not https', () => {
  // The parse settles case and slashes, but the comparison after it still has to
  // be exact. `new URL('httpsx://…')` parses happily with protocol `httpsx:` —
  // the WHATWG parser accepts any well-formed scheme — so a comparison written
  // as a prefix or substring test (`protocol.startsWith('https')`,
  // `protocol.includes('https')`) says yes to every one of the schemes below.
  // None of them is a scheme Meta fetches over, and the whole point of the check
  // is that the server never fetches the URL itself to find out: the string is
  // forwarded to Graph on the strength of this verdict alone. `https2:` and
  // `httpss:` are what a typo looks like; `https-cdn:` and `xhttps:` are what a
  // custom-scheme handler looks like. Every one must be refused by all three
  // spellings of the check, and with the same wording as `http://`, because the
  // refusal reads the same to the operator whichever near-miss they typed.
  for (const url of [
    'httpsx://cdn.example.com/a.jpg',
    'https2://cdn.example.com/a.jpg',
    'httpss://cdn.example.com/a.jpg',
    'https-cdn://cdn.example.com/a.jpg',
    'xhttps://cdn.example.com/a.jpg',
  ]) {
    assert.equal(isHttpsUrl(url), false, url);
    assert.throws(
      () => assertHttpsUrl(url, 'videoUrl'),
      (e: unknown) =>
        e instanceof InstagramError &&
        e.kind === 'validation' &&
        e.message ===
          'videoUrl must be a well-formed https:// URL (Instagram fetches media over HTTPS).',
      url,
    );
    const result = httpsUrlSchema.safeParse(url);
    assert.equal(result.success, false, url);
    assert.equal(
      result.success ? '' : (result.error.issues[0]?.message ?? ''),
      'must be a well-formed https:// URL',
      url,
    );
  }
});

test('a URL the parser has to strip before it reads https is not the URL that gets forwarded', () => {
  // The WHATWG parser discards leading and trailing C0 controls, and removes every
  // tab, LF and CR wherever it sits, before it reads the scheme. The
  // verdict is therefore about a cleaned-up string, while the tools forward the RAW
  // value to Graph as `image_url` / `video_url` / `cover_url` — the server never
  // fetches it and never re-serialises it. A trailing newline pasted with a URL, or
  // one wedged into the host (`cdn.exa\nmple.com`), passed as "a well-formed https
  // URL" and reached Meta as a host no resolver will find. Each is refused through
  // all three entry points with the ordinary wording (CC-PUB-57).
  for (const url of [
    'https://cdn.example.com/a.jpg\n',
    'https://cdn.example.com/a.jpg\r\n',
    '\u0000https://cdn.example.com/a.jpg',
    'https://cdn.exa\nmple.com/a.jpg',
    'https://cdn.example.com/a\t.jpg',
  ]) {
    assert.equal(isHttpsUrl(url), false, JSON.stringify(url));
    assert.throws(
      () => assertHttpsUrl(url, 'imageUrl'),
      (e: unknown) =>
        e instanceof InstagramError &&
        e.kind === 'validation' &&
        e.message ===
          'imageUrl must be a well-formed https:// URL (Instagram fetches media over HTTPS).',
      JSON.stringify(url),
    );
    assert.equal(httpsUrlSchema.safeParse(url).success, false, JSON.stringify(url));
  }
  // A space INSIDE the path is not dropped — the parser percent-encodes it, so
  // the forwarded string still names the same resource — and stays accepted.
  assert.equal(isHttpsUrl('https://cdn.example.com/a b.jpg'), true);
  // Edge spaces stay accepted too: forwarding them untouched is a pinned contract
  // ('a media URL is forwarded byte for byte, never rewritten on the way out').
  assert.equal(isHttpsUrl(' https://cdn.example.com/a.jpg '), true);
});

test('assertHttpsUrl refuses with the exact https-only wording', () => {
  // This sentence is the entire explanation an operator gets for a refused publish,
  // and it has to say https — a message that asks for `http://` would send them to
  // downgrade a working URL, i.e. the server would be instructing the operator to
  // hand Meta an insecure URL. The field name is what tells them WHICH of imageUrl /
  // videoUrl / coverUrl was wrong.
  assert.throws(
    () => assertHttpsUrl('http://cdn.example.com/a.jpg', 'imageUrl'),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message ===
        'imageUrl must be a well-formed https:// URL (Instagram fetches media over HTTPS).',
  );
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
    `URL extension ".${ext}" suggests a non-JPEG image; Instagram accepts JPEG only for images ` +
    '(feed, story, and reel cover). Format, byte size, and dimensions cannot be verified before ' +
    'Instagram fetches the URL.'
  );
}

test('the format hint names every still-image surface, not only the feed (CC-PUB-25)', () => {
  // The same sentence is rendered on a story image and a reel cover (pinned in
  // test/tools/publishing.test.ts), where "feed images must be JPEG" read as a
  // rule for a different field and taught the operator that a story was exempt.
  // The whole sentence is pinned so a re-wording has to come back here.
  assert.equal(
    imageUrlFormatWarning('https://cdn.example.com/story.png'),
    'URL extension ".png" suggests a non-JPEG image; Instagram accepts JPEG only for images ' +
      '(feed, story, and reel cover). Format, byte size, and dimensions cannot be verified ' +
      'before Instagram fetches the URL.',
  );
});

test('every extension in the clearly-not-JPEG list produces the exact warning', () => {
  // This hint is the only pre-flight signal that the operator is about to spend a
  // publish slot on a container Instagram will refuse for format. `.heic` is the
  // entry that matters most in practice — it is what an iPhone photo is called
  // before anyone converts it — and dropping any single entry makes the warning
  // quietly stop appearing for that format, with nothing failing and nothing logged.
  // `.avif` and `.jxl` are the modern half of that same problem: both are ordinary
  // output of an image pipeline today, and `.jxl` announces itself as a JPEG in its
  // own name while being a format Instagram does not accept.
  for (const ext of [
    'png',
    'gif',
    'webp',
    'bmp',
    'tiff',
    'tif',
    'heic',
    'heif',
    'svg',
    'avif',
    'jxl',
    'apng',
    'ico',
  ]) {
    assert.equal(
      imageUrlFormatWarning(`https://cdn.example.com/pic.${ext}`),
      expectedFormatWarning(ext),
      `".${ext}" must warn`,
    );
  }
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/pic.jpg'), undefined);
});

test('no spelling of JPEG is ever flagged as non-JPEG', () => {
  // The counterweight to widening the list above. `.jfif`, `.jpe` and `.pjpeg` are
  // all JPEG files — a warning on one of them tells the operator to go and convert
  // a file that is already in the only format Instagram accepts, and the hint is
  // read by a model that will act on it. Every extension here must stay silent no
  // matter what else joins CLEARLY_NOT_JPEG.
  for (const ext of ['jpg', 'jpeg', 'JPG', 'JPEG', 'jfif', 'jpe', 'pjpeg']) {
    assert.equal(
      imageUrlFormatWarning(`https://cdn.example.com/pic.${ext}`),
      undefined,
      `".${ext}" is JPEG and must not warn`,
    );
  }
});

test('the format hint reads the path only — never the host, query, or fragment', () => {
  // A dot outside the path is not an extension. Decide the hint on `href` (or on
  // the host) instead of `pathname` and every one of these starts lying: the
  // operator is told their JPEG "suggests a non-JPEG image" and sent to re-encode a
  // file that was fine, or — worse for a hint whose whole value is being trusted —
  // the wrong half of the URL decides what the preview says about the post.
  assert.equal(imageUrlFormatWarning('https://example.png'), undefined);
  assert.equal(imageUrlFormatWarning('https://example.png/photo'), undefined);
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/photo?src=a.png'), undefined);
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/photo#preview.png'), undefined);
  // …and a real extension still wins over a query that follows it.
  assert.equal(
    imageUrlFormatWarning('https://cdn.example.com/pic.png?v=2#top'),
    expectedFormatWarning('png'),
  );
});

test('the format hint stays silent on a trailing dot and on a dot in a directory', () => {
  // A trailing dot leaves `ext` as '', which no format is named after, and a dot
  // in a directory is not in the file name at all, so the hint says nothing. That
  // is the correct outcome and the documented one: the absence of a warning is
  // never proof the URL is a JPEG, so a miss here costs only the hint, while a
  // false positive would send the operator to fix a file that is not broken.
  // Pinned so a "smarter" extension parser has to justify itself.
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/pic.'), undefined);
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/a.png/b'), undefined);
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/v1.2/photo'), undefined);
});

test('the format hint reads the file name — the last path segment — and then its last dot (CC-PUB-24)', () => {
  // The extension belongs to the file name, so the segment after the final `/` is
  // read first and its own last dot decides. A versioned directory (`/v1.2/`, an
  // `/img.v2/` bucket) contributes nothing, whether the file name is absent, has
  // no dot, or has one of its own; the dot that counts is the last one INSIDE the
  // segment; and the match is case-insensitive there as everywhere.
  //
  // Honest note on what this pins: the whole-path reading this replaced — the
  // last dot of the entire pathname — gave the identical verdict for every one of
  // these, and for every URL. A dot in a directory produced an "extension" that
  // carried a `/` (`2/photos/`, `v2/cat`, `png/b`), and no entry in the table
  // does, so it was silent; a dot in the file name was the same dot either way.
  // No fixture can separate the two readings while the table holds no `/`, so
  // what these cases pin is that the segment read means what it says — and they
  // keep meaning it if the table ever grows an entry the old read could match
  // across a directory boundary.
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/v1.2/photos/'), undefined);
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/img.v2/cat'), undefined);
  assert.equal(
    imageUrlFormatWarning('https://cdn.example.com/img.v2/cat.png'),
    expectedFormatWarning('png'),
  );
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/a.png/b'), undefined);
  assert.equal(
    imageUrlFormatWarning('https://cdn.example.com/photo.PNG'),
    expectedFormatWarning('png'),
  );
  // A dot-file named like a format is a file name whose only dot is its first
  // character: the extension is everything after it, exactly as for `data:.png`.
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/.png'), expectedFormatWarning('png'));
});

test('the format hint never echoes the URL it was given back to the caller', () => {
  // A media URL is caller-supplied and may carry userinfo (`https://user:pass@host/…`),
  // a signed-CDN token in its query, or anything else the operator pasted. This
  // warning is rendered into a tool result the model reads and into the write-intent
  // preview an operator approves, so it must carry the extension and nothing else.
  // The frozen redactor (src/core/redact.ts) masks REGISTERED secrets and token
  // shapes — a URL password is neither — so nothing downstream would catch a leak
  // that started here.
  const warning = imageUrlFormatWarning(
    'https://user:s3cr3t@cdn.example.com/private/pic.png?k=abc',
  );
  assert.equal(warning, expectedFormatWarning('png'));
  for (const fragment of ['s3cr3t', 'user', 'cdn.example.com', 'private', 'k=abc']) {
    assert.equal(warning?.includes(fragment), false, `warning must not echo "${fragment}"`);
  }
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

test('the format hint decides on the parsed path, including a path that is only an extension', () => {
  // `imageUrlFormatWarning` is exported and pure, and nothing in its signature says it
  // may only be handed an https URL — the scheme guard that makes that true today lives
  // in the CALLER (src/tools/publishing.ts runs assertHttpsUrl first). An https path
  // always starts with "/", so a path with no "/" at all is only reachable through
  // some other scheme; both shapes are pinned so the no-slash handling (the whole
  // path is the file name) and the no-dot guard keep the meaning they have now, and
  // a future caller that validates in the other order does not silently change the
  // hint.
  assert.equal(imageUrlFormatWarning('data:png'), undefined);
  assert.equal(imageUrlFormatWarning('data:.png'), expectedFormatWarning('png'));
});

test('the format hint reads the raw path and does not decode percent-escapes', () => {
  // The hint is advisory by design — format is unverifiable until Instagram fetches the
  // URL — so it deliberately does not reconstruct what the path "really" means. Pinned
  // because the opposite reading is tempting and would quietly change what an operator
  // sees in the preview they approve: an escaped `%2E` stays a literal, not a dot, and
  // the absence of a warning must never be read as proof the image is a JPEG.
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/pic%2Epng'), undefined);
  assert.equal(imageUrlFormatWarning('https://cdn.example.com/pic%2Ejpg'), undefined);
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

test('httpsUrlSchema rejects the empty string with the same refusal as any other non-URL', () => {
  // `imageUrl: ""` is what an omitted-but-present field looks like coming out of a
  // model, and it is the one bad value that could plausibly be waved through as
  // "nothing was provided". It must not be: the field is required where it appears,
  // and an empty string that survives validation reaches Graph as `image_url=` — a
  // container create that fails upstream instead of here, with a message about a URL
  // the operator never typed. `new URL('')` throws, so it lands in the same branch as
  // "not a url"; pinned so a future `.min(0)`-style relaxation cannot open it.
  assert.equal(isHttpsUrl(''), false);
  const result = httpsUrlSchema.safeParse('');
  assert.equal(result.success, false);
  assert.equal(
    result.success ? '' : (result.error.issues[0]?.message ?? ''),
    'must be a well-formed https:// URL',
  );
});

test('httpsUrlSchema stops a non-string at the type boundary, before the refine runs', () => {
  // The refine calls `isHttpsUrl`, whose parameter is typed `string` — `new URL(…)`
  // would coerce a number or an object to text and decide the scheme on the result.
  // zod's `z.string()` runs first and short-circuits, so `isHttpsUrl` is never handed
  // a non-string and needs no runtime type check of its own. That is a property of the
  // schema's shape, not of this module, so it is pinned here: the issue is an
  // invalid_type, NOT the custom https message, which is exactly what proves the
  // refine did not execute.
  for (const bad of [123, null, undefined, {}, ['https://cdn.example.com/a.jpg']]) {
    const result = httpsUrlSchema.safeParse(bad);
    assert.equal(result.success, false, `${JSON.stringify(bad)} must be rejected`);
    const issue = result.success ? undefined : result.error.issues[0];
    assert.equal(issue?.code, 'invalid_type', `${JSON.stringify(bad)} must fail on type`);
    assert.notEqual(issue?.message, 'must be a well-formed https:// URL');
  }
});

test('isHttpsUrl accepts a URL carrying embedded credentials, and nothing echoes it', () => {
  // `https://user:pass@host/x.jpg` is a valid https URL and this guard is a SCHEME
  // check, not a credential policy — refusing it would block a legitimate way to
  // reference a protected asset that Instagram (not this server) will fetch. What
  // matters is that the userinfo stops here: `assertHttpsUrl` does not throw, so it
  // never composes a message around the URL, and the only other function that reads a
  // URL returns a warning built from the extension alone. The tool layer likewise puts
  // counts, not URLs, in its previews and log fields, so the password has no path into
  // a tool result, a write-intent preview, the journal, or a log line.
  const credentialUrl = 'https://user:s3cr3t@cdn.example.com/x.jpg';
  assert.equal(isHttpsUrl(credentialUrl), true);
  assert.doesNotThrow(() => assertHttpsUrl(credentialUrl, 'imageUrl'));
  assert.equal(httpsUrlSchema.safeParse(credentialUrl).success, true);
  assert.equal(imageUrlFormatWarning(credentialUrl), undefined);
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

test('assertCarouselSize refuses a count that is not a whole number', () => {
  // NaN is the hole a pure range test cannot cover: `NaN < 2` and `NaN > 10` are BOTH
  // false, so `count < MIN || count > MAX` alone returns normally and the caller goes
  // on to assemble a carousel out of a child count that is not a number — the create
  // call then goes to Graph describing an album nobody asked for. `2.5` slips through
  // the identical gap while naming a carousel that cannot exist, and Infinity is the
  // mirror case that the range test does happen to catch. Today both call sites pass
  // an array `.length`, so this branch belongs to the exported contract rather than to
  // any live path — which is exactly why it is asserted here and not left to a caller
  // to discover.
  for (const bad of [Number.NaN, 2.5, 9.999, -0.5]) {
    assert.throws(
      () => assertCarouselSize(bad),
      (e: unknown) =>
        e instanceof InstagramError &&
        e.kind === 'validation' &&
        e.message === `A carousel needs 2–10 items (got ${bad}).`,
      `${bad} must be refused`,
    );
  }
  assert.throws(
    () => assertCarouselSize(Number.POSITIVE_INFINITY),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
  // Every whole number inside the range still passes — the new guard adds a rule, it
  // does not narrow the one that was there.
  for (let n = CAROUSEL_MIN; n <= CAROUSEL_MAX; n += 1) {
    assert.doesNotThrow(() => assertCarouselSize(n), `${n} must be accepted`);
  }
});

/**
 * Locate the repo root: `process.cwd()` first, then every ancestor of this
 * compiled module, so the scrape below reads the sources of the tree the suite
 * is running against rather than a sibling checkout.
 */
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

/**
 * How many refusals the module actually raises, counted in its own source.
 *
 * Comments are stripped rather than dodged with a line anchor. `^\s*throw`
 * counts only a throw that OPENS its line, and is blind to the single-line
 * `if (cond) throw new InstagramError(...)` form — a form this repo already
 * writes for `return`, and one no lint rule here forbids (`curly` and
 * `brace-style` are both off in eslint.config.js). A sixth refusal written that
 * way leaves this count at five, the equality below still holds, and the new
 * site's init record — the one thing this test exists to read — is audited
 * by nothing. The anchor was never what kept the docstrings out either: they
 * say `Throw {@link InstagramError}`, which carries neither the lowercase
 * keyword nor the `new`.
 */
const MEDIA_SPEC_THROW_SITES = (() => {
  const source = readFileSync(join(findRepoRoot(), 'src', 'api', 'media-spec.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return [...code.matchAll(/throw new InstagramError\(/g)].length;
})();

test('every refusal in this module carries kind and message ONLY — no code, status, or trace', () => {
  // Every throw site in the module hands `InstagramError` the same init record,
  // `{ kind: 'validation' }`, and every assertion above reads that record field
  // by field: `e instanceof InstagramError && e.kind === 'validation' &&
  // e.message === '...'`. Those reads name the two fields that are supposed to
  // be there and cannot see a THIRD one added beside them. Measured:
  // `{ kind: 'validation', code: 999 }` — one site at a time, at each of the
  // five — survived all 1880 tests of this suite before this assertion existed.
  // Nothing flags it at compile time either: `InstagramErrorInit` declares
  // `status`, `fbtraceId`, `code`, `subcode` and `cause` as optional members, so
  // the extra key is a known property and needs no cast.
  //
  // The added field would not stay internal. `src/mcp/result.ts` renders `code`
  // and `subcode` of every InstagramError into the error line the model reads, so a
  // refusal that never spoke to Graph would hand the model a Graph error code to
  // reason about; `status` and `fbtraceId` are what the logs and the doctor read
  // as "the upstream said so". Every error raised here is raised BEFORE a
  // request leaves this machine — there is no upstream response for any of those
  // numbers to describe, and a caller retrying on a `status` would be retrying a
  // caption that is too long. Hence one whole pin per site, naming the fields
  // that must stay undefined.
  const observable = (e: unknown): Record<string, unknown> => {
    assert.ok(e instanceof InstagramError, 'a hard rule must throw InstagramError');
    return {
      name: e.name,
      kind: e.kind,
      message: e.message,
      status: e.status,
      code: e.code,
      subcode: e.subcode,
      fbtraceId: e.fbtraceId,
      cause: e.cause,
    };
  };

  const sites = [
    {
      what: 'caption over the code-point cap',
      run: () => assertCaptionWithinLimits('x'.repeat(MAX_CAPTION_CODEPOINTS + 1)),
      message: 'Caption exceeds 2200 characters (got 2201).',
    },
    {
      what: 'caption over the hashtag cap',
      run: () =>
        assertCaptionWithinLimits(
          Array.from({ length: MAX_HASHTAGS + 1 }, (_v, i) => `#t${i}`).join(' '),
        ),
      message: 'Caption has more than 30 hashtags (got 31).',
    },
    {
      what: 'caption over the mention cap',
      run: () =>
        assertCaptionWithinLimits(
          Array.from({ length: MAX_MENTIONS + 1 }, (_v, i) => `@u${i}`).join(' '),
        ),
      message: 'Caption has more than 20 @mentions (got 21).',
    },
    {
      what: 'a non-https media URL',
      run: () => assertHttpsUrl('http://cdn.example.com/a.jpg', 'imageUrl'),
      message: 'imageUrl must be a well-formed https:// URL (Instagram fetches media over HTTPS).',
    },
    {
      what: 'a carousel below the minimum',
      run: () => assertCarouselSize(1),
      message: 'A carousel needs 2–10 items (got 1).',
    },
  ];

  // The list above is written by hand — only an invocation produces an error to
  // look at, and every site needs its own input — so it is a claim about the
  // module that the module never checks. Count the refusals in the source and
  // make the claim answer to it: a sixth rule added with a fabricated
  // `code: 2207026` beside `kind` is precisely the mutation this test exists to
  // kill, and precisely the one a hand list cannot see, because the loop below
  // runs over five entries and the new site is not among them. No separate
  // vacuity floor is needed: the counted side is read from the file, so a
  // pattern that stopped matching reads 0 and this equality fails on the spot.
  assert.equal(
    sites.length,
    MEDIA_SPEC_THROW_SITES,
    `src/api/media-spec.ts throws InstagramError ${MEDIA_SPEC_THROW_SITES} times but only ` +
      `${sites.length} of them are pinned here. Add the new refusal to \`sites\` — an ` +
      `unpinned one is free to hand a caller a Graph \`code\` or \`status\` for a decision ` +
      `this process made alone, before any request left the machine.`,
  );

  for (const site of sites) {
    assert.throws(
      site.run,
      (e: unknown) => {
        assert.deepEqual(observable(e), {
          name: 'InstagramError',
          kind: 'validation',
          message: site.message,
          status: undefined,
          code: undefined,
          subcode: undefined,
          fbtraceId: undefined,
          cause: undefined,
        });
        return true;
      },
      site.what,
    );
  }
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

test('containerMediaTypeSchema is exact-case and never coerces an unrecognised value', () => {
  // The parsed value is forwarded verbatim as the Graph `media_type` param. Accepting a
  // near-miss spelling means the container is created with a media_type Meta does not
  // know — a publish slot spent on an opaque upstream error. Coercing one (a zod
  // `.catch` default, say) is worse: an unrecognised media_type would become REELS, and
  // the operator's approved preview would no longer describe what was actually posted.
  for (const bad of ['reels', 'Reels', 'stories', 'carousel', 'REEL', 'CAROUSEL_ALBUM', '']) {
    assert.equal(
      containerMediaTypeSchema.safeParse(bad).success,
      false,
      `"${bad}" must be rejected`,
    );
  }
});

test('userTagSchema requires the username key and accepts a one-character handle', () => {
  // Instagram handles can be a single character, so a minimum of two would refuse a
  // legitimate tag with a message about a username the operator can plainly see is
  // there. The mirror case matters more: if `username` were optional, a tag with only
  // coordinates would validate and reach Meta as a user_tags entry with no user in it.
  assert.equal(userTagSchema.safeParse({ username: 'a' }).success, true);
  assert.equal(userTagSchema.safeParse({}).success, false);
  assert.equal(userTagSchema.safeParse({ x: 0.5, y: 0.5 }).success, false);
});

test('userTagSchema keeps both coordinates and strips unknown keys', () => {
  // The parse output is what gets JSON.stringify-ed into the Graph `user_tags` param,
  // so this shape is the wire format. Dropping x or y places every tag at Meta's
  // default position — the tags are on the post but on the wrong part of the picture,
  // and nothing errors. Passing unknown keys through is the opposite leak: whatever
  // extra fields arrived in the tool call would be forwarded to Meta unreviewed.
  assert.deepEqual(userTagSchema.parse({ username: 'alice', x: 0.25, y: 0.75, note: 'drop me' }), {
    username: 'alice',
    x: 0.25,
    y: 0.75,
  });
});

test('userTagSchema does not coerce: a stringly-typed tag is refused, not converted', () => {
  // The parse output is JSON.stringify-ed straight into the Graph `user_tags` param,
  // so its types ARE the wire types. A coercing schema (`z.coerce.number()`,
  // `z.coerce.string()`) would accept `x: "0.5"` and `username: 12345` from a model
  // that quoted its numbers, and the difference only shows up as a container Meta
  // refuses — or, worse, silently places the tag somewhere else. Rejecting here names
  // the field while the operator can still fix it.
  assert.equal(userTagSchema.safeParse({ username: 'alice', x: '0.5' }).success, false);
  assert.equal(userTagSchema.safeParse({ username: 'alice', y: '0.5' }).success, false);
  assert.equal(userTagSchema.safeParse({ username: 12345 }).success, false);
  assert.equal(userTagSchema.safeParse({ username: 'alice', x: null }).success, false);
});

test('userTagSchema rejects NaN coordinates', () => {
  // NaN passes any `>= 0 && <= 1` reasoning by being false on both sides, and
  // `JSON.stringify(NaN)` is `null` — so a NaN coordinate would reach Graph as
  // `{"x":null}` rather than being refused here with a message naming the field.
  assert.equal(userTagSchema.safeParse({ username: 'alice', x: Number.NaN }).success, false);
  assert.equal(userTagSchema.safeParse({ username: 'alice', y: Number.NaN }).success, false);
});

// --- Freeze contract --------------------------------------------------------

test('CONTAINER_MEDIA_TYPES is frozen, and the schema built from it cannot be widened', () => {
  // Measurable end to end inside this module: `containerMediaTypeSchema` is
  // `z.enum(CONTAINER_MEDIA_TYPES)`, built once when the module loads, and zod
  // v3 keeps the ARRAY rather than a copy of it (CC-CFG-35). Before the freeze,
  // a push onto the exported vocabulary reached a schema that had already been
  // built — the schema behind `instagram_create_media_container`, which is what
  // decides whether Meta is asked to create a container of a `media_type` this
  // server never validated. The vocabulary is deliberately short: a feed image
  // sends NO `media_type` at all, so `IMAGE` and `VIDEO` are not members.
  const types: readonly string[] = CONTAINER_MEDIA_TYPES;
  assert.ok(Object.isFrozen(types), 'must be frozen, not merely typed readonly');
  const before = [...types];
  assert.throws(() => (types as string[]).push('SMUGGLED'), TypeError);
  assert.throws(() => (types as string[]).pop(), TypeError);
  assert.throws(() => {
    (types as string[])[0] = 'SMUGGLED';
  }, TypeError);
  assert.deepEqual(types, before, 'a write got through');
  assert.deepEqual(before, ['REELS', 'STORIES', 'CAROUSEL']);

  assert.equal(containerMediaTypeSchema.safeParse('REELS').success, true, 'guard: still an enum');
  assert.equal(containerMediaTypeSchema.safeParse('SMUGGLED').success, false);
  assert.equal(containerMediaTypeSchema.safeParse('IMAGE').success, false);

  // Positive control for the sentence about zod holding the live array: the same
  // schema over a mutable array does widen after it is built, so the freeze
  // above is the whole difference between the two outcomes. The push has to land
  // before the schema's first parse, which is where the reach of this mutation
  // ends: zod 3.25.76 memoises the member set on first use, while `.options`
  // — the list `zod-to-json-schema` renders for the client — stays a live read
  // of the array either way. `test/api/insights.test.ts` measures both halves.
  const live: [string, ...string[]] = ['REELS', 'STORIES', 'CAROUSEL'];
  const loose = z.enum(live);
  live.push('SMUGGLED');
  assert.equal(
    loose.safeParse('SMUGGLED').success,
    true,
    'zod copied the array — this control measures nothing, and the freeze proves less',
  );
  assert.deepEqual(loose.options, ['REELS', 'STORIES', 'CAROUSEL', 'SMUGGLED']);
});
