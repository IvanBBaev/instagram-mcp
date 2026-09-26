import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeInvisible,
  quoteUntrusted,
  quoteUntrustedString,
  visibleText,
} from '../../src/core/untrusted.js';

// --- escaping (CC-DATA-89, CC-DATA-91) ------------------------------------

test('quoteUntrusted escapes every control, format and separator class as \\u{hex} (CC-DATA-91)', () => {
  assert.equal(quoteUntrusted('a\nb', 100), 'a\\u{a}b');
  assert.equal(quoteUntrusted('\u001b[2Jx', 100), '\\u{1b}[2Jx');
  assert.equal(quoteUntrusted('bell\u0007', 100), 'bell\\u{7}');
  assert.equal(quoteUntrusted('x‮y', 100), 'x\\u{202e}y');
  assert.equal(quoteUntrusted('x​y', 100), 'x\\u{200b}y');
  assert.equal(quoteUntrusted('x y', 100), 'x\\u{2028}y');
  assert.equal(quoteUntrusted('x y', 100), 'x\\u{2029}y');
});

test('quoteUntrusted escapes every occurrence, not just the first', () => {
  assert.equal(quoteUntrusted('a\nb\nc', 100), 'a\\u{a}b\\u{a}c');
});

test('quoteUntrusted leaves printable text, spaces and astral characters untouched', () => {
  assert.equal(quoteUntrusted('Hello  world 😀 ünï', 100), 'Hello  world 😀 ünï');
});

// --- the cut --------------------------------------------------------------------

test('quoteUntrusted cuts past max code points and states the full length', () => {
  assert.equal(quoteUntrusted('abcdef', 4), 'abcd… (6 characters in all)');
});

test('quoteUntrusted does not cut a fragment of exactly max code points', () => {
  assert.equal(quoteUntrusted('abcd', 4), 'abcd');
});

test('quoteUntrusted counts code points, so an astral character is never split', () => {
  // Four code points, eight UTF-16 units.
  assert.equal(quoteUntrusted('😀😀😀😀', 4), '😀😀😀😀');
  assert.equal(quoteUntrusted('😀😀😀😀', 3), '😀😀😀… (4 characters in all)');
});

test('quoteUntrusted cuts before escaping, so an escape is never cut in half', () => {
  assert.equal(quoteUntrusted('ab\ncd', 3), 'ab\\u{a}… (5 characters in all)');
});

test('quoteUntrusted with an infinite max never cuts', () => {
  const long = 'x'.repeat(5000);
  assert.equal(quoteUntrusted(long, Number.POSITIVE_INFINITY), long);
});

// --- redaction order --------------------------------------------------------------

test('quoteUntrusted redacts the whole fragment before the cut', () => {
  const redact = (text: string): string => text.replaceAll('SECRETVALUE', '[R]');
  // A cut at 6 would split the secret; redaction first makes it vanish whole.
  assert.equal(quoteUntrusted('ab SECRETVALUE cd', 6, redact), 'ab [R]… (9 characters in all)');
});

test('quoteUntrusted defaults to no redaction', () => {
  assert.equal(quoteUntrusted('token=abc', 100), 'token=abc');
});

// --- word-safe cut (CC-DATA-92) ------------------------------------------------

test('a word-safe cut drops the partial word instead of keeping its prefix (CC-DATA-92)', () => {
  assert.equal(
    quoteUntrusted('see 0123456789abcdef here', 8, undefined, { wordSafe: true }),
    'see … (25 characters in all)',
  );
  // Without the option the same cut keeps the prefix — the leak CC-DATA-92 is about.
  assert.equal(quoteUntrusted('see 0123456789abcdef here', 8), 'see 0123… (25 characters in all)');
});

test('a word-safe cut that lands on whitespace keeps the whole preceding word', () => {
  // The first dropped code point is the space: nothing is split, nothing backs off.
  assert.equal(
    quoteUntrusted('abcd efgh', 4, undefined, { wordSafe: true }),
    'abcd… (9 characters in all)',
  );
});

test('a word-safe cut right after whitespace keeps everything up to it', () => {
  assert.equal(
    quoteUntrusted('abc defgh', 4, undefined, { wordSafe: true }),
    'abc … (9 characters in all)',
  );
});

test('a word-safe fragment that fits keeps its last word (CC-DATA-92)', () => {
  assert.equal(quoteUntrusted('fits whole', 100, undefined, { wordSafe: true }), 'fits whole');
  assert.equal(quoteUntrusted('fits whole', 10, undefined, { wordSafe: true }), 'fits whole');
});

test('a word-safe cut through one run longer than max keeps nothing and still terminates', () => {
  assert.equal(
    quoteUntrusted('x'.repeat(50), 10, undefined, { wordSafe: true }),
    '… (50 characters in all)',
  );
});

test('a word-safe cut treats a newline as a word boundary before escaping it', () => {
  assert.equal(
    quoteUntrusted('ab\ncdefgh', 5, undefined, { wordSafe: true }),
    'ab\\u{a}… (9 characters in all)',
  );
});

// --- quoteUntrustedString (CC-DATA-95) ---------------------------------

test('quoteUntrustedString escapes what JSON.stringify leaves raw (CC-DATA-95)', () => {
  // `JSON.stringify` escaped C0 controls but passed U+2028, the C1 controls and
  // every bidi or zero-width character through unchanged.
  assert.equal(quoteUntrustedString('a\u2028b', 100), '"a\\u{2028}b"');
  assert.equal(quoteUntrustedString('a\u0085b', 100), '"a\\u{85}b"');
  assert.equal(quoteUntrustedString('a\u202eb', 100), '"a\\u{202e}b"');
  assert.equal(quoteUntrustedString('a\u200bb', 100), '"a\\u{200b}b"');
  assert.equal(quoteUntrustedString('a\nb', 100), '"a\\u{a}b"');
});

