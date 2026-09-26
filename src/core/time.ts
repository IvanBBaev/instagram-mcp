/**
 * Epoch-timestamp rendering (Layer 0). The one place that turns a
 * possibly-nonsense epoch-SECONDS value into text a human or a model can read,
 * so the sites that print a token expiry (`token_status`, the `refresh` notice,
 * the `login` notice) do not each grow their own
 * `new Date(x * 1000).toISOString()`.
 *
 * Why it exists at all: those values are UNVALIDATED WIRE DATA. `JSON.parse`
 * turns Meta's `1e400` into `Infinity` — `1e400` is valid JSON, so a truncated
 * or malformed numeric literal is enough and no hostile upstream is required; a
 * corrupt or hand-edited credential record can carry `NaN`; a large but
 * perfectly finite lifetime added to `now` lands past the furthest instant a
 * `Date` can hold; and the slot can hold a value that is not a number AT ALL,
 * because every payload that reaches here was CAST into its wire type rather
 * than validated. `new Date(ms).toISOString()` answers the first three with a
 * bare `RangeError: Invalid time value`, which is NOT an
 * {@link import('./types.js').InstagramError} — no layer above classifies it, so
 * it escapes as a crash out of the very commands an operator runs when they
 * already suspect their token. The fourth is worse than a crash: a non-number
 * that coerces to a finite product renders as a confident, wrong instant.
 * Answering "not knowable" is what keeps the diagnostic alive; it is also
 * literally true.
 *
 * `summarizeTokenExpiry` in `api/account.ts` used to carry a second copy of this
 * guard — same threshold, same clauses, same reasoning — and the copies
 * drifted: a retraction taken there was never propagated here, so for a day the
 * two contradicted each other in their own comments (CC-PROC-165). It now calls
 * {@link isoFromEpochSeconds} instead, which makes that drift impossible rather
 * than merely discouraged. That function still owns the expiry STATE machine;
 * this module owns the "is this an instant at all" question and the rendering.
 */
import { quoteUntrusted } from './untrusted.js';

/**
 * The largest instant a `Date` can hold (ECMA-262: ±8.64e15 ms around the
 * epoch). Beyond it — and for `NaN` or `±Infinity` — `new Date(ms)` is an
 * Invalid Date whose `toISOString()` throws a bare `RangeError`.
 */
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

/**
 * Longest rendering, in code points, {@link describeWireValue} quotes. A value
 * it names is a timestamp, a counter, an id or a scope list — a few dozen
 * characters when it is anything recognisable at all.
 */
const MAX_WIRE_VALUE_LENGTH = 200;

/**
 * An unusable wire value rendered for a diagnostic message. Numbers render as
 * themselves (`1e+300`, `Infinity`, `NaN`); anything else renders as JSON with
 * its `typeof` appended, because the point of naming the value is to let the
 * operator tell WHICH kind of nonsense arrived.
 *
 * Plain interpolation is not enough once non-numbers reach a message, and it
 * produces the worst possible text for two of them: `${[]}` is the empty string,
 * so the warning would read "reported an `expires_at` of , which is…", and
 * `${'0'}` is `0`, which reads as a number that is in fact perfectly
 * representable. `JSON.stringify` keeps the quotes that separate `"0"` from `0`
 * and gives `[]`/`{}` a visible body; the `(type …)` suffix says out loud that
 * the slot did not hold a number, which is the actual fault.
 *
 * Total, because every caller is documented never to throw: `JSON.stringify`
 * answers `undefined` for a function or a symbol and THROWS on a BigInt or a
 * circular structure, and `String` then throws on a circular object with no
 * prototype or a revoked proxy, which render as `[unrenderable]`
 * (CC-DATA-128). None of those can come off `JSON.parse`, the only door wire
 * data uses; they are handled anyway, because a renderer that threw would
 * reintroduce exactly the crash the guards call it to describe.
 *
 * The rendering is then cut at {@link MAX_WIRE_VALUE_LENGTH} code points and
 * escaped by `quoteUntrusted` (CC-DATA-101). `JSON.stringify` is not that
 * rule: it leaves U+2028/U+2029, C1 controls and bidi or zero-width characters
 * as they arrived, and nothing bounds the value — a string or an array the size
 * of the response body was pasted whole into a tool result or a `doctor` line.
 * The cut is word-safe because every caller's output is redacted again
 * downstream (see `QuoteOptions.wordSafe`), and the `(type …)` suffix is appended after it, so a
 * long value can never cut away the one word that names the fault.
 */
export function describeWireValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    // CC-DATA-128: `String` is not total either. A circular object with no
    // prototype (`Object.create(null)`) has no `toString` to fall back on, and a
    // revoked proxy throws on every property read; both made this fallback
    // throw the `TypeError` the `JSON.stringify` attempt had just been caught
    // for. They still say which KIND of value arrived, through the suffix.
    try {
      rendered = String(value);
    } catch {
      rendered = '[unrenderable]';
    }
  }
  const shown = quoteUntrusted(rendered, MAX_WIRE_VALUE_LENGTH, undefined, { wordSafe: true });
  return `${shown} (type ${typeof value})`;
}

