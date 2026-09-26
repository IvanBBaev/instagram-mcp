/**
 * Graph error mapping (Layer 0). Pure — no network, no logging, no clock.
 * Translates a Meta Graph API error envelope into the single
 * {@link InstagramError} class, deriving the {@link ErrorKind} discriminant
 * per the taxonomy in docs/operations.md §3 (with the throttling code list
 * from §1, the integrity subcode from CC-COM-4 and the `OAuthException`
 * tie-breaker from CC-AUTH-23 / corner-cases.md).
 *
 * Security (docs/security.md §2): the surfaced `message` is built only from
 * Meta's human-readable fields (`error_user_msg`, else `error.message`) — never
 * the raw body, which is retained solely on `cause` for logging. Token-shaped
 * substrings are additionally stripped here, and the text is then bounded and
 * defused by `quoteUntrusted` (`core/untrusted.ts`) — see
 * {@link MAX_GRAPH_MESSAGE_LENGTH} (CC-DATA-91).
 *
 * Where this sits in the redaction boundary — stated precisely, because the note
 * that stood here until 2026-08-30 pointed at a redaction module under `mcp/`
 * that **has never existed**, and called it "the authoritative redaction layer"
 * (CC-PROC-17/19). A comment that hands the problem to a module nobody built is
 * worse than no comment: it stops the next maintainer from looking. The real
 * redactor is `core/redact.ts`. It is applied to the log stream, the
 * per-call log payload, the applied-writes journal, and — since 2026-08-29 — the
 * tool result, by a wrapper in `mcp/registry.ts`. So a message built here is
 * redacted again downstream on every path that reaches a client.
 *
 * This file still strips tokens itself, and that is not redundant: it is a pure
 * Layer-0 mapper, so it cannot depend on `createRedactor`, whose output varies
 * with the process-global secret registry — and an `InstagramError` is read in
 * places that never pass through a sink at all (a `catch` in a CLI, a test).
 * The cost of a second copy is drift, and drift is what actually happened: the
 * copy here recognized `EAA…` and `IGQ…` only, missing `IGAA…` tokens and the
 * 64-hex `appsecret_proof` entirely. The two vocabularies are now pinned to each
 * other behaviourally by a drift test in `test/core/errors.test.ts`.
 */
import { InstagramError, isInstagramError } from './types.js';
import type { ErrorKind, GraphErrorBody } from './types.js';
import { quoteUntrusted, quoteUntrustedString, visibleText } from './untrusted.js';

/** The Graph `error` sub-object — every field is untrusted/optional at runtime. */
type GraphErrorFields = Partial<GraphErrorBody['error']>;

/**
 * Meta secret shapes (docs/security.md §2). Deliberately the *same vocabulary* as
 * `TOKEN_SHAPE_PATTERNS` in `core/redact.ts`, kept as a separate copy because a
 * Layer-0 mapper cannot import a redactor (see the module header), and pinned to
 * it by the drift test in `test/core/errors.test.ts`:
 *  - Facebook Graph tokens start `EAA` followed by a long body.
 *  - Instagram tokens start `IG` — `IGQ…` and `IGAA…` both, which is why the
 *    prefix is `IG` and not the narrower `IGQ` this list carried until
 *    2026-08-30 — plus an alphanumeric family letter: `IG_…` is one of this
 *    server's own environment-variable names, never a token, and an error that
 *    says "set IG_PROFILE_<NAME>_ACCESS_TOKEN" must keep saying it (CC-PROC-72).
 *    A check on the whole run extends that exemption from the front of such a
 *    name to the whole of it. A profile slug can spell `IG` inside itself — `DIGITALSTORE`
 *    does, in `DIGITAL` — and the family-letter rule never looked past the first
 *    two characters, so the run starting at that second `IG` matched: this
 *    mapper answered "set … and retry" with the key truncated at the slug and
 *    the marker spliced onto the stump, naming no key at all. See the head of
 *    `TOKEN_SHAPE_PATTERNS` in `core/redact.ts` for why the exemption is
 *    unbounded and what it costs the backstop (CC-PROC-186), why the `IG_`
 *    it keys on must itself start the run: unanchored, it also exempted a token
 *    glued onto `CONFIG_`, `SIG_` or any other identifier that merely contains
 *    `IG_`, and this mapper handed that token to the model whole — and why it is
 *    a split into runs rather than the lookbehind it replaced, which was
 *    quadratic on a long `IG_`-rooted run and runs here over the whole wire
 *    text, before the length cap (CC-DATA-121).
 *  - `appsecret_proof` is a 64-char hex HMAC-SHA256 with no prefix to key on.
 *    Meta echoes it back in `error.message` on a malformed-parameter failure, so
 *    a prefix-only dictionary cannot see the one secret it is most likely to meet.
 *
 * The length floors keep ordinary prose from matching (`IGNORE` is far too
 * short); where they do over-reach, over-redaction is the preferred failure.
 *
 * Order matters and mirrors `core/redact.ts`: each pattern runs over the previous
 * one's output, and splicing the marker in introduces the word boundaries the
 * `\b`-bounded proof pattern relies on. Both directions are pinned by the drift
 * corpus: a proof abutting an `IG` token is only masked because the IG pattern
 * runs first and splices a boundary in front of it, and an `EAA` token whose body
 * happens to start `IG` is only masked whole because `EAA` runs first.
 *
 * Equivalent-mutant note: adding the `m` flag to the proof pattern is
 * unobservable — it is unanchored, so `m` only changes what `^` and `$` would
 * mean and no input can separate the two. Every other flag here is load-bearing
 * and pinned: `g` on each pattern (a message can carry the same shape twice), and
 * `i` on the proof (hex renders either case) — save the `g` on the IG shape applied
 * inside one run, which is unobservable: a match there runs greedily to the end
 * of the run it starts in, so a run can hold at most one.
 */