test('quoteUntrustedString escapes the quote and the backslash so the literal cannot be closed early', () => {
  assert.equal(quoteUntrustedString('say "hi"', 100), '"say \\"hi\\""');
  assert.equal(quoteUntrustedString('C:\\u{a}', 100), '"C:\\\\u{a}"');
  assert.equal(quoteUntrustedString('', 100), '""');
});

test('quoteUntrustedString cuts by code point inside the quotes and states the full length after them', () => {
  assert.equal(quoteUntrustedString('abcdef', 3), '"abc…" (6 characters in all)');
  assert.equal(quoteUntrustedString('abc', 3), '"abc"');
  // A surrogate pair is one code point: the cut never leaves half of it.
  assert.equal(
    quoteUntrustedString('\u{1F600}\u{1F600}\u{1F600}', 2),
    '"\u{1F600}\u{1F600}…" (3 characters in all)',
  );
});

test('quoteUntrustedString redacts first and honours a word-safe cut', () => {
  assert.equal(
    quoteUntrustedString('keep SECRET tail', 8, (t) => t.replace('SECRET', 'X'), {
      wordSafe: true,
    }),
    '"keep X …" (11 characters in all)',
  );
  assert.equal(
    quoteUntrustedString('keep secretvalue', 8, undefined, { wordSafe: true }),
    '"keep …" (16 characters in all)',
  );
});

// --- visibleText (CC-DATA-96) ------------------------------------------

test('visibleText rejects a string of only whitespace, zero-width, bidi or control characters (CC-DATA-96)', () => {
  for (const invisible of [
    '',
    '   ',
    '\n\t',
    '\u200b',
    '\u200b\u200e \u202e',
    '\u0000\u0085',
    '\u2028\u2029',
    '\ufeff',
  ]) {
    assert.equal(visibleText(invisible), undefined, JSON.stringify(invisible));
  }
});

test('visibleText returns a string with any visible code point exactly as received', () => {
  assert.equal(visibleText('  x  '), '  x  ');
  assert.equal(visibleText('\u200bx'), '\u200bx');
  assert.equal(visibleText('\u{1F600}'), '\u{1F600}');
});

test('visibleText treats a non-string as absent, never coerced', () => {
  for (const value of [undefined, null, 0, 42, true, {}, ['x']]) {
    assert.equal(visibleText(value), undefined);
  }
});

// --- escapeInvisible: the text-block rendering (CC-DATA-102) -----------------

test('escapeInvisible writes each control, format and separator as a lowercase JSON \\uXXXX escape (CC-DATA-102)', () => {
  // One of each class: C0 (ESC, CR, TAB, NUL), DEL, C1 (NEL, CSI), bidi override
  // and isolate, zero-width space and joiner, BOM, soft hyphen, Arabic letter
  // mark, line and paragraph separators.
  assert.equal(escapeInvisible('a\u001bb'), 'a\\u001bb');
  assert.equal(escapeInvisible('a\rb\tc\u0000'), 'a\\u000db\\u0009c\\u0000');
  assert.equal(escapeInvisible('a\u007fb'), 'a\\u007fb');
  assert.equal(escapeInvisible('a\u0085b\u009b'), 'a\\u0085b\\u009b');
  assert.equal(escapeInvisible('x‮y⁦z⁩'), 'x\\u202ey\\u2066z\\u2069');
  assert.equal(escapeInvisible('x​y‍z﻿­؜'), 'x\\u200by\\u200dz\\ufeff\\u00ad\\u061c');
  assert.equal(escapeInvisible('x y z'), 'x\\u2028y\\u2029z');
});

test('escapeInvisible escapes an astral tag character as its surrogate pair, one escape per UTF-16 unit (CC-DATA-102)', () => {
  // A single braced escape of U+E0041 would be JavaScript, not JSON: JSON.parse
  // rejects it.
  // Two units, two escapes, and the body still parses to the original string.
  const out = escapeInvisible('a\u{E0041}b');
  assert.equal(out, 'a\\udb40\\udc41b');
  assert.equal(JSON.parse(`"${out}"`), 'a\u{E0041}b');
});

test('escapeInvisible leaves the line feed, printable text and legitimate non-ASCII alone (CC-DATA-102)', () => {
  // `\n` is the layout of a pretty JSON body and of a multi-line message.
  assert.equal(escapeInvisible('{\n  "a": 1\n}'), '{\n  "a": 1\n}');
  assert.equal(escapeInvisible('café شكرا \u{1F600} ~'), 'café شكرا \u{1F600} ~');
  assert.equal(escapeInvisible(''), '');
});

test('escapeInvisible keeps a JSON body parsing to the same value (CC-DATA-102)', () => {
  const value = {
    caption: 'emoji \u{1F468}‍\u{1F469} rtl ‏שלום Instagram error (auth): x',
    tag: '\u{E0041}\u007f\u0085',
  };
  for (const body of [JSON.stringify(value), JSON.stringify(value, null, 2)]) {
    const out = escapeInvisible(body);
    assert.deepEqual(JSON.parse(out), value);
    assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(out.replace(/\n/g, '')), false);
  }
});
