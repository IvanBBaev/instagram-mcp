/**
 * Rendering untrusted text (Layer 0). Pure — no network, no logging, no clock,
 * and no dependency on the secret registry: the caller hands in whatever
 * redaction applies to it.
 *
 * Upstream free text — a Graph `error.message`, an `error_user_msg`, a username
 * — is quoted back to an operator's terminal, into a log line and into the tool
 * result a model reads. Two things make that unsafe when the text is echoed
 * as received:
 *
 *  - **Invisible structure.** A newline, a U+2028/U+2029 separator, an ANSI
 *    escape or a bidi override lets the text forge a whole line ("OK  Health
 *    check passed"), repaint a terminal or reorder what a reader sees.
 *  - **Size.** Nothing upstream bounds it, so a broken or hostile endpoint can
 *    push kilobytes — or, up to the 16 MiB body cap in `core/body.ts`,
 *    megabytes — into a one-line diagnostic.
 *
 * {@link quoteUntrusted} answers both. It began as a private helper in
 * `cli/doctor.ts` (CC-DATA-89) and moved here so `core/errors.ts` and
 * `cli/login.ts` apply the same rule to the Graph error text they build
 * messages from (CC-DATA-91), rather than growing a third spelling of it.
 */

/**
 * Control, format (bidi overrides, zero-width) and line/paragraph separators —
 * the class `core/settings.ts` refuses to echo. Each one found is rendered as a
 * visible `\u{…}` escape instead.
 */
const UNPRINTABLE_ALL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** {@link UNPRINTABLE_ALL} plus the two characters a quoted literal must escape. */
const UNPRINTABLE_OR_DELIMITER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\]/gu;

/**
 * One code point a reader can see: anything that is neither whitespace nor in
 * the {@link UNPRINTABLE_ALL} class.
 */