const TOKEN_SHAPES: readonly ((text: string) => string)[] = [
  (text) => text.replace(/EAA[A-Za-z0-9_-]{20,}/g, '[redacted]'),
  (text) =>
    text.replace(/[A-Za-z0-9_-]+/g, (run) =>
      run.startsWith('IG_') ? run : run.replace(/IG[A-Za-z0-9][A-Za-z0-9_-]{19,}/g, '[redacted]'),
    ),
  (text) => text.replace(/\b[a-f0-9]{64}\b/gi, '[redacted]'),
];

function stripTokens(text: string): string {
  let out = text;
  for (const mask of TOKEN_SHAPES) {
    out = mask(out);
  }
  return out;
}

/**
 * Longest Graph message text, in code points, an {@link InstagramError} carries
 * (CC-DATA-91). Meta's `error_user_msg` and `error.message` run to a sentence
 * or two — a few hundred characters at the very most — so a real message is
 * never cut. The field itself is unbounded, though, and until 2026-09-24 it was
 * copied whole: a broken proxy or a hostile upstream could put up to the 16 MiB
 * body cap of text into the one line a tool result, a log record or `doctor`
 * renders, and embed newlines, U+2028/U+2029, ANSI escapes or bidi overrides
 * that forge further lines or reorder the reader's view. Past the cap the text
 * is cut between words and its full length stated; every control, format or
 * separator code point becomes a visible `\u{…}` escape.
 *
 * Exported for `cli/login.ts`, whose token-exchange refusal quotes the same
 * Graph field and is bounded by the same cap (CC-DATA-93).
 */
export const MAX_GRAPH_MESSAGE_LENGTH = 1000;

/**
 * Graph free text as a message may carry it: tokens stripped over the WHOLE
 * text first, then bounded and escaped by `quoteUntrusted`.
 *
 * The cut is word-safe (CC-DATA-92), and that is not cosmetic. This mapper
 * sees only token SHAPES; the exact-value registry that masks a 32-hex app
 * secret or a configured bearer runs downstream, on the finished message. A cut
 * through the middle of such a secret would hand that redactor a prefix it can
 * no longer recognise — the cap itself would become the leak. Cutting only at
 * whitespace keeps every secret either whole (and masked downstream) or gone.
 */
function boundGraphText(text: string): string {
  return quoteUntrusted(text, MAX_GRAPH_MESSAGE_LENGTH, stripTokens, { wordSafe: true });
}

/**
 * Upstream free text interpolated into a sentence this server writes — the
 * `status_code` / `status` echoes in `api/publishing.ts` — rendered
 * by the same rule as {@link boundGraphText}, as a double-quoted literal cut at
 * `max` code points: tokens stripped over the whole text first, a word-safe cut,
 * every control, format and separator character escaped, and `"` / `\` escaped
 * so the text cannot close the quotes around it (CC-DATA-95).
 */
