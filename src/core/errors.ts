/**
 * Graph error mapping (Layer 0). Pure — no network, no logging, no clock.
 * Translates a Meta Graph API error envelope into the single
 * {@link InstagramError} class, deriving the {@link ErrorKind} discriminant
 * per the taxonomy in docs/operations.md §3 (with the throttling code list
 * from §1 and the integrity subcode from CC-COM-4 / corner-cases.md).
 *
 * Security (docs/security.md §2): the surfaced `message` is built only from
 * Meta's human-readable fields (`error_user_msg`, else `error.message`) — never
 * the raw body, which is retained solely on `cause` for logging. Token-shaped
 * substrings are additionally stripped here as defense-in-depth; the
 * authoritative redaction layer remains `mcp/redact.ts`.
 */
import { InstagramError, isInstagramError } from './types.js';
import type { ErrorKind, GraphErrorBody } from './types.js';

/** The Graph `error` sub-object — every field is untrusted/optional at runtime. */
type GraphErrorFields = Partial<GraphErrorBody['error']>;

/**
 * Meta access-token shapes (docs/security.md §2): user/long-lived tokens are
 * prefixed `EAA…`, Instagram tokens `IGQ…`. Real tokens run to 100+ chars, so
 * the length floor keeps ordinary prose from matching. Defense-in-depth only.
 */
const TOKEN_SHAPE = /(?:EAA|IGQ)[\w-]{20,}/g;

function stripTokens(text: string): string {
  return text.replace(TOKEN_SHAPE, '[redacted]');
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Safely narrow an arbitrary payload to the Graph `{ error: {...} }` envelope. */
function parseErrorEnvelope(body: unknown): GraphErrorFields {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error: unknown = body.error;
    if (typeof error === 'object' && error !== null) return error;
  }
  return {};
}

/**
 * `error.error_subcode` / `error.code` / HTTP status → {@link ErrorKind}, per
 * docs/operations.md §3 (taxonomy table) and §1 (throttling code list).
 *
 * Precedence — the most specific signal wins:
 *   1. Known subcodes (a `code` alone would be ambiguous, e.g. 2207051 has no
 *      distinctive code and must never be treated as a throttle).
 *   2. `error.code`.
 *   3. HTTP status (401→auth, 403→permission, 429→rate_limit, 5xx→upstream).
 *   4. Default `upstream`.
 *
 * code / subcode → kind (docs/operations.md §3):
 *   190                                  → auth        (token expired/invalid/revoked)
 *   10, 200–299                          → permission  (missing scope/permission)
 *   4, 17, 32, 613, 80002, 429           → rate_limit  (throttled — §1 list)
 *   9  / subcode 2207042                 → rate_limit  (publishing quota exceeded)
 *   100                                  → validation  (invalid parameter)
 *   24 / subcode 2207008                 → validation  (container expired — re-create)
 *   9007 / subcode 2207027               → upstream    (media not ready — keep polling)
 *   1, 2, 500-class                      → upstream    (transient Meta-side)
 *   subcode 2207051                      → upstream    (spam/integrity — never retried)
 */
function deriveKind(
  status: number,
  code: number | undefined,
  subcode: number | undefined,
): ErrorKind {
  // 1. Known subcodes (docs/operations.md §3) — more specific than the code.
  switch (subcode) {
    case 2207051: // spam/integrity restriction — never auto-retried (CC-COM-4)
      return 'upstream';
    case 2207042: // publishing quota exceeded
      return 'rate_limit';
    case 2207027: // media not ready for publish yet — keep polling
      return 'upstream';
    case 2207008: // container expired (24 h unpublished) — re-create
      return 'validation';
    default:
      break;
  }

  // 2. error.code (docs/operations.md §3 taxonomy + §1 throttling list).
  if (code !== undefined) {
    if (code === 190) return 'auth';
    if (code === 10 || (code >= 200 && code <= 299)) return 'permission';
    if (
      code === 4 ||
      code === 17 ||
      code === 32 ||
      code === 613 ||
      code === 80002 ||
      code === 429
    ) {
      return 'rate_limit';
    }
    if (code === 9) return 'rate_limit'; // publishing quota exceeded
    if (code === 100 || code === 24) return 'validation'; // bad parameter / container expired
    if (code === 1 || code === 2 || code === 9007) return 'upstream'; // transient / not-ready-yet
  }

  // 3. HTTP-status fallback when the code is absent/unrecognized.
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status <= 599) return 'upstream';

  // 4. Default.
  return 'upstream';
}

/**
 * Parse a Graph error envelope and map it to an {@link InstagramError}.
 *
 * @param status    HTTP status of the upstream response.
 * @param body      The parsed JSON body (a {@link GraphErrorBody} when well-formed;
 *                  tolerated when malformed — kind then derives from `status`).
 * @param fbtraceId Fallback trace id (e.g. from the `x-fb-trace-id` header) used
 *                  only when the body carries no `error.fbtrace_id`.
 */
export function mapGraphError(status: number, body: unknown, fbtraceId?: string): InstagramError {
  const error = parseErrorEnvelope(body);
  const code = finiteNumber(error.code);
  const subcode = finiteNumber(error.error_subcode);
  const kind = deriveKind(status, code, subcode);

  // Human message: prefer Meta's operator-facing text, then the developer
  // message, then a status-only fallback. Never the raw body (that is `cause`).
  const message =
    nonEmptyString(error.error_user_msg) ??
    nonEmptyString(error.message) ??
    `Instagram Graph API error (HTTP ${status})`;

  return new InstagramError(stripTokens(message), {
    kind,
    status,
    code,
    subcode,
    fbtraceId: nonEmptyString(error.fbtrace_id) ?? fbtraceId,
    cause: body,
  });
}

/**
 * Wrap an arbitrary thrown value into an {@link InstagramError}. Used at the
 * network seam for failures with no Graph envelope — DNS/connect errors,
 * `AbortError`, fetch timeouts — all of which stay `upstream` by default.
 *
 * An existing {@link InstagramError} is returned unchanged (no double-wrapping).
 * The original value is preserved on `cause`; the surfaced message is taken only
 * from an `Error`'s `message`/`name` (or a thrown string) and token-scrubbed —
 * non-`Error` objects are never stringified into the message.
 */
export function toInstagramError(
  err: unknown,
  fallbackKind: ErrorKind = 'upstream',
): InstagramError {
  if (isInstagramError(err)) return err;

  const message =
    err instanceof Error
      ? (nonEmptyString(err.message) ?? nonEmptyString(err.name) ?? 'Unknown error')
      : (nonEmptyString(err) ?? 'Unknown error');

  return new InstagramError(stripTokens(message), { kind: fallbackKind, cause: err });
}
