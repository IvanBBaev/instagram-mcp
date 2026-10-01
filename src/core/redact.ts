/**
 * Secret redaction (Layer 0). A pure redactor, depending on nothing but the
 * sibling token-shape list, that deep-clones its input and masks secret values
 * before anything is serialized to logs, error payloads, or MCP results. See docs/security.md §2 and the security
 * review's finding F-4 (redaction must cover runtime-minted tokens and
 * `appsecret_proof` HMACs, not only statically-configured secrets).
 *
 * Three redaction mechanisms, in order of reliability:
 *   1. Exact registered secrets — every real secret value is registered the
 *      instant it exists (config load, `login`/`refresh` mint) and is then
 *      masked wherever it appears inside any string. This is the primary
 *      mechanism (F-4: "make exact-value redaction the primary mechanism").
 *   2. Secret-named keys — the value of any object key whose name matches
 *      {@link SECRET_KEY_PATTERN} is masked wholesale, regardless of content.
 *   3. Token-shape patterns — Facebook (`EAA…`) and Instagram (`IG…`) tokens and
 *      64-hex `appsecret_proof` HMACs are masked in free text even when not
 *      registered, as a best-effort backstop for the mint→register window. The
 *      vocabulary is `core/token-shapes.ts`, shared with `core/errors.ts`.
 *
 * The redactor never mutates its input: it returns a fresh deep copy. Inputs are
 * expected to be JSON-like (log fields, Graph responses): objects, arrays,
 * strings, and primitives.
 */

import { maskTokenShapes } from './token-shapes.js';

/** The fixed marker that replaces every redacted secret. */
export const REDACTED = '[REDACTED]';

/** Marker substituted when a reference cycle is detected (defensive guard). */
const CIRCULAR = '[Circular]';

/**
 * Key-name test (case-insensitive substring): the value of any object key whose
 * name contains one of these is masked wholesale. Mirrors docs/security.md §2
 * and the secret env vars in docs/architecture.md §12.
 *
 * Separator-insensitive (CC-DATA-124). The three compound names match with an
 * underscore, a hyphen or nothing between their halves, so the wire spelling
 * (`access_token`), a header spelling (`x-ig-app-secret`) and a code-built
 * camelCase field (`accessToken`, `appSecret`, `clientSecret`,
 * `appsecretProof`) are all masked; with `i` the camelCase capital is free.
 * Until 2026-09-30 only the underscore forms matched, so a secret under an
 * options object's `appSecret` — or an `err.cause` logged whole — was masked
 * only if it happened to be registered or token-shaped, and the 32-hex app
 * secret is neither before `registerSecret` runs. `authorization` is one word
 * and needs no variant, and `appsecret_proof` needs no alternative of its own:
 * the separator-free `appsecret` head of every spelling of it is already an
 * `app[_-]?secret` match. Spelling it out anyway would be a branch no input can
 * reach, which mutation testing reports as a survivor.
 *
 * Equivalent-mutant note: adding the `m` flag here is unobservable. `m` only
 * changes what `^` and `$` mean, and this pattern is unanchored, so no input can
 * tell the two apart. The `i` flag, by contrast, is load-bearing and pinned, as
 * is every `?` and each member of every separator class.
 */
const SECRET_KEY_PATTERN = /access[_-]?token|app[_-]?secret|client[_-]?secret|authorization/i;

/**
 * Registrations shorter than this are ignored. Empty and short strings are
 * common substrings; registering one would mask unrelated output (an empty
 * string would mask everything). Every real secret in this server (access
 * tokens, the 32-hex app secret, the 64-hex proof, the HTTP bearer) is longer.
 */
const MIN_REGISTERED_SECRET_LENGTH = 8;

/**
 * Module-level registry of exact secret values. Mutable and updated atomically
 * on mint/refresh so a redactor built at startup masks tokens registered later
 * (F-4: "register every secret with the redactor the instant it exists").
 */
const registry = new Set<string>();

/**
 * Register a secret so every subsequent redaction masks it wherever it appears.
 * Call the instant a secret exists — on config load and inside the
 * `login`/`refresh` mint path, before the new token can be persisted or thrown.
 * Empty and short strings are ignored (registering `''` would mask everything).
 */
export function registerSecret(secret: string): void {
  if (typeof secret !== 'string') return;
  if (secret.length < MIN_REGISTERED_SECRET_LENGTH) return;
  registry.add(secret);
}