export function quoteGraphText(text: string, max: number): string {
  return quoteUntrustedString(text, max, stripTokens, { wordSafe: true });
}

/**
 * The accepted shape of a Graph object id: 1–64 characters, letters, digits,
 * `_` and `-` only. Defined here, in Layer 0, so {@link quoteGraphId} can apply
 * it to ids read off the wire; `tools/ids.ts` re-exports it as the input rule
 * for every id argument and documents why the charset is what it is.
 */
export const GRAPH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Longest id, in code points, {@link quoteGraphId} echoes — the upper bound of
 * {@link GRAPH_ID_PATTERN}, so nothing a real id could be is ever cut.
 */
const MAX_ECHOED_ID = 64;

/**
 * A Graph object id as a message names it (CC-PUB-56). An id that has the
 * {@link GRAPH_ID_PATTERN} shape is returned bare, so every message about a
 * real container reads exactly as it always has. Anything else — an id read off
 * a Graph response that carries a space, a quote, a line feed, a bidi override,
 * or simply runs past 64 characters — is upstream text like any other and is
 * rendered by {@link quoteGraphText}: quoted, escaped and cut word-safe. An id
 * taken from a tool argument already passed the same pattern at the schema, so
 * this only ever changes what a wire id looks like.
 *
 * An overlong id with no whitespace therefore renders as its length alone,
 * `"…" (N characters in all)`, with no prefix. That is kept by decision
 * (CC-DATA-111): a hard cut could split a registered secret that has no token
 * shape, and the exact-value registry downstream would no longer match the
 * surviving prefix (CC-DATA-92).
 */
export function quoteGraphId(id: string): string {
  return GRAPH_ID_PATTERN.test(id) ? id : quoteGraphText(id, MAX_ECHOED_ID);
}

/**
 * Longest trace id, in code points, an {@link InstagramError} carries
 * (CC-DATA-98). Meta's `fbtrace_id` is a short base64-ish token — a few
 * dozen characters — so a real one is never cut. The field and the
 * `x-fb-trace-id` header it falls back to are both upstream text, though, and
 * the id is what an operator copies into a support ticket.
 */
const MAX_TRACE_ID_LENGTH = 128;

function boundTraceId(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : quoteUntrusted(value, MAX_TRACE_ID_LENGTH, undefined, { wordSafe: true });
}

/**
 * The code as `deriveKind` may classify it: an integer, or nothing
 * (CC-DATA-97). Meta's codes are integers, and every rule of the ladder is an
 * integer test — but the permission band is a RANGE, so a fractional `250.5`
 * fell inside `200–299` and was reported as a missing permission, sending the
 * operator to re-grant scopes for a code Meta never defined. The record still
 * carries the value as received (see the "finite but unexpected code" test);
 * only its classification needs it to be one of Meta's.
 */
function classifiableCode(value: number | undefined): number | undefined {
  return Number.isInteger(value) ? value : undefined;
}

/**
 * Equivalent-mutant note: `typeof value === 'number'` cannot be dropped, but
 * dropping it would also change nothing at runtime — `Number.isFinite` performs
 * no coercion and answers `true` only for finite number primitives, so the
 * conjunction is exactly `Number.isFinite(value)`. It is here because `value` is
 * `unknown`: without the `typeof` narrowing TypeScript will not let the `value`
 * branch be returned as `number`. `Number.isFinite` itself is load-bearing and
 * pinned — a `NaN` code would otherwise reach the error record and serialize to
 * `null`, reading as "Meta sent no code" while the field says otherwise.
 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Safely narrow an arbitrary payload to the Graph `{ error: {...} }` envelope.
 *
 * The wrapper is required, not optional: a body that carries `code`/`message` at
 * the top level is some other service's error shape (a proxy, a gateway), and
 * reading it as Graph fields would classify a failure Meta never described.
 * That is pinned by a test, as is the fallback `{}` for everything unparseable.
 *
 * Equivalent-mutant note: of the three conjuncts, only `'error' in body` is
 * unobservable. It re-states what the following `typeof` test decides — reading
 * a missing key yields `undefined`, which is not `'object'` — and it is present
 * because TypeScript will not allow `body.error` on a bare `object` without it.
 * Dropping it is measured equivalent.
 *
 * `typeof error === 'object'` reads like the same kind of type-only narrowing
 * and is not one. Dropping it does not merely surface a primitive instead of
 * `{}`: the value that breaks is `undefined`, which `'error' in body` and
 * `error !== null` both admit, so `{ error: undefined }` would reach the
 * property reads below and throw. `JSON.parse` cannot build that body, but this
 * function takes `unknown` and is exported — and the "malformed bodies do not
 * throw" test pins exactly that input, so the mutation is killed, not survived.
 * A function value is the same case (`typeof` `'function'`, not `'object'`).
 *
 * The `!== null` tests are load-bearing for the same reason and pinned too:
 * `typeof null` is `'object'`, and a `null` body or a `null` `error` would
 * otherwise throw inside the mapper — turning an upstream failure into a crash
 * in the code whose job is to describe it.
 */
