/**
 * The env-file format of the credential store (Layer 0): how a value is quoted
 * for the file, how an assignment is recognised on a line, how a profile's keys
 * are merged into existing text, and the read-back check that refuses a merge
 * dotenv would not parse back as intended.
 *
 * Pure text in, text out — nothing here touches the filesystem. The store's I/O
 * is `core/atomic-write.ts`, its lock `core/config-lock.ts`, and the write that
 * ties them together {@link import('./config-write.js').writeCredentials}.
 * Moved unchanged from `core/config-write.ts` on 2026-10-27.
 */
import { parse as parseEnv } from 'dotenv';

import { InstagramError } from './types.js';

/**
 * Format a value for the env file so `dotenv` parses it back verbatim AND a POSIX
 * shell that `source`s the file assigns it without running any of it. Simple
 * token/secret shapes are emitted bare. Otherwise SINGLE quotes are preferred:
 * both readers treat a single-quoted value as a literal (no escape processing,
 * no expansion), so spaces, `=`, `#`, `$`, backticks, backslashes and embedded
 * double quotes round-trip exactly. A value holding a single quote or a CR/LF —
 * which must be escaped to stay on one physical line — goes in DOUBLE quotes,
 * where `dotenv` reverses `\n` / `\r` but un-escapes nothing else. That form is
 * emitted only when the value holds none of `$`, `` ` ``, `"` and `\`, the four
 * characters a shell still acts on inside double quotes; for any other value
 * this returns `undefined` and
 * {@link import('./config-write.js').writeCredentials} refuses the write.
 *
 * Corner case (CC-CFG-59): the store is sourceable (`mergeEnv` keeps `export`
 * for exactly that reason, CC-PROC-176), and the fallbacks this replaced were
 * not. A value holding a `'` went in backticks — command substitution to a
 * shell — so `x'; touch f` ran `touch f` on `source`; one holding both `'` and a
 * backtick went in double quotes, where the backticks ran just the same. No
 * spelling is literal to both readers once `'` meets one of those four: dotenv
 * has no escape for a quote inside its quoted forms, and `'\''` is not dotenv
 * syntax. Refusing is safe in practice — the values written here are Meta ids,
 * tokens and app secrets, none of which contain these characters — and it is
 * loud, before anything is written. A CR/LF value still reads back through a
 * shell as the two characters `\` + `n`: a different value, never a command.
 *
 * Corner case (CC-CFG-53): the double-quoted form used to be the ONLY fallback
 * for a single quote, and it cannot carry everything. dotenv does not un-escape
 * `\"`, so a value with `'`, `"` and `#` (`it's "a" #1`) closed at its inner `"`
 * and read back as `it's "a`; and a literal `\` + `n` beside a `'` came back as a
 * real newline. Both are now refused here; {@link assertReadsBack} still catches
 * a value that runs into a hand-edited line of the file.
 *
 * Equivalent-mutant note: two mutations of this function survive the whole suite
 * and neither is observable. Tightening the bare-value class to `+` differs only
 * on the empty string, and the sole caller is `buildUpdates`'s `set`, which runs
 * `clean()` first — that maps a blank value to `undefined`, so `formatValue('')`
 * is unreachable. Swapping the two escape passes is unobservable for EVERY input:
 * a CR is replaced by the two characters `\` + `r` and an LF by `\` + `n`, and
 * neither replacement contains a CR or an LF, so neither pass can create or
 * destroy a match for the other. A CRLF pair renders as `\r\n` in both orders.
 */
