/**
 * Client-side media specs and validators (Layer 1, no network). The server
 * never fetches user-supplied media URLs (SSRF policy — docs/security.md), so
 * pixel format, byte size, aspect ratio, and video duration CANNOT be verified
 * before Meta fetches the URL at container creation. This module therefore
 * enforces only what is structurally checkable from the request itself:
 *
 *   - captions: code-point length ≤ 2200, ≤ 30 hashtags, ≤ 20 @mentions;
 *   - media URLs: well-formed `https://` (a clearly non-JPEG extension warns,
 *     but is never treated as proof — format stays unverifiable pre-fetch);
 *   - carousels: 2–10 children;
 *   - the container `media_type` enum (feed images send NO `media_type`).
 *
 * Validators throw {@link InstagramError} with `kind: 'validation'` on a hard
 * rule, or return typed results (stats / warnings) for the tool to surface.
 * Hashtag/@mention counting is a best-effort heuristic over the caption text.
 */
import { z } from 'zod';
import { InstagramError } from '../core/types.js';

// --- Limits (from docs/tools.md, verified against Instagram Platform docs) ---

/** Caption cap, counted in Unicode code points (CC-PUB-9/10/11). */
export const MAX_CAPTION_CODEPOINTS = 2200;
/** Maximum hashtags allowed in a caption. */
export const MAX_HASHTAGS = 30;
/** Maximum @mentions allowed in a caption. */
export const MAX_MENTIONS = 20;
/** Carousel album bounds (inclusive). */
export const CAROUSEL_MIN = 2;
export const CAROUSEL_MAX = 10;

// --- Container media kinds --------------------------------------------------

/**
 * Values accepted for the container `media_type` param. A **feed image** is the
 * notable exception: it sends `image_url` with NO `media_type` at all (`IMAGE`
 * and `VIDEO` are invalid values — verified 2026-07-21), so it is not in this
 * enum. Reels/Stories/Carousel each send their `media_type`.
 */
export const CONTAINER_MEDIA_TYPES = Object.freeze(['REELS', 'STORIES', 'CAROUSEL'] as const);
export type ContainerMediaType = (typeof CONTAINER_MEDIA_TYPES)[number];
export const containerMediaTypeSchema = z.enum(CONTAINER_MEDIA_TYPES);

// --- Zod specs (reused by tool input schemas) -------------------------------

/** A user tag on a feed image: handle plus optional 0–1 relative coordinates. */
export const userTagSchema = z.object({
  username: z.string().min(1),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
});
export type UserTag = z.infer<typeof userTagSchema>;

/** A well-formed `https://` URL. Structural only — reachability is unverifiable. */
export const httpsUrlSchema = z
  .string()
  .refine((v) => isHttpsUrl(v), { message: 'must be a well-formed https:// URL' });

// --- Caption analysis -------------------------------------------------------

export interface CaptionStats {
  /** Unicode code points (emoji count as 1, not their UTF-16 unit count). */
  codePoints: number;
  hashtags: number;
  mentions: number;
}

// Best-effort token counting: a `#`/`@` followed by word-ish characters. This
// over-counts pathological inputs (e.g. an email as a mention); it is a client
// guard to avoid spending quota on an obviously invalid caption, not a mirror
// of Instagram's exact parser.
//
// Both are module-level `/g` regexes shared by every call, and they carry no
// state between calls: `String.prototype.match` on a global regex sets
// `lastIndex` to 0 before it starts collecting and leaves it at 0 afterwards, so
// the result depends on the caption alone. That is pinned by a test rather than
// assumed, because the rewrites this shape invites — `re.test(s)` in a loop,
// `re.exec(s)` until null — do NOT have the property, and under one of those the
// second analysis of the same caption would silently disagree with the first.
//
// Equivalent-mutant note: adding `u` to MENTION_RE is unobservable. Its class is
// all-ASCII and holds no escape whose meaning changes in unicode mode, and
// neither half of a surrogate pair is a member, so both spellings match exactly
// the same substrings of every input. HASHTAG_RE's `u` is load-bearing — without
// it `\p{L}` decays to an identity escape and the class becomes the literal
// characters `p{LN}_` — and is pinned by the `#2026 … #日本語` test.
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const MENTION_RE = /@[A-Za-z0-9._]+/g;

/** Count code points, hashtags, and @mentions in a caption. Pure. */
export function analyzeCaption(caption: string): CaptionStats {
  // Equivalent-mutant note: `?? []` and `|| []` cannot be told apart here.
  // `String.prototype.match` on a global regex returns either `null` or a
  // NON-empty array — never an empty array and never any other falsy value — so
  // no caption exists for which the two operators choose different branches.
  return {
    codePoints: [...caption].length,
    hashtags: (caption.match(HASHTAG_RE) ?? []).length,
    mentions: (caption.match(MENTION_RE) ?? []).length,
  };
}