function parseErrorEnvelope(body: unknown): GraphErrorFields {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error: unknown = body.error;
    if (typeof error === 'object' && error !== null) return error;
  }
  return {};
}

/**
 * `error.error_subcode` / `error.code` / `error.type` / HTTP status →
 * {@link ErrorKind}, per docs/operations.md §3 (taxonomy table) and §1
 * (throttling code list).
 *
 * Precedence — the most specific signal wins:
 *   1. Known subcodes (a `code` alone would be ambiguous, e.g. 2207051 has no
 *      distinctive code and must never be treated as a throttle).
 *   2. `error.code`.
 *   3. `error.type === 'OAuthException'` → auth (CC-AUTH-23): the tie-breaker
 *      for an authentication failure whose code is absent or unrecognised.
 *   4. HTTP status (401→auth, 403→permission, 429→rate_limit, 5xx→upstream).
 *   5. Default `upstream`.
 *
 * code / subcode / type → kind (docs/operations.md §3):
 *   190                                  → auth        (token expired/invalid/revoked)
 *   10, 200–299                          → permission  (missing scope/permission)
 *   4, 17, 32, 613, 80002, 429           → rate_limit  (throttled — §1 list)
 *   9  / subcode 2207042                 → rate_limit  (publishing quota exceeded)
 *   100                                  → validation  (invalid parameter)
 *   24 / subcode 2207008                 → validation  (container expired — re-create)
 *   9007 / subcode 2207027               → upstream    (media not ready — keep polling)
 *   1, 2, 500-class                      → upstream    (transient Meta-side)
 *   subcode 2207051                      → upstream    (spam/integrity — see the case note)
 *   type OAuthException, no known code   → auth        (dead token — re-authenticate)
 */
