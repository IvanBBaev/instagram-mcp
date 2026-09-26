/**
 * Secret redaction (Layer 0). A pure, dependency-free redactor that deep-clones
 * its input and masks secret values before anything is serialized to logs,
 * error payloads, or MCP results. See docs/security.md §2 and the security
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
 *      registered, as a best-effort backstop for the mint→register window.
 *
 * The redactor never mutates its input: it returns a fresh deep copy. Inputs are
 * expected to be JSON-like (log fields, Graph responses): objects, arrays,
 * strings, and primitives.
 */

/** The fixed marker that replaces every redacted secret. */
export const REDACTED = '[REDACTED]';

/** Marker substituted when a reference cycle is detected (defensive guard). */
const CIRCULAR = '[Circular]';

/**
 * Key-name test (case-insensitive substring): the value of any object key whose
 * name contains one of these is masked wholesale. Mirrors docs/security.md §2
 * and the secret env vars in docs/architecture.md §12.
 *
 * Equivalent-mutant note: adding the `m` flag here is unobservable. `m` only
 * changes what `^` and `$` mean, and this pattern is unanchored, so no input can
 * tell the two apart. The `i` flag, by contrast, is load-bearing and pinned.
 * Four of the five alternatives are underscore-spelled (`authorization` is one
 * word and needs no variant); the hyphenated header forms
 * (`app-secret`, `client-secret`) are deliberately out of scope — see the
 * "matches as a substring" test for why that is safe for this server's own
 * request builder and where it stops being safe.
 */
const SECRET_KEY_PATTERN = /access_token|appsecret_proof|app_secret|client_secret|authorization/i;

/**
 * Token-shape backstop patterns for free strings (docs/security.md §2; F-4):
 *  - Facebook Graph tokens start `EAA` followed by a long token body.
 *  - Instagram tokens start `IG` plus an alphanumeric family letter (`IGQ…`,
 *    `IGAA…`) followed by a long body. TWO rules keep that shape off this
 *    server's own `IG_*` environment-variable names, which clear the length
 *    floor (`IG_PROFILE_<NAME>_ACCESS_TOKEN`) and turn up in exactly the
 *    diagnostics an operator must read verbatim — the unrecognised-name warning
 *    at startup (CC-CFG-13) and a "set IG_…" error. Requiring the third
 *    character to be alphanumeric excludes the `IG_` at the FRONT of such a
 *    name; until 2026-09-19 that class admitted `_` and the names came out
 *    whole as `[REDACTED]` (CC-PROC-72). The run rule excludes a SECOND `IG`
 *    further inside the name, which the front rule never looked at: a profile
 *    slug can spell `IG` inside itself — `DIGITALSTORE` does, in `DIGITAL` —
 *    which puts a token-shaped run in the MIDDLE of the key, `IG` plus 22 more
 *    name characters, two past the floor. The pattern matched there, so the key
 *    came out truncated at the embedded `IG` with the marker spliced onto the
 *    stump and named nothing: CC-PROC-72 over again, now keyed on the operator's
 *    own profile names, and invisible to a corpus whose only fixtures
 *    (`DEFAULT`, `BRAND`) are the two spellings with no embedded `IG`
 *    (CC-PROC-186). The gate in `test/env-catalog.test.ts` had already met the same
 *    hazard from the other side and anchored its own `IG_` scanner so it could
 *    not start mid-identifier; the lesson never came back here.
 *
 *    The exemption asks whether the run the match sits in begins `IG_`, which
 *    is the precise statement of "this is a name we own" and costs the backstop
 *    nothing measurable: a token reached through any delimiter — `=`, a quote,
 *    `/`, `?`, `&`, whitespace, the spliced marker — has no `IG_`-rooted run
 *    behind it and is still masked, as is one glued onto an unrelated identifier
 *    (`cursor7IGQ…`). It is unbounded on purpose: a `{0,64}` bound reads as the
 *    tighter rule but silently resumes eating names once the profile slug pushes
 *    the embedded `IG` past the bound.
 *
 *    "Begins" is literal — `startsWith` on the maximal run: the `IG_` must
 *    itself start the run. Without it the exemption fired for ANY `IG_`
 *    earlier in the run, so a token glued onto an identifier that merely
 *    contains one — `CONFIG_`, `SIG_`, `ORIG_` — was printed whole. That is the
 *    same unanchored-`IG_` hazard the environment-name scanners in the test gates
 *    already spell `(?<![A-Za-z0-9_])IG_`; here the run class also carries `-`.
 *    The class itself is the name alphabet and every member is pinned: a
 *    profile slug is whatever follows `IG_PROFILE_` in the environment, digits,
 *    hyphens and lowercase included.
 *
 *    The exemption is a check on the whole run, not a lookbehind (CC-DATA-121).
 *    Until 2026-09-26 it was spelled `(?<!(?<![A-Za-z0-9_-])IG_[A-Za-z0-9_-]*)`
 *    after the third character, which states the same rule but rescans the run
 *    back to its start at every `IG<alnum>` candidate: a run that begins `IG_`
 *    and then repeats `IGa` is exempt at every candidate, so every candidate
 *    paid a walk back to the front — quadratic, 2.7 s on 64 000 characters and
 *    15 s on 200 000, inside the synchronous redactor that every tool argument,
 *    log line and upstream string passes through. The split below is linear and
 *    equal on every input: a candidate's `IG` is followed by an alphanumeric, so
 *    it never starts an `IG_` run itself, and the greedy body cannot leave the
 *    run it starts in, so "the maximal run begins `IG_`" is exactly what the
 *    lookbehind asked. A differential test holds the two spellings equal.
 *  - `appsecret_proof` is a 64-char hex HMAC-SHA256 with no distinguishing prefix.
 * The length thresholds are set high enough that ordinary words (e.g. `IGNORE`)
 * cannot match; over-redaction is preferred to under-redaction here — a long
 * `IGNORE_…` identifier is still masked, and only a name this server itself owns
 * is not: an `IG_`-rooted run, or an `IG-` one.
 *
 * Order matters: each pattern runs over the output of the previous one, and
 * substituting the marker introduces word boundaries that the `\b`-bounded proof
 * pattern needs. See the "token-first" test.
 *
 * Equivalent-mutant note: adding the `m` flag to the proof pattern is
 * unobservable — it is unanchored, so `m` changes nothing. Its `g` and `i` flags
 * and both `\b`s are load-bearing and pinned by tests. Dropping the `g` from the
 * IG shape applied inside a run is equally unobservable: a match there runs
 * greedily to the end of the run it starts in, so a run holds at most one. The
 * `g` on the split into runs is load-bearing.
 */
const TOKEN_SHAPE_PATTERNS: readonly ((text: string) => string)[] = [
  (text) => text.replace(/EAA[A-Za-z0-9_-]{20,}/g, REDACTED),
  (text) =>
    text.replace(/[A-Za-z0-9_-]+/g, (run) =>
      run.startsWith('IG_') ? run : run.replace(/IG[A-Za-z0-9][A-Za-z0-9_-]{19,}/g, REDACTED),
    ),
  (text) => text.replace(/\b[a-f0-9]{64}\b/gi, REDACTED),
];

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
  for (const mask of TOKEN_SHAPE_PATTERNS) {
    out = mask(out);
  }
  return out;
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