export interface RedactorOptions {
  /** Extra exact secrets scoped to this redactor (merged with the global registry). */
  extraSecrets?: string[];
}

/**
 * Build a redactor: a pure function that deep-clones `value` and returns a copy
 * with every secret masked, never mutating the original. The returned function
 * reads the global registry live on each call, so a redactor created at startup
 * still masks tokens registered later at runtime (F-4).
 */
export function createRedactor(opts?: RedactorOptions): (value: unknown) => unknown {
  const extra = new Set<string>();
  for (const s of opts?.extraSecrets ?? []) {
    if (typeof s === 'string' && s.length >= MIN_REGISTERED_SECRET_LENGTH) extra.add(s);
  }
  return (value: unknown): unknown => {
    // Longest-first so a secret that contains another is masked first.
    const secrets = [...new Set([...registry, ...extra])].sort((a, b) => b.length - a.length);
    return redactValue(value, secrets, new WeakSet<object>());
  };
}

/**
 * Every spelling of `value` that can appear in a surfaced string: the credential
 * as the caller holds it, and the credential as `buildUrl` wrote it into a
 * query. Pass both to {@link RedactorOptions.extraSecrets}. Used by
 * `core/refresh.ts` and `cli/login.ts`, whose exchanges put the same credentials
 * through the same encoder (CC-AUTH-76). It lived in `core/refresh.ts` until
 * 2026-09-30, which made the login CLI import a redaction rule from a
 * token-exchange module; it is a fact about what the redactor must be handed,
 * so it lives beside the redactor (the wave-18 open question).
 *
 * `createRedactor` masks **exact substrings** — there is no shape matching for a
 * registered secret, by design (see the module header). `buildUrl` serialises the
 * query with `URLSearchParams`, which form-encodes it: `+` becomes `%2B`, `/`
 * becomes `%2F`, `=` becomes `%3D`, a space becomes `+`. So registering only the
 * raw value masked a credential that survived encoding unchanged and missed the
 * same credential once it had been through the URL — the exact string a
 * transport that names the failing request puts in its message. Registering both
 * spellings is what makes the "no credential VALUE reaches an
 * operator-visible message" guarantee hold for a credential the caller did not
 * choose the alphabet of, rather than only for one that happens to be URL-safe.
 * (A hex app secret and an `EAA…` token are URL-safe; an arbitrary stored token, which is
 * all an exchange is promised, is not.)
 *
 * Both spellings are returned unconditionally, even when they are identical:
 * `createRedactor` de-duplicates through a `Set`, so the duplicate costs
 * nothing, and a `raw === encoded ? … : …` test would add a branch whose two
 * arms produce the same redaction for every input.
 *
 * Equivalence note, corrected on 2026-09-23: the `'v'` key is a placeholder with
 * no observable identity, but NOT for "any single-character name" — only for one
 * the form encoder leaves alone. `URLSearchParams` percent-encodes the KEY as
 * well as the value, so a name outside `[0-9A-Za-z*._-]` widens the `<name>=`
 * prefix past the fixed `'v='.length` slice: `'%'` serialises as `%25=<encoded>`
 * and the slice then yields `5=<encoded>`, registering a mask that matches
 * nothing the transport will ever print. Measured 2026-09-23: renaming the key to
 * `'%'` is killed by "a credential is masked in BOTH the spelling it has and the
 * spelling the URL has". Inside the URL-safe alphabet the rename is genuinely
 * unobservable — the name encodes to itself and the same two-character slice
 * strips it.
 * The slice length is NOT equivalent and is pinned: taking one character less
 * registers `=<encoded>` instead of `<encoded>`, which still masks the value
 * inside a URL (where a `=` always precedes it) and masks nothing at all in the
 * message where Meta quotes the value back on its own.
 */
export function surfaceForms(value: string): readonly string[] {
  const encoded = new URLSearchParams([['v', value]]).toString().slice('v='.length);
  return [value, encoded];
}

/**
 * Mask exact registered secrets, then token-shape patterns, inside one string.
 *
 * Each round matches against `out`, not against `input`: the marker is spliced
 * into the text, so a registered secret can straddle it and exist only in the
 * partially-masked string.
 *
 * Equivalent-mutant note: the `out.includes(secret)` test is a fast path, not a
 * guard. `split(needle).join(marker)` on a string that does not contain `needle`
 * returns the string unchanged, and no secret can be empty
 * ({@link MIN_REGISTERED_SECRET_LENGTH} rejects short registrations), so dropping
 * the test cannot change any output.
 */