function deriveKind(
  status: number,
  code: number | undefined,
  subcode: number | undefined,
  type: string | undefined,
): ErrorKind {
  // 1. Known subcodes (docs/operations.md §3) — more specific than the code.
  switch (subcode) {
    // Spam/integrity restriction (CC-COM-4). `upstream` and deliberately not
    // `rate_limit`: waiting out a backoff does not clear an integrity block, and
    // labelling it a throttle would tell the operator to retry the one thing
    // that deepens the restriction. Be precise about what the kind does and does
    // not deliver, though — `isRetryableKind` in `core/http.ts` treats
    // `upstream` as retryable whenever the call is idempotent, so what actually
    // keeps this subcode out of the retry loop is that it arises on writes
    // (POST/DELETE), which are never retried. The kind alone does not carry
    // "never auto-retried"; the method does.
    case 2207051:
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
  //
  // Equivalent-mutant note: this guard is unobservable at runtime. With `code`
  // undefined every `===` below is false and both `undefined >= 200` and
  // `undefined <= 299` are `NaN` comparisons, so control reaches rule 3 either
  // way. It is here because `code` is `number | undefined` and TypeScript
  // rejects the relational comparisons without the narrowing — and because the
  // numbered rules read as a precedence ladder only if each rung is explicit.
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

  // 3. `error.type` — the OAuthException tie-breaker (CC-AUTH-23).
  //
  // Meta marks every authentication failure `type: 'OAuthException'`, and until
  // 2026-09-19 no source module read that field: a dead token whose envelope
  // carried an absent or unrecognised `code` fell through rule 2 into the status
  // fallback, where HTTP 400 answers `upstream`. `isRetryableKind` in
  // `core/http.ts` treats `upstream` as retryable on an idempotent call, so a
  // GET was then replayed the full three times against a credential that will
  // never work again, and the operator was handed a generic upstream failure
  // with no instruction to re-authenticate — the one diagnosis that ends the
  // outage. Measured before the rule was added: four fetches, three backoffs,
  // kind `upstream`.
  //
  // It sits AFTER the code ladder on purpose. Meta also stamps `OAuthException`
  // on throttles (codes 4, 17, 32) and on permission failures (10, 200–299), and
  // those numbered codes are the more specific signal: a throttled token is not
  // a dead one, and re-authenticating would not clear it. Rule 2 has already
  // decided every one of those before this line runs, so the tie-breaker can
  // only ever classify an envelope the code ladder declined to.
  //
  // The match is exact and case-sensitive. `type` is Meta's own enumerated
  // class name, spelled one way; a lower-cased or padded near-miss is not a
  // spelling Meta emits, and loosening the comparison would let a proxy's or a
  // gateway's own `type` field (which this envelope shape cannot rule out —
  // see `parseErrorEnvelope`) promote an unrelated failure into "re-login".
  // A non-string `type` never reaches here as anything but `undefined`
  // (`mapGraphError` reads it through the same `visibleText` filter as the
  // message fields), so the comparison needs no typeof guard of its own.
  if (type === 'OAuthException') return 'auth';

  // 4. HTTP-status fallback when the code is absent/unrecognized and the type
  //    is not the OAuthException tie-breaker above.
  //
  // Equivalent-mutant note: the three exact-match rules are load-bearing and
  // pinned. The 5xx band is not observable through `kind` — it and rule 5 both
  // answer `upstream`, so no input separates `>= 500` from `> 500`, `<= 599`
  // from `< 599`, or the whole line from its absence. It stays because it states
  // the intent where the decision is made: if the default ever stops being
  // `upstream`, this line is what keeps a 5xx retryable.
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status <= 599) return 'upstream';

  // 5. Default.
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
  // `type` goes through the same filter as the message fields, and deliberately
  // NOT through a trim: `visibleText` returns the value as received, so a
  // padded `' OAuthException'` reaches `deriveKind` padded and fails its exact
  // match there. The filter only turns a non-string or invisible field into
  // `undefined`; it never manufactures a match.
  //
  // Equivalent-mutant note: dropping the filter here — handing `error.type`
  // straight to `deriveKind` — cannot be observed. `type` is consumed by exactly
  // one expression, the `===` against `'OAuthException'`, which performs no
  // coercion: a number, a boolean, `null`, an array or an object compares false
  // there just as `undefined` does, and a blank string is not the class name
  // either. The filter stays because it says what the field is allowed to be at
  // the seam where the envelope is read, and because `deriveKind`'s parameter is
  // typed `string | undefined` — the guarantee, not a cast, is what lets the
  // comparison there need no typeof test of its own. Do not contort a test into
  // "killing" it.
  const type = visibleText(error.type);
  const kind = deriveKind(status, classifiableCode(code), subcode, type);

  // Human message: prefer Meta's operator-facing text, then the developer
  // message, then a status-only fallback. Never the raw body (that is `cause`).
  // A field counts only when it has something a reader can SEE: an
  // `error_user_msg` of zero-width or bidi characters alone used to win over a
  // useful `error.message` and surface as a row of escapes (CC-DATA-96).
  const message =
    visibleText(error.error_user_msg) ??
    visibleText(error.message) ??
    `Instagram Graph API error (HTTP ${status})`;

  return new InstagramError(boundGraphText(message), {
    kind,
    status,
    code,
    subcode,
    fbtraceId: boundTraceId(visibleText(error.fbtrace_id) ?? visibleText(fbtraceId)),
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
      ? (visibleText(err.message) ?? visibleText(err.name) ?? 'Unknown error')
      : (visibleText(err) ?? 'Unknown error');

  // Bounded and escaped like a Graph message (CC-DATA-99). The text is not
  // this server's: a transport error quotes whatever the socket layer, a proxy or
  // a thrown string said, and it reaches the same tool result and log line.
  return new InstagramError(boundGraphText(message), { kind: fallbackKind, cause: err });
}
