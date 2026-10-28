/**
 * Shared building blocks of the `publishing` package (Layer 3): the input
 * fields more than one publishing tool declares, the operated-account id, and
 * the consequence text for a container create acknowledged without an id. The
 * tools themselves live in `tools/publishing-containers.ts`,
 * `tools/publishing-composites.ts` and `tools/publishing-delete.ts`.
 *
 * Import boundary: `api/*` + `mcp/*` only; never `core/http`.
 */
import { z } from 'zod';
import { graphObjectId } from './ids.js';
import type { ToolContext } from '../mcp/define.js';
import { trialGraduationSchema } from '../api/media-spec.js';

// --- Shared input fields ----------------------------------------------------

// Equivalent-mutant note (the publishing INPUT fields — the shared ones below
// and the per-tool ones in the three tool modules — and nothing else; see the
// caveat at the end): every `x !== undefined` guard on one of these fields reads
// the same as a bare truthiness test, and no test can tell the two apart — the
// value that would, a falsy-but-PRESENT one, is unreachable by construction:
//
//   - the media URLs are `httpsUrl()`, whose pattern refuses `''` (and whose
//     refinement would too — `new URL('')` throws), so an empty URL never
//     reaches a handler;
//   - `resumeContainerId`, `locationId`, `creationId`, `containerId` and each
//     carousel child are `graphObjectId()` — 1-64 characters of `[A-Za-z0-9_-]`,
//     so `''` is refused and no id can carry whitespace, which is equally why
//     wrapping one in `.trim()` on the way out is a no-op;
//   - `children` and `userTags` are arrays, and every array is truthy;
//     `.optional()` admits `undefined`, never `null`;
//   - `imageUrlFormatWarning` returns either `undefined` or a full sentence, so
//     `if (w !== undefined)` and `if (w)` are the same test on its result.
//
// They are written `!== undefined` regardless, because the statement being made
// is about ABSENCE — "the caller did not pass this field" — and the day one of
// these schemas is widened is not the day a guard should quietly change meaning.
// `caption` is the exception that proves the rule: `''` IS a legal caption, and
// the truthiness relaxation is caught wherever its stats reach a preview.
//
// The scope is the caller-supplied fields above and nothing else — the header
// used to say "module-wide", and that was measurably false. The `x !== undefined`
// guards on API-RESPONSE fields in `tools/publishing-containers.ts` (`st.statusCode`,
// `st.status`, `limit.quotaTotal`, `limit.quotaDuration`, `limit.remaining`) are
// NOT equivalent, because Graph can answer `''` or `0` there and every one of the
// five is pinned. Relaxing either status guard is killed by "an empty status
// string is passed through rather than swallowed"; relaxing any of the three
// quota guards is killed by "a quota with nothing left reports remaining zero
// instead of staying silent", which feeds `quota_total`, `quota_duration` and
// `remaining` all as `0`.

export const applyField = z
  .boolean()
  .optional()
  .describe(
    'Set true to actually perform this write. Omitted (or false) returns a non-mutating preview of ' +
      'exactly what would happen and calls nothing, unless IG_WRITE_MODE=apply is configured. An ' +
      'explicit false always forces preview.',
  );

export const captionField = z
  .string()
  .optional()
  .describe(
    'Caption text (≤ 2200 characters, ≤ 30 hashtags, ≤ 20 @mentions — counted as a client-side guard). ' +
      'Instagram renders @mentions and #hashtags.',
  );

export const locationField = graphObjectId()
  .optional()
  .describe('Instagram location Page id to tag on the post.');

export const aiGeneratedField = z
  .boolean()
  .optional()
  .describe(
    "Label the post as made or edited with AI (sent as is_ai_generated). Omit to leave Instagram's " +
      'default; not accepted on a carousel child.',
  );

export const trialGraduationField = trialGraduationSchema
  .optional()
  .describe(
    'Reels only: publish as a trial reel, shown to non-followers first (sent as trial_params). ' +
      'MANUAL graduates it to followers from the Instagram app; SS_PERFORMANCE graduates it ' +
      'automatically if it performs well. Omit for a regular reel.',
  );

export const resumeField = graphObjectId()
  .optional()
  .describe(
    'Resume a container from a previous apply that returned status=in_progress: pass its ' +
      'resume_container_id to finish publishing instead of creating a new post (avoids a duplicate). ' +
      'When set, the media inputs are ignored.',
  );

/**
 * The reel cover-frame offset, declared once for `instagram_create_media_container`
 * and `instagram_post_reel`. A factory rather than a shared constant, like
 * `httpsUrl()` (CC-PUB-35): each field builds its own instance and carries its
 * own description, so neither tool's published schema can turn into a `$ref`
 * to the other's, and the two descriptions — which say different things about
 * when the offset applies — stay separate.
 */
export function thumbOffsetField(description: string) {
  return z.number().int().min(0).optional().describe(description);
}

// --- Helpers ----------------------------------------------------------------

/** IG target id for the operated account (numeric id, else `me`). */
export function igIdOf(ctx: ToolContext): string {
  // `??`, not `||`: a blank configured id must stay blank (the request then
  // fails upstream) rather than silently acting on the token owner's `/me/...`.
  // Pinned by test, as in `instagram_get_account` and `instagram_list_media`.
  return ctx.profile.accountId ?? 'me';
}

/**
 * Consequence text for a container create acknowledged without an id. Nothing
 * was published — publishing needs the id — and there is no id to resume with,
 * so the honest advice is that a re-run starts over and the lost container, if
 * Graph made one, expires on its own (CC-PUB-3).
 */
export const CONTAINER_ID_MISSING =
  'Nothing was published and there is no container to resume. Re-running creates a new ' +
  'container; one Graph may have made without reporting it expires unpublished within 24 h.';