function redactString(input: string, secrets: readonly string[]): string {
  let out = input;
  for (const secret of secrets) {
    // split/join avoids treating secret characters as a regex.
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  // The token-shape backstop: the one vocabulary shared with the Graph error
  // mapper, whose doc says which shapes and why (CC-PROC-19).
  return maskTokenShapes(out, REDACTED);
}

/**
 * Deep-clone `value`, masking secrets; `seen` guards against reference cycles.
 *
 * `seen` is the path being walked, not every node ever visited — it unwinds in
 * the `finally`, so a node reachable twice is redacted twice rather than reported
 * as `[Circular]`, and one set is threaded through arrays and objects alike.
 *
 * Equivalent-mutant note: `val !== null && val !== undefined` and `val != null`
 * are the same predicate (loose equality against `null` is true for exactly
 * `null` and `undefined`), so the spelling cannot be observed from any input.
 * The guard itself is load-bearing and pinned: without it a secret-named key
 * whose value is `null` would be reported as a masked secret that never existed.
 *
 * A boxed primitive is unwrapped to the primitive it holds, as `JSON.stringify`
 * does (CC-DATA-122). Walked as an object, a `new String(token)` came out as its
 * index keys — `{"0":"E","1":"A",…}` — one character per value, so neither the
 * registry nor a token shape could see the secret, and every character of it
 * reached the sink; `new Number` and `new Boolean` came out as `{}`. This is
 * CC-AUTH-47's boxed string one level down, where the logger's top-level guard
 * never looks.
 */
function redactValue(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value instanceof String) return redactString(value.valueOf(), secrets);
  if (value instanceof Number || value instanceof Boolean) return value.valueOf();
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, secrets, seen));
    }
    // An INHERITED `toJSON` is what `JSON.stringify` would have written, so the
    // clone is built from its result (CC-DATA-123). Walked as an object, a `Date`
    // and a `URL` came out as `{}` — they hold no own enumerable fields — and a
    // `Buffer` as its index keys, bytes no token shape can see. The call is made
    // here, BEFORE redaction, and its result is redacted like any value, so the
    // own-`toJSON` rule below (which exists because a call AFTER redaction would
    // write whatever it returns, unmasked — CC-AUTH-48) is untouched. A `toJSON`
    // that returns its own receiver is ignored: the fields are walked instead,
    // which is what `JSON.stringify` then writes too. `JSON.stringify` passes
    // the property key; this has none to pass, and `Date`, `URL` and `Buffer`
    // all ignore it.
    const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function' && !Object.hasOwn(value, 'toJSON')) {
      // A `Buffer` serialises to its bytes as numbers. Those are decoded and
      // checked as text first: bytes that spell a secret mask the whole buffer
      // as a unit, because no number in the array could be masked on its own.
      if (value instanceof Uint8Array) {
        const text = new TextDecoder().decode(value);
        if (redactString(text, secrets) !== text) return REDACTED;
      }
      const json: unknown = toJSON.call(value, '');
      if (json !== value) return redactValue(json, secrets, seen);
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      // An own `toJSON` function is not copied: `JSON.stringify` would call it on
      // the clone AFTER redaction and write whatever it returns, unmasked. The
      // clone serialises from its (redacted) fields instead.
      if (key === 'toJSON' && typeof val === 'function') continue;
      // Keys are text the serialiser writes too, so a token used as a key is
      // masked like any value.
      //
      // Defined, never assigned (CC-DATA-107). `JSON.parse` makes an own
      // `__proto__` key an ordinary data property, but `out['__proto__'] = v`
      // is the prototype setter: an object value became the clone's prototype
      // and a primitive was ignored, so the key vanished from the clone and
      // from every text re-serialized from it. `defineProperty` keeps it as
      // data, redacted like any other key, and never touches a prototype. All
      // three flags are what assignment would have produced: `enumerable` so
      // it serialises, `writable` so a later key that masks to the same
      // spelling overwrites it as assignment did and a caller can update it,
      // `configurable` so a caller can delete it.
      Object.defineProperty(out, redactString(key, secrets), {
        value:
          SECRET_KEY_PATTERN.test(key) && val !== null && val !== undefined
            ? REDACTED
            : redactValue(val, secrets, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
