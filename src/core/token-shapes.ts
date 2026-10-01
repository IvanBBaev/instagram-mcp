/**
 * The token-shape vocabulary (Layer 0). Pure, dependency-free, and the ONE list
 * of Meta secret shapes this server recognizes in free text — shared by the
 * redactor (`core/redact.ts`, marker `[REDACTED]`) and the Graph error mapper
 * (`core/errors.ts`, marker `[redacted]`). See docs/security.md §2 and the
 * security review's finding F-4.
 *
 * Why a module of its own (CC-PROC-19). Until 2026-09-30 the two consumers each
 * held a copy, pinned to each other by a behavioural drift test over a fixed
 * corpus. The first copy in `errors.ts` was strictly weaker than the one in
 * `redact.ts` — it missed `IGAA…` tokens and the 64-hex `appsecret_proof`
 * entirely — and the drift test that followed was corpus-bound by construction:
 * five rewrites of the `IG` and `EAA` patterns survived it until 2026-09-22, two
 * of which shipped the tail of a live token to the model. A shared list removes
 * that class rather than fencing it. The mapper cannot simply call
 * `createRedactor`: it is a pure Layer-0 function, the redactor's output varies
 * with the process-global secret registry, and an `InstagramError` is read in
 * places that never pass through a sink at all (a `catch` in a CLI, a test). So
 * the list lives here, with no imports, and the marker is a parameter — each
 * consumer keeps its own spelling.
 *
 * The shapes:
 *  - Facebook Graph tokens start `EAA` followed by a long token body.
 *  - Instagram tokens start `IG` plus an alphanumeric family letter (`IGQ…`,
 *    `IGAA…`) followed by a long body. TWO rules keep that shape off this
 *    server's own `IG_*` environment-variable names, which clear the length
 *    floor (`IG_PROFILE_<NAME>_ACCESS_TOKEN`) and turn up in exactly the
 *    diagnostics an operator must read verbatim — the unrecognised-name warning
 *    at startup (CC-CFG-13) and a "set IG_… and retry" error. Requiring the third
 *    character to be alphanumeric excludes the `IG_` at the FRONT of such a
 *    name; until 2026-09-19 that class admitted `_` and the names came out
 *    whole as the marker (CC-PROC-72). The run rule excludes a SECOND `IG`
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
 *    log line and upstream string passes through, and inside the error mapper,
 *    which runs over the whole wire text before the length cap. The split below
 *    is linear and equal on every input: a candidate's `IG` is followed by an
 *    alphanumeric, so it never starts an `IG_` run itself, and the greedy body
 *    cannot leave the run it starts in, so "the maximal run begins `IG_`" is
 *    exactly what the lookbehind asked. Differential tests hold the two
 *    spellings equal.
 *  - `appsecret_proof` is a 64-char hex HMAC-SHA256 with no distinguishing
 *    prefix. Meta echoes it back in `error.message` on a malformed-parameter
 *    failure, so a prefix-only dictionary cannot see the one secret the error
 *    mapper is most likely to meet.
 *
 * The length thresholds are set high enough that ordinary words (e.g. `IGNORE`)
 * cannot match; over-redaction is preferred to under-redaction here — a long
 * `IGNORE_…` identifier is still masked, and only a name this server itself owns
 * is not: an `IG_`-rooted run, or an `IG-` one.
 *
 * Order matters: each pattern runs over the output of the previous one, and
 * splicing the marker in introduces the word boundaries the `\b`-bounded proof
 * pattern needs. Both directions are pinned: a proof abutting an `IG` token is
 * only masked because the IG pattern runs first and splices a boundary in front
 * of it, and an `EAA` token whose body happens to start `IG` is only masked
 * whole because `EAA` runs first. Both markers in use are bracketed, and a
 * bracket is outside every class here, which is what makes the splice a
 * boundary; a marker made of word characters would silently undo that.
 *
 * Equivalent-mutant note: adding the `m` flag to the proof pattern is
 * unobservable — it is unanchored, so `m` changes nothing. Its `g` and `i` flags
 * and both `\b`s are load-bearing and pinned by tests (a message can carry the
 * same shape twice, and hex renders in either case). Dropping the `g` from the
 * IG shape applied inside a run is equally unobservable: a match there runs
 * greedily to the end of the run it starts in, so a run holds at most one. The
 * `g` on the split into runs and on the `EAA` shape is load-bearing.
 */

/**
 * Mask every token-shaped substring of `text` with `marker`, applying the
 * shapes in their load-bearing order (see the module header).
 *
 * `marker` is passed to `String.prototype.replace` as a replacement STRING, so a
 * `$` in it would be read as a substitution pattern; both callers pass a fixed
 * bracketed literal with none.
 */
export function maskTokenShapes(text: string, marker: string): string {
  let out = text.replace(/EAA[A-Za-z0-9_-]{20,}/g, marker);
  out = out.replace(/[A-Za-z0-9_-]+/g, (run) =>
    run.startsWith('IG_') ? run : run.replace(/IG[A-Za-z0-9][A-Za-z0-9_-]{19,}/g, marker),
  );
  return out.replace(/\b[a-f0-9]{64}\b/gi, marker);
}
