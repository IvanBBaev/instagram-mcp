/**
 * Shared input validation for Graph **object id** arguments (Layer 3).
 *
 * Every id a model passes to a tool ends up interpolated into the request path
 * by the api layer (`/{media-id}/comments`, `/{comment-id}`, `/{container-id}`,
 * …). The api layer now percent-encodes each of those interpolations, which is
 * the load-bearing defence; this module is the second, independent one, and it
 * sits at the seam where a bad value can still be refused with a useful message
 * instead of being turned into a doomed Graph request.
 *
 * Why a charset at all — the three concrete failures an unconstrained id causes
 * when it reaches a URL builder unencoded:
 *
 *   - `#` truncates the URL at the fragment, taking the whole query string —
 *     including `access_token` — with it, so the request goes out unauthenticated;
 *   - `?` / `&` inject attacker-chosen query parameters *ahead* of the auth
 *     parameters `core/http.ts` appends;
 *   - `.` (as `..`) plus `/` lets URL normalisation collapse `/v25.0/../me` to
 *     `/me`, silently dropping the pinned Graph API version.
 *
 * {@link GRAPH_ID_PATTERN} is exactly the complement of that: it admits the
 * characters Graph object ids are actually made of and admits no character that
 * can change the structure of a URL. `.` is excluded deliberately — a lone `..`
 * segment is enough to eat the version pin — as are `/`, `?`, `#`, `&`, `%`,
 * `:`, `@` and whitespace.
 *
 * Which fields this is applied to, and why they share one charset:
 *
 *   - `mediaId`, `commentId`, `containerId`, `creationId`, `resumeContainerId`,
 *     `children[]`, `hashtagId`, `media_id`, `locationId` — all of these are
 *     **opaque Graph object ids** handed back to the model by a previous call
 *     (or by `instagram_search_hashtag`). Observed forms are a 17-digit numeric
 *     string and the underscore-joined `<user-id>_<media-id>` form Meta returns
 *     on permalinks and webhooks. One domain, one rule.
 *
 * Which fields deliberately do NOT get it:
 *
 *   - `after` (pagination cursors) — an opaque base64-ish blob from Meta that
 *     legitimately contains `=`, `+` and `/`. It is a *query* parameter, encoded
 *     by `URLSearchParams` in `core/host.ts`, so it is not part of this attack
 *     surface; constraining it would break real paging.
 *   - `hashtag` (the search term of `instagram_search_hashtag`) — free text with
 *     its own normalisation, also query-borne.
 *   - `username` — a different domain with its own, narrower rule
 *     (`INSTAGRAM_USERNAME_PATTERN` in `api/discovery.ts`), because the api layer
 *     interpolates it into a Graph *field expression* where percent-encoding is
 *     not an available escape.
 *
 * The bound is deliberately a little wider than the ids seen in the wild: the id
 * space belongs to Meta and may grow a form we have not observed, and an
 * over-strict rule that refuses a real id is a worse failure than the one it
 * guards against.
 */
import { z } from 'zod';

import { GRAPH_ID_PATTERN } from '../core/errors.js';

/**
 * The accepted shape of a Graph object id: 1–64 characters, letters, digits,
 * `_` and `-` only. Defined in `core/errors.ts`, which applies the same rule to
 * ids read off the wire before naming them in a message (CC-PUB-56), and
 * re-exported here so tests can state the rule once.
 */
export { GRAPH_ID_PATTERN };

/**
 * Rejection text for {@link GRAPH_ID_PATTERN}.
 *
 * `mcp/registry.ts` renders zod issue *messages* (never the offending value)
 * into the tool error, so this string is what the model reads. It therefore
 * states the rule and the likely fix and never quotes the input — an id field is
 * exactly the place a caller may paste a token by mistake, and echoing it back
 * would copy that value into the transcript and into any log of it.
 */
export const GRAPH_ID_MESSAGE =
  'must be an Instagram object id: 1-64 characters, letters, digits, "_" or "-" only ' +
  '(use an id returned by a previous call; "/", "?", "#", "&", "." and spaces are not ids)';

/**
 * A Graph object-id argument. Chain `.describe()` / `.optional()` at the call
 * site exactly as before so each tool keeps its own wording and optionality.
 *
 * The `.min(1)` looks redundant next to a pattern that already demands at least
 * one character, and at *runtime* it is: drop either one and the empty string is
 * still refused, because the other still refuses it. Neither is deleted, because
 * runtime rejection is not what `.min(1)` is here for: it is what puts
 * `minLength: 1` into the JSON Schema the MCP client publishes to the model. A
 * model that can see the bound asks for a real id; a model that only learns the
 * rule from a rejection has already spent a turn.
 *
 * Measured 2026-09-23, and the measurement is the argument rather than a caveat
 * on it. Dropping `.min(1)` alone is KILLED by exactly five tests, every one of
 * them a “the published contract … is pinned exactly” test and not one of them a
 * rejection test: the runtime really is indifferent, and the published schema
 * really is the whole reason the call is there. Dropping the pattern instead is
 * KILLED by eleven — those same five, plus six that exercise rejection. This note
 * used to say a pass removing them one at a time reported two survivors where
 * there was no defect. It reports none; the suite pins both halves separately,
 * each by the thing that half is actually for.
 */
export function graphObjectId(): z.ZodString {
  return z.string().min(1).regex(GRAPH_ID_PATTERN, GRAPH_ID_MESSAGE);
}