export function formatValue(value: string): string | undefined {
  if (/^[A-Za-z0-9_@%+./:=~-]*$/.test(value)) return value;
  if (!/['\r\n]/.test(value)) return `'${value}'`;
  if (/[$`"\\]/.test(value)) return undefined;
  const escaped = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * The assignment on an env-file line — the `export`/indentation prefix and the
 * key (`KEY=...` or `KEY: ...`, optional `export`) — else undefined.
 *
 * Both separators are dotenv's: its parser reads `KEY: value` (a colon right
 * after the key, then whitespace) as an assignment too. Recognising only `=`
 * left such a line untouched, so `login` appended the fresh token below it and
 * the superseded one stayed on disk in plaintext (CC-CFG-78). The colon form is
 * rewritten as `KEY=value`, which is also the only one a shell can `source`.
 *
 * The prefix is returned rather than discarded because {@link mergeEnv} replaces
 * the VALUE on a line, not the line. Recognising a leading `export ` and then
 * dropping it on the way back out silently downgrades an exported variable to a
 * local one: `source`ing the repaired file sets nothing in any child process,
 * while `cat` shows a perfectly fresh token (CC-PROC-176).
 *
 * Equivalent-mutant note: admitting a digit as the first character
 * (`[A-Za-z0-9_]`) and demanding a second character (`*` -> `+`) both survive the
 * suite, and neither can be told apart from this pattern. The only use of the
 * returned key is a lookup in `mergeEnv`'s `updates` map, and every key in that
 * map comes from `envVarFor`: `IG_<SUFFIX>` or `IG_PROFILE_<NAME>_<SUFFIX>`,
 * always letter-leading and never shorter than three characters. A line the
 * mutated pattern classifies differently therefore always misses the map, and
 * `mergeEnv` returns it verbatim on both paths.
 */
function assignmentOn(line: string): { prefix: string; key: string } | undefined {
  // The key class is dotenv's own (`[\w.-]`), not the POSIX identifier class. A
  // profile name may carry `-` or `.` (CC-AUTH-18: `Second-Studio`), and dotenv
  // reads the `IG_PROFILE_<NAME>_ACCESS_TOKEN` key it produces, hyphen and all,
  // from the file. With the narrower class that line was never recognised, so
  // every `login`/`refresh` appended a fresh assignment below it and left the
  // superseded token on disk in plaintext.
  const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(?:\s*=|:(?=\s))/.exec(line);
  const prefix = match?.[1];
  const key = match?.[2];
  // Both groups are non-optional in the pattern above, so a match always fills
  // both, and only a non-match reaches the refusal below — the `key` half of the
  // test is evaluated on every matching line and can never be true. It is still
  // written out rather than assumed, for two measured reasons. Deleting it does
  // not compile: `key` stays `string | undefined` and the return type refuses it.
  // And writing it instead as a `?? ''` default would leave a range no input can
  // execute, which drops branch coverage below the gate — the two defaults this
  // replaced cost exactly that, and the honest fix is a guard the suite reaches,
  // not an exclusion.
  if (prefix === undefined || key === undefined) return undefined;
  return { prefix, key };
}

/**
 * Merge `updates` into the existing env-file text: replace the VALUE of EVERY
 * assignment of a key already present, keeping the rest of that line — its
 * indentation and any leading `export ` — and preserving every comment, blank
 * line, and unrelated key; append the keys that were not present at the end;
 * drop every assignment of a key in `removals`. A fresh file gets a short header.
 *
 * One byte-level normalisation is deliberate: {@link assignmentOn} accepts
 * `KEY = value` and dotenv's `KEY: value`, and the rewrite emits `KEY=value`. A
 * POSIX shell reads either form as a command invocation, so collapsing it is what
 * makes a file this module has touched a file `source` can still read.
 */
export function mergeEnv(
  existing: string,
  updates: Map<string, string>,
  removals: ReadonlySet<string>,
): string {
  const seen = new Set<string>();
  const hadContent = existing.length > 0;
  // Lines end where dotenv's do: it reads CRLF, LF and a lone CR alike as a line
  // break. Splitting on `\r?\n` alone made a classic-Mac (CR-only) file one
  // line, so an assignment past its first was invisible here: the superseded
  // token stayed on disk below the appended one, and a managed key at the very
  // top took the whole file down with it, which the read-back guard then refused
  // (CC-CFG-80). The rewrite emits LF, the byte-level equivalent for dotenv.
  const lines = hadContent ? existing.split(/\r\n?|\n/) : [];
  // Equivalent-mutant note: dropping the length guard is unobservable. On an
  // empty `lines` the index is `-1`, which reads back as `undefined` and is not
  // `''`, so nothing is popped on that path either.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const kept = lines.filter((line) => {
    const assignment = assignmentOn(line);
    return assignment === undefined || !removals.has(assignment.key);
  });
  const out = kept.map((line) => {
    const assignment = assignmentOn(line);
    if (assignment === undefined) return line;
    const { prefix, key } = assignment;
    const value = updates.get(key);
    // Equivalent-mutant note: `=== undefined` and `!value` are interchangeable.
    // Every value in the map is `formatValue` of a non-blank string, and the only
    // input for which `formatValue` returns `''` is `''` itself, which `clean` has
    // already turned into `undefined` before the map is built. The entry that
    // comes closest to falsy is the expiry record for `expiresAtSec: 0` (“never
    // expires”), and that renders as `0:<fingerprint>`, a truthy string. So no
    // entry can hold a falsy value, and no line is treated differently.
    if (value === undefined) return line;
    // Corner case: the SAME key assigned more than once. Rewriting only the first
    // occurrence — the natural spelling, where the update is consumed as it is
    // applied — leaves the later assignment holding the old value, and dotenv's
    // last-one-wins rule then hands the reader exactly that: a revoked token both
    // stays on disk in plaintext and beats the fresh one written above it. A
    // duplicate is ordinary in a hand-edited file (an operator appends a line
    // rather than editing the one already there). Rewriting every occurrence also
    // makes the merge idempotent on a file it has already repaired.
    seen.add(key);
    // `prefix` carries the line's indentation and its `export ` keyword back out.
    // Dropping it would rewrite a sourced env store into a set of local variables
    // on every login and every refresh — see the note on {@link assignmentOn}.
    return `${prefix}${key}=${value}`;
  });

  if (!hadContent) {
    out.push('# instagram-mcp-ai credentials — written by the `login` CLI.');
    out.push('# Keep private (chmod 0600); never commit this file.');
  }
  // Appended AFTER the existing content, so that if an assignment of the same key
  // survives above in a shape `assignmentOn` does not recognise, the value written here
  // is still the one a last-one-wins reader resolves.
  for (const [key, value] of updates) if (!seen.has(key)) out.push(`${key}=${value}`);

  return `${out.join('\n')}\n`;
}

/**
 * Refuse a merged store that would not read back as intended (CC-CFG-53).
 *
 * The check runs the merged text through dotenv's own parser — the reader the
 * server uses — rather than trusting {@link formatValue} line by line, because
 * a quoted value is not always confined to its line: dotenv's quoted forms skip a
 * backslash-escaped quote, so a value ending in `\` can run on into a later line
 * that holds the same quote and swallow it. Every key this write sets must read
 * back as its value, every key it removes must be gone, and every OTHER key must
 * read back exactly as it did before the merge, so a write for one profile can
 * never silently rewrite another's. Only key names reach the message, never a
 * value, and nothing is written.
 */
export function assertReadsBack(
  filePath: string,
  existing: string,
  merged: string,
  values: ReadonlyMap<string, string>,
  removals: ReadonlySet<string>,
): void {
  // Maps, not the parsed records, so a key can never resolve to an
  // `Object.prototype` member.
  const before = new Map(Object.entries(parseEnv(existing)));
  const after = new Map(Object.entries(parseEnv(merged)));
  // `values.keys()` is belt-and-braces: a set key missing from `after` was
  // swallowed by some other value, and that value is itself in `before` or `after`
  // and reads back wrong, so dropping the spread survives every test.
  const keys = new Set([...before.keys(), ...after.keys(), ...values.keys()]);
  const wrong = [...keys].filter((key) => {
    const want = values.has(key)
      ? values.get(key)
      : removals.has(key)
        ? undefined
        : before.get(key);
    return after.get(key) !== want;
  });
  if (wrong.length > 0) {
    throw new InstagramError(
      `Cannot write the credential store at ${filePath}: ${wrong.join(', ')} would not read ` +
        'back as written, so nothing was written; a value holds characters the env-file ' +
        'format cannot carry, or a hand-edited line in the file runs into it',
      { kind: 'validation' },
    );
  }
}