const VISIBLE = /[^\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** One whitespace code point — where a word-safe cut may fall. */
const WHITESPACE = /\s/u;

export interface QuoteOptions {
  /**
   * Cut only between words: when the cut would land inside a run of
   * non-whitespace, the partial run is dropped rather than kept. For a caller
   * whose text is redacted AGAIN downstream, against secrets it cannot see
   * itself — a cut through the middle of a registered secret leaves a prefix the
   * exact-value registry can no longer match (CC-DATA-92). Every secret this
   * server holds is one unbroken run, so it is either kept whole (and masked
   * downstream) or dropped whole.
   */
  wordSafe?: boolean;
}

/**
 * Render an untrusted fragment so it can be printed: every unprintable code
 * point becomes a visible `\u{…}` escape, and a fragment past `max` code points
 * is cut with its full length stated (CC-DATA-89).
 *
 * `redact` runs FIRST, on the whole fragment, and that order is load-bearing: a
 * cut through the middle of a secret leaves a prefix the exact-value registry
 * can no longer match and — for a 32-hex app secret — no shape pattern covers
 * either. A caller that cannot redact everything itself asks for a
 * {@link QuoteOptions.wordSafe} cut instead. The cut counts code points, not
 * UTF-16 units, so it never splits a surrogate pair, and it happens BEFORE the
 * escaping, so an escape sequence is never cut in half.
 *
 * Unlike `describeValue` in `core/settings.ts`, which declines to quote an
 * unprintable value at all, this escapes: a Graph error message is the
 * operator's only clue, and hiding it would cost more than showing it defused.
 */
export function quoteUntrusted(
  raw: string,
  max: number,
  redact: (text: string) => string = (text) => text,
  options: QuoteOptions = {},
): string {
  const { kept, total } = cutUntrusted(raw, max, redact, options);
  const escaped = kept.replace(UNPRINTABLE_ALL, escapeCodePoint);
  return total > max ? `${escaped}… (${total} characters in all)` : escaped;
}

/**
 * {@link quoteUntrusted}, rendered as a double-quoted literal for text that is
 * interpolated INTO a sentence rather than printed on a line of its own — an
 * unknown container `status_code`, an `ERROR` container's detail.
 *
 * The quotes are what tell the reader where the upstream text ends, so a `"`
 * inside it is escaped as `\"` (and a `\` as `\\`, so an escape the text
 * spells for itself cannot pass for one this function made); everything else is
 * escaped exactly as {@link quoteUntrusted} escapes it. A cut fragment ends `…`
 * inside the quotes, with its full length stated after them.
 *
 * This replaced `quoteBounded` in `api/publishing.ts`, which relied on
 * `JSON.stringify`: that escapes C0 controls, `"` and `\` but leaves U+2028/
 * U+2029, the C1 controls and every bidi or zero-width format character as they
 * arrived, and it cut UTF-16 units — splitting a surrogate pair — with no
 * word-safe option for a caller redacted downstream (CC-DATA-95).
 */
export function quoteUntrustedString(
  raw: string,
  max: number,
  redact: (text: string) => string = (text) => text,
  options: QuoteOptions = {},
): string {
  const { kept, total } = cutUntrusted(raw, max, redact, options);
  const escaped = kept.replace(UNPRINTABLE_OR_DELIMITER, (ch) =>
    ch === '"' || ch === '\\' ? `\\${ch}` : escapeCodePoint(ch),
  );
  return total > max ? `"${escaped}…" (${total} characters in all)` : `"${escaped}"`;
}

function escapeCodePoint(ch: string): string {
  return `\\u{${Number(ch.codePointAt(0)).toString(16)}}`;
}

/**
 * The redact-then-cut half both renderers share: the kept code points, still
 * unescaped, and the length of the redacted whole. The cut happens BEFORE the
 * escaping, so an escape sequence is never cut in half.
 */
function cutUntrusted(
  raw: string,
  max: number,
  redact: (text: string) => string,
  options: QuoteOptions,
): { kept: string; total: number } {
  const points = Array.from(redact(raw));
  let end = max;
  // Back off only when the cut really splits a run: the first dropped code point
  // and the last kept one are both non-whitespace. `end < points.length` is
  // load-bearing, not a bounds nicety: past the end `points[end]` is
  // `undefined`, which `String()` turns into text with no whitespace in it, so
  // without the test a fragment that fits would lose its last word.
  if (options.wordSafe && end < points.length && !WHITESPACE.test(String(points[end]))) {
    while (end > 0 && !WHITESPACE.test(String(points[end - 1]))) end -= 1;
  }
  return { kept: points.slice(0, end).join(''), total: points.length };
}

/**
 * The value, when it is a string carrying at least one visible code point;
 * otherwise `undefined`.
 *
 * `trim()` is not that test. It strips whitespace but keeps a zero-width space,
 * a bidi mark or a control character, so a field holding only those passed a
 * "non-blank" check and — once escaped — surfaced as a message made of nothing
 * but `\u{…}` escapes, beating the useful text a lower-priority field carried
 * (CC-DATA-96). The value is returned exactly as received; this only decides
 * whether it is worth showing.
 */
export function visibleText(value: unknown): string | undefined {
  return typeof value === 'string' && VISIBLE.test(value) ? value : undefined;
}

/**
 * The {@link UNPRINTABLE_ALL} class minus the line feed. A text block's own
 * layout is made of `\n` — the line breaks of a pretty JSON body, of a
 * multi-line message — and escaping it would fold the block onto one line
 * and, outside a JSON string, make a JSON body unparseable.
 */
const INVISIBLE_IN_TEXT = /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * The text with every control (C0 but the line feed, DEL, C1), format (bidi
 * override and isolate, zero-width, BOM, tag) and line/paragraph-separator
 * code point written as a JSON escape: `\uXXXX`, lowercase hex, one escape per
 * UTF-16 unit, so an astral tag character becomes its surrogate pair (CC-DATA-102).
 *
 * This is the rendering rule for a tool result's text block, which is what a
 * client hands to the model — see `mcp/registry.ts` `escapeTextBlocks` and
 * docs/security.md §7. The spelling is chosen for the JSON body a success
 * result carries: `JSON.stringify` leaves exactly these characters raw inside
 * a string (it escapes C0 itself, never DEL, C1, `\p{Cf}` or U+2028/U+2029),
 * none of them can occur outside a string in JSON, and `\uXXXX` is a valid
 * string escape — so the rewritten body still parses to the same value, while
 * nothing in it can reorder what a reader sees, hide itself, or break a line
 * and forge one of its own. In prose the same escape is simply visible.
 *
 * Unlike {@link quoteUntrusted}, it neither cuts, quotes nor redacts: it is a
 * rendering of an already finished text, applied after the secret redactor.
 */
export function escapeInvisible(text: string): string {
  return text.replace(INVISIBLE_IN_TEXT, (ch) => {
    let escaped = '';
    for (let i = 0; i < ch.length; i += 1) {
      escaped += `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`;
    }
    return escaped;
  });
}