/**
 * ISO 8601 rendering of an epoch-SECONDS value: `undefined` when there is
 * nothing to render, and `undefined` again when the value names no instant a
 * `Date` can hold. Total — it never throws, so callers are free to decide what
 * an absent answer should say instead of having to defend against one.
 *
 * `0` is deliberately NOT special here: it is a representable instant (the 1970
 * epoch). "Never expires" is a meaning `expires_at` attaches to zero, not one
 * timestamps have in general, so the callers that carry that sentinel resolve it
 * before they get here.
 */
export function isoFromEpochSeconds(epochSec: number | undefined): string | undefined {
  // The `number` in the signature is a DECLARATION, not a guarantee, and this
  // clause is what makes it one. `token_status` renders `data_access_expires_at`
  // through here straight off the `debug_token` payload, which `req` CASTS into
  // its wire type rather than validating, and `summarizeTokenExpiry` hands over
  // `expires_at` from the same payload — so `null`, `false`, `"0"` or `[]`
  // arrive typed `number` and are not numbers.
  //
  // Every one of those coerces to a finite product (`null`, `false`, `"0"` and
  // `[]` times 1000 are all `0`; `true` gives `1000`; `"1800000000"` a live 2027
  // instant), so the clauses below wave them through and this function would
  // answer with a confident, wrong ISO string. Measured 2026-09-23 against the
  // built tree before this clause existed: `null`, `false`, `true`, `"0"`,
  // `"1800000000"`, `[]` and `[1800000000]` each rendered an instant, and
  // `summarizeTokenExpiry` turned them into `expired` or `valid` — the two
  // answers its own contract rules out. `"0"`, Graph's "never expires" sentinel
  // arriving as a string, became "expired in 1970". A wrong answer is strictly
  // worse here than none: `undefined` is a state every caller already handles.
  //
  // It also subsumes the `epochSec === undefined` clause this function used to
  // open with (`typeof undefined` is `'undefined'`), so one test does the work
  // of two. An absent wire field is still the common case and still why the
  // signature accepts `undefined`; it is just not a separate question from "is
  // this a number".
  if (typeof epochSec !== 'number') return undefined;
  const ms = epochSec * 1000;
  // Both clauses are load-bearing and neither subsumes the other. The magnitude
  // test covers everything too far from the epoch, `±Infinity` included. It does
  // NOT cover `NaN`: every comparison against `NaN` is false, so `NaN` would
  // slip through as representable and `toISOString` would throw on it.
  //
  // Equivalent-mutant note — and note which clause earns it: with the type test
  // above in place, `Number.isNaN(epochSec)` here IS the same predicate as
  // `Number.isNaN(ms)`, because for a NUMBER `x * 1000` is `NaN` exactly when
  // `x` is. That equivalence is not self-contained: it rests on the type test.
  // Before that test existed the rewrite was a live defect — `Number.isNaN`
  // coerces nothing, so it answered `false` for `"soon"` while the product was
  // `NaN`, and `new Date(NaN).toISOString()` threw the bare `RangeError` this
  // module exists to prevent. Delete the type test and this note is false again.
  //
  // Also equivalent: the global `isNaN` in place of `Number.isNaN`. It differs
  // only in coercing its argument, and `ms` is a number whatever `epochSec` was.
  // `Number.isNaN` is kept because no coercion is wanted at a boundary that
  // reads wire data. Both clauses stay written against `ms` because the value
  // about to be handed to `Date` is the one worth checking.
  if (Number.isNaN(ms) || Math.abs(ms) > MAX_TIMESTAMP_MS) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Human-readable, token-free expiry label for the `refresh` notice in
 * `src/index.ts`. `undefined` → `unknown` (the upstream returned no lifetime);
 * `0` → `never` (Graph's "does not expire" sentinel); an unrepresentable value →
 * `unknown` WITH the offending value, because a bare "unknown" there would be
 * indistinguishable from a token that simply came back without a lifetime, and
 * the operator has just had that number written into their credential file.
 *
 * It lives in `core` rather than next to its one call site because `src/index.ts`
 * is an entry point — it wires itself together and starts a transport on
 * evaluation, so it can only be exercised as a spawned PROCESS, and the only
 * value that reaches this function comes from `core/refresh.ts`. Left there, its
 * branches would be reachable only through whatever that module chose to let
 * past. As a pure function beside the guard it is tested directly, on every
 * branch, whatever any other layer filters.
 */
export function expiryLabel(expiresAtSec: number | undefined): string {
  if (expiresAtSec === undefined) return 'unknown';
  // Strict on purpose: `"0"`, `false` and `[]` are not the never-expires
  // sentinel, they are values that are not numbers, and they must fall through
  // to the guard rather than certify an uninspectable token as immortal.
  if (expiresAtSec === 0) return 'never';
  const iso = isoFromEpochSeconds(expiresAtSec);
  if (iso === undefined) {
    return `unknown (upstream reported ${describeWireValue(expiresAtSec)}, which is not a representable timestamp)`;
  }
  return iso;
}

/**
 * The latest token expiry this server records or reads back:
 * 9999-12-31T23:59:59Z in Unix seconds, the last instant with a four-digit ISO
 * year.
 *
 * It is a plausibility ceiling, not the `Date` range. Meta's lifetimes are
 * hours to sixty days, so a real expiry sits many orders of magnitude below it,
 * while the value most likely to land in `IG_TOKEN_EXPIRES_AT` by mistake — an
 * expiry in epoch MILLISECONDS, thirteen digits for any date since 2001 — sits
 * above it. Bounded only by the `Date` range, `1790000000000` read back as a
 * valid token with some twenty million days left, dated in the year 58692.
 * Refusing it is not a guess at what was meant; it is declining to certify a
 * value no exchange produces (CC-AUTH-66).
 */
export const MAX_RECORDED_EXPIRY_SEC = 253_402_300_799;

/**
 * Whether `sec` is a value the expiry record (`IG_TOKEN_EXPIRES_AT`) can carry:
 * `0` ("never expires"), or a whole number of Unix seconds from `1` to
 * {@link MAX_RECORDED_EXPIRY_SEC}. The writers (`login`, `refresh`, through
 * {@link expiryFromLifetime}, and `writeCredentials`) and the reader
 * (`core/config.ts`) share this one predicate, so the store never holds a value
 * its own reader rejects (CC-AUTH-65).
 */
export function isRecordableExpiry(sec: number): boolean {
  return Number.isInteger(sec) && sec >= 0 && sec <= MAX_RECORDED_EXPIRY_SEC;
}

/** A canonical non-negative integer: `0`, or digits with no leading zero. */
const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/;

/**
 * An exchange's `expires_in` as a number of seconds, or `undefined` when the
 * wire slot holds no lifetime (CC-AUTH-69).
 *
 * A number passes through untouched (its range is judged by the caller). A
 * string is read only in its canonical integer spelling: Graph has been seen
 * quoting `expires_in`, and `"5184000"` is the same sixty-day lifetime as
 * `5184000` — dropping it left a freshly minted token with no recorded expiry,
 * so no `expiring_soon` warning could ever fire for it. Every other spelling
 * (a sign, a fraction, an exponent, a radix prefix, whitespace, a leading zero,
 * non-ASCII digits) is refused rather than coerced: `Number()` accepts most of
 * them, and guessing at what a malformed field meant would record an expiry
 * nobody sent. `"0"` is `0`, the never-expires sentinel, exactly as the number
 * is. A digit string too long for a finite double becomes `Infinity`, which the
 * callers already reject.
 */
export function lifetimeFromWire(expiresIn: unknown): number | undefined {
  if (typeof expiresIn === 'number') return expiresIn;
  if (typeof expiresIn === 'string' && CANONICAL_UINT.test(expiresIn)) return Number(expiresIn);
  return undefined;
}

/**
 * The absolute expiry (Unix seconds) of a token an exchange has just returned,
 * from its relative `expires_in` and the clock (unix ms) — the ONE reading of
 * `expires_in` that `login` and `refresh` share (CC-AUTH-64):
 *
 *  - Read through {@link lifetimeFromWire}: a number, or a canonical
 *    non-negative integer string (`"5184000"`), is a lifetime. Anything else
 *    (absent, `null`, any other string, an object) ⇒ `undefined`: no lifetime
 *    was given, and the record is removed rather than guessed.
 *  - Exactly `0` (or `-0`) ⇒ `0`, "never expires" — `debug_token`'s own
 *    convention for `expires_at`, and the only coherent reading on a SUCCESSFUL
 *    exchange: Meta does not mint a token that is dead at birth. If it ever
 *    did, the next Graph call's code 190 is the authority on a dead token, not
 *    this record.
 *  - Any other finite lifetime ⇒ `floor(now + expires_in)` in seconds, flooring
 *    the whole sum so a fractional lifetime or clock never stamps the token
 *    later than it dies. A negative lifetime is therefore a past instant and
 *    reads back as expired, never as "never".
 *  - A sum that is not a recordable instant ⇒ `undefined`: `NaN`, `±Infinity`,
 *    anything past {@link MAX_RECORDED_EXPIRY_SEC}, and anything at or before
 *    the epoch. The last would otherwise be written as a negative record the
 *    reader rejects, or — at exactly `0` — as "never expires" for a token the
 *    upstream had just called expired.
 */
export function expiryFromLifetime(expiresIn: unknown, nowMs: number): number | undefined {
  const lifetime = lifetimeFromWire(expiresIn);
  if (lifetime === undefined) return undefined;
  if (lifetime === 0) return 0;
  const at = Math.floor(nowMs / 1000 + lifetime);
  // `at > 0` keeps a computed instant off the never-expires sentinel;
  // `isRecordableExpiry` rejects `NaN`, `±Infinity` and the magnitude.
  return at > 0 && isRecordableExpiry(at) ? at : undefined;
}
