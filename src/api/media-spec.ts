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
export const CONTAINER_MEDIA_TYPES = ['REELS', 'STORIES', 'CAROUSEL'] as const;
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
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const MENTION_RE = /@[A-Za-z0-9._]+/g;

/** Count code points, hashtags, and @mentions in a caption. Pure. */
export function analyzeCaption(caption: string): CaptionStats {
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

/** True iff `value` parses as a URL with the `https:` protocol. Pure. */
export function isHttpsUrl(value: string): boolean {
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

/** File extensions that clearly are NOT JPEG feed images. */
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
]);

/**
 * A non-fatal warning when a URL's extension clearly denotes a non-JPEG image
 * (feed images must be JPEG). Returns `undefined` when the extension is JPEG,
 * absent, or ambiguous — this is a hint only; format is truly unverifiable
 * until Instagram fetches the URL.
 */
export function imageUrlFormatWarning(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const dot = pathname.lastIndexOf('.');
  if (dot === -1) return undefined;
  const ext = pathname.slice(dot + 1).toLowerCase();
  if (CLEARLY_NOT_JPEG.has(ext)) {
    return (
      `URL extension ".${ext}" suggests a non-JPEG image; Instagram feed images must be JPEG. ` +
      'Format, byte size, and dimensions cannot be verified before Instagram fetches the URL.'
    );
  }
  return undefined;
}

// --- Carousel ---------------------------------------------------------------

/** Throw {@link InstagramError} (`validation`) unless `count` is within 2–10. */
export function assertCarouselSize(count: number): void {
  if (count < CAROUSEL_MIN || count > CAROUSEL_MAX) {
    throw new InstagramError(
      `A carousel needs ${CAROUSEL_MIN}–${CAROUSEL_MAX} items (got ${count}).`,
      { kind: 'validation' },
    );
  }
}