/**
 * Throw {@link InstagramError} (`validation`) if the caption breaks a hard
 * limit; otherwise return its stats so the caller can surface them in a plan.
 */
export function assertCaptionWithinLimits(caption: string): CaptionStats {
  const stats = analyzeCaption(caption);
  if (stats.codePoints > MAX_CAPTION_CODEPOINTS) {
    throw new InstagramError(
      `Caption exceeds ${MAX_CAPTION_CODEPOINTS} characters (got ${stats.codePoints}).`,
      { kind: 'validation' },
    );
  }
  if (stats.hashtags > MAX_HASHTAGS) {
    throw new InstagramError(
      `Caption has more than ${MAX_HASHTAGS} hashtags (got ${stats.hashtags}).`,
      { kind: 'validation' },
    );
  }
  if (stats.mentions > MAX_MENTIONS) {
    throw new InstagramError(
      `Caption has more than ${MAX_MENTIONS} @mentions (got ${stats.mentions}).`,
      { kind: 'validation' },
    );
  }
  return stats;
}

// --- URL validation ---------------------------------------------------------

/**
 * Characters the WHATWG parser silently DISCARDS before it reads a URL and that
 * change which resource the forwarded raw string names: C0 controls at either
 * end, and tab/LF/CR anywhere. `\p{Cc}` covers all of them (and C1 controls,
 * which no media URL carries), so a control character is refused wherever it
 * sits. A space is deliberately NOT refused: an interior space is percent-encoded
 * rather than dropped, and an edge space is part of the byte-for-byte forwarding
 * contract pinned in `test/tools/publishing.test.ts`.
 */
const PARSER_DISCARDS = /\p{Cc}/u;

/**
 * The raw text introduces its authority with exactly `//` after the scheme's
 * colon. The WHATWG parser is lenient here for special schemes and REWRITES what
 * it gets: `https:/cdn/a.jpg`, `https:cdn/a.jpg` and `https:///cdn/a.jpg` all
 * parse as `https://cdn/a.jpg`, and a backslash counts as a slash (that half is
 * `PATH_BACKSLASH` below). An RFC 3986
 * reader of the same raw string — which is what Graph receives — sees no host at
 * all, or a different one (CC-PUB-58). `[^:]*` (not `.*`) pins the check to the
 * FIRST colon, so a later `://` in the query cannot satisfy it. Leading spaces
 * pass through `[^:]*`: edge spaces are the pinned byte-for-byte contract.
 */
const RAW_AUTHORITY = /^[^:]*:\/\/(?!\/)/;

/**
 * A backslash before the query or fragment. The parser turns it into `/` in the
 * authority and the path of an https URL (`https://cdn\a.jpg` reads as
 * `https://cdn/a.jpg`), so the forwarded raw string names a different resource
 * than the verdict did (CC-PUB-58). In the query and fragment the parser keeps it
 * as written, so it is left alone there.
 */
const PATH_BACKSLASH = /^[^?#]*\\/;

/**
 * True iff `value` parses as a URL with the `https:` protocol AND the parser did
 * not have to throw part of it away, or rewrite its structure, to get there. Pure.
 *
 * The second half exists because the verdict is about the parsed URL while every
 * caller forwards the RAW string to Graph (the server never fetches or
 * re-serialises it). `new URL('https://cdn.exa\nmple.com/a.jpg')` is a perfectly
 * good `https://cdn.example.com/…`, and the string Meta would receive is not
 * (CC-PUB-57); the same holds for a scheme followed by one or three slashes, or
 * by backslashes (CC-PUB-58). The case of the scheme and host is NOT such a
 * rewrite — both are case-insensitive under every URL grammar — so `HTTPS://`
 * stays accepted.
 */
export function isHttpsUrl(value: string): boolean {
  if (PARSER_DISCARDS.test(value)) return false;
  if (!RAW_AUTHORITY.test(value) || PATH_BACKSLASH.test(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Throw {@link InstagramError} (`validation`) unless `value` is an https URL. */
export function assertHttpsUrl(value: string, field: string): void {
  if (!isHttpsUrl(value)) {
    throw new InstagramError(
      `${field} must be a well-formed https:// URL (Instagram fetches media over HTTPS).`,
      { kind: 'validation' },
    );
  }
}

/**
 * File extensions that clearly are NOT JPEG images.
 *
 * Still-image formats only. The warning below says "suggests a non-JPEG image",
 * so an extension that is not an image at all (`mp4`/`mov` handed to an image
 * field) is deliberately absent: it would be described wrongly, and the same
 * extension is exactly right on `instagram_post_reel`. `avif` and `jxl` are the
 * modern entries that matter — both are ordinary output of an image CDN today,
 * and `jxl` in particular reads as a JPEG in its own name while being a format
 * Instagram does not take.
 *
 * The JPEG spellings must never appear here: `jpg`, `jpeg`, `jfif`, `jpe`, and
 * `pjpeg` are all JPEG, and warning on one would send the operator off to
 * "convert" a file that was already in the only format Instagram accepts.
 */
const CLEARLY_NOT_JPEG = new Set([
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
]);

/**
 * A non-fatal warning when a URL's extension clearly denotes a non-JPEG image
 * (Instagram accepts JPEG only for images — feed, story, and reel cover, which
 * is why the sentence names all three rather than "feed"). Returns `undefined`
 * when the extension is JPEG, absent, or ambiguous — this is a hint only; format
 * is truly unverifiable until Instagram fetches the URL.
 */
export function imageUrlFormatWarning(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  // The extension is read from the FILE NAME — the last path segment — and then
  // from the last dot inside it (CC-PUB-24). Reading the last dot of the whole
  // path instead gives the same verdict for every URL there is, because a dot
  // that sits in a directory yields an "extension" such as `2/photos` that
  // carries a `/`, and no entry in the set does; the segment read says what it
  // means, and stays right if the set ever grows an entry the other reading
  // could match across a directory boundary.
  //
  // The extension is read from the RAW path — percent-escapes are not decoded, so
  // `/pic%2Epng` has no extension here. That is deliberate: this is a hint, never
  // proof, and the absence of a warning must not be read as "the URL is a JPEG".
  //
  // Caller-order dependency: every caller in `src/tools/publishing.ts` runs
  // `assertHttpsUrl` BEFORE this function, and an `https:` pathname always begins
  // with `/`, so in production the segment is the text after the final `/` and
  // `dot === -1` only means "file name with no dot". A path with no `/` at all
  // (`data:.png`) is reachable only through some other scheme; it is handled for
  // the general case because this function is exported and pure — `lastIndexOf`
  // answers -1 there, `slice(0)` keeps the whole path as the segment, and the
  // dot arithmetic is the same. Validate in the other order and that shape
  // becomes reachable with attacker-chosen schemes.
  //
  // Equivalent-mutant notes: `dot === -1` and `dot < 0` are the same predicate —
  // `String.prototype.lastIndexOf` returns either -1 or a valid index, never any
  // other negative number — so no URL can separate the two spellings. And
  // `pathname.indexOf('/')` in place of `lastIndexOf('/')` is the whole-path
  // reading again (an `https:` pathname's first `/` is at 0), which the paragraph
  // above shows is observationally the same function while the set holds no `/`.
  // Measured 2026-09-23, each spelling mutated on its own: `dot < 0` for
  // `dot === -1`, and `indexOf('/')` for `lastIndexOf('/')`. Both survive the
  // whole suite. The same channel kills thirteen tests when this function is
  // made to return early unconditionally, so the two survivals measure the
  // suite rather than how far it reaches.
  const segment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = segment.lastIndexOf('.');
  if (dot === -1) return undefined;
  const ext = segment.slice(dot + 1).toLowerCase();
  if (CLEARLY_NOT_JPEG.has(ext)) {
    return (
      `URL extension ".${ext}" suggests a non-JPEG image; Instagram accepts JPEG only for images ` +
      '(feed, story, and reel cover). Format, byte size, and dimensions cannot be verified before ' +
      'Instagram fetches the URL.'
    );
  }
  return undefined;
}

// --- Carousel ---------------------------------------------------------------

/**
 * Throw {@link InstagramError} (`validation`) unless `count` is a whole number
 * within 2–10.
 *
 * The integrality test is not redundant with the range test. `NaN` compares
 * false against BOTH bounds, so `count < MIN || count > MAX` alone returns
 * normally for it and the caller proceeds to build a carousel out of a child
 * count that is not a number; `2.5` slips through the same gap while naming a
 * carousel that cannot exist. Every production call site passes an array
 * `.length`, so only a direct caller of this exported, pure function reaches
 * that branch today — it is written for the general case for the same reason
 * {@link imageUrlFormatWarning} handles a path with no `/` in it, and the suite
 * exercises it the way a future caller could.
 */
export function assertCarouselSize(count: number): void {
  if (!Number.isInteger(count) || count < CAROUSEL_MIN || count > CAROUSEL_MAX) {
    throw new InstagramError(
      `A carousel needs ${CAROUSEL_MIN}–${CAROUSEL_MAX} items (got ${count}).`,
      { kind: 'validation' },
    );
  }
}
