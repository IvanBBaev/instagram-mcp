/**
 * Unit tests for `src/core/time.ts` — the shared epoch-seconds renderer behind
 * `token_status`, the `refresh` notice and the `login` notice.
 *
 * The subject is a pure function, so these are exact-value assertions rather
 * than shape checks. That is deliberate: a renderer that drops the `* 1000`
 * still produces a perfectly well-formed ISO timestamp — in 1970 — and a
 * shape-only regex reads that as a pass while the operator is told a fresh
 * sixty-day token died fifty-six years ago.
 *
 * The interesting inputs are the ones a `Date` cannot hold. They are not
 * hypothetical: `1e400` is valid JSON and `JSON.parse` turns it into `Infinity`,
 * a hand-edited credential record can carry `NaN`, and `now + 1e300` is a
 * perfectly finite number that still names no instant. Each one made
 * `toISOString()` throw a bare `RangeError`.
 *
 * One rung further out, the slot can hold something that is not a number at all:
 * the `number` in the signature is a DECLARATION, and the wire payload behind
 * the busiest call site is cast into its type rather than validated against it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RECORDED_EXPIRY_SEC,
  describeWireValue,
  expiryFromLifetime,
  lifetimeFromWire,
  expiryLabel,
  isRecordableExpiry,
  isoFromEpochSeconds,
} from '../../src/core/time.js';

/** A fixed clock, in epoch MILLISECONDS: 2025-10-09T08:53:20Z. */
const NOW_MS = 1_760_000_000_000;

/** Epoch SECONDS for the furthest instant a `Date` can hold (±8.64e15 ms). */
const MAX_TIMESTAMP_SEC = 8_640_000_000_000;

// --- isoFromEpochSeconds ----------------------------------------------------

test('isoFromEpochSeconds renders epoch SECONDS, not milliseconds', () => {
  // 1_760_184_000 s = 2025-10-11T12:00:00Z. Without the ×1000 this same input
  // renders as 1970-01-21T08:56:24.000Z — well-formed, and wrong by 55 years.
  assert.equal(isoFromEpochSeconds(1_760_184_000), '2025-10-11T12:00:00.000Z');
  // Fractional seconds survive as milliseconds rather than being truncated.
  assert.equal(isoFromEpochSeconds(1_760_184_000.25), '2025-10-11T12:00:00.250Z');
});

test('isoFromEpochSeconds treats zero as the epoch, not as a missing value', () => {
  // "Never expires" is a meaning `expires_at` attaches to zero; a timestamp
  // renderer must not silently adopt it, or a caller that has no such sentinel
  // (a data-access window, say) would lose a real instant.
  assert.equal(isoFromEpochSeconds(0), '1970-01-01T00:00:00.000Z');
});

test('isoFromEpochSeconds answers undefined for an absent value', () => {
  assert.equal(isoFromEpochSeconds(undefined), undefined);
});

test('isoFromEpochSeconds answers undefined for NaN instead of throwing', () => {
  // NaN is what a corrupt or hand-edited credential record yields. It is the one
  // input the magnitude guard cannot catch — every comparison against NaN is
  // false — so it needs its own clause, and without it `new Date(NaN)` is an
  // Invalid Date whose `toISOString()` throws `RangeError: Invalid time value`.
  assert.equal(isoFromEpochSeconds(Number.NaN), undefined);
});

test('isoFromEpochSeconds answers undefined for an infinite value instead of throwing', () => {
  // `JSON.parse('{"expires_at":1e400}')` is `Infinity`: valid JSON, no hostile
  // upstream required — a truncated or malformed numeric literal is enough.
  assert.equal(JSON.parse('{"expires_at":1e400}').expires_at, Number.POSITIVE_INFINITY);
  assert.equal(isoFromEpochSeconds(Number.POSITIVE_INFINITY), undefined);
  assert.equal(isoFromEpochSeconds(Number.NEGATIVE_INFINITY), undefined);
});

test('isoFromEpochSeconds keeps the exact ±8.64e15 ms boundary representable', () => {
  // The boundary is inclusive in ECMA-262, so both ends must still render. This
  // is what separates `>` from `>=` in the guard, and what refuses a threshold
  // constant that has been rounded down to a "safe-looking" value.
  assert.equal(isoFromEpochSeconds(MAX_TIMESTAMP_SEC), '+275760-09-13T00:00:00.000Z');
  assert.equal(isoFromEpochSeconds(-MAX_TIMESTAMP_SEC), '-271821-04-20T00:00:00.000Z');
});

test('isoFromEpochSeconds answers undefined one second past the boundary, in both directions', () => {
  // The negative side is the half a bare `ms > MAX_TIMESTAMP_MS` gets wrong:
  // without `Math.abs` a far-past instant sails through the guard and throws.
  assert.equal(isoFromEpochSeconds(MAX_TIMESTAMP_SEC + 1), undefined);
  assert.equal(isoFromEpochSeconds(-MAX_TIMESTAMP_SEC - 1), undefined);
});

test('isoFromEpochSeconds answers undefined one MILLISECOND past the boundary', () => {
  // A one-SECOND step overshoots the threshold by a thousand, so it still reads
  // as out of range for a constant that is off by a few — `MAX_TIMESTAMP_MS + 1`
  // survives every test above. Only a step of exactly one millisecond pins the
  // constant to its true value. `MAX_TIMESTAMP_SEC + 0.001` is chosen because it
  // multiplies out to exactly 8_640_000_000_000_001 with no floating-point slop
  // (asserted below), and `new Date` of that is an Invalid Date: a guard that
  // let it through would not merely answer wrongly, it would throw the
  // `RangeError` this module exists to prevent.
  assert.equal((MAX_TIMESTAMP_SEC + 0.001) * 1000, 8_640_000_000_000_001);
  assert.equal(isoFromEpochSeconds(MAX_TIMESTAMP_SEC + 0.001), undefined);
  assert.equal(isoFromEpochSeconds(-MAX_TIMESTAMP_SEC - 0.001), undefined);
});

test('isoFromEpochSeconds answers undefined for a finite but unrepresentable magnitude', () => {
  // The case no `Number.isFinite` filter upstream can catch: `1e300` is finite,
  // so it passes every "is this a number" check and only fails at the `Date`.
  assert.equal(isoFromEpochSeconds(1e300), undefined);
  assert.equal(isoFromEpochSeconds(-1e300), undefined);
});

// One rung further out than every case above: an epoch slot can hold a value
// that is not a number AT ALL. `token_status` renders `data_access_expires_at`
// through this function straight off the `debug_token` payload, and `req` CASTS
// that payload into its wire type rather than validating it — the point
// `src/api/account.ts` already makes about the sibling `expires_at` — so Meta
// answering `"soon"`, or a hand-edited record carrying an object, arrives here
// typed `number` and is not one.
//
// The first three rows are the inputs whose product is `NaN`: measured
// 2026-09-23, before the `typeof` clause existed, rewriting the NaN clause to
// test `epochSec` instead of `ms` produced an EMPTY killer diff, and under that
// rewrite `new Date(NaN).toISOString()` throws the bare `RangeError` this
// module exists to prevent, out of a function documented as total.
//
// The rest are the inputs that are not numbers but DO coerce to a finite
// product, so the numeric clauses alone wave them through and the function
// answers a confident, wrong instant. They used to be excluded from this table
// as "a different question"; measured the same day, every one of them rendered
// an ISO string — `"0"` and `null` as the 1970 epoch.
const NOT_A_NUMBER: [label: string, epochSec: unknown][] = [
  ['a non-numeric string', 'soon'],
  ['an object', {}],
  ['an array', [1, 2]],
  ['null', null],
  ['false', false],
  ['true', true],
  ['a numeric string', '1800000000'],
  ['the zero sentinel as a string', '0'],
  ['an empty array', []],
  ['a one-element numeric array', [1_800_000_000]],
];

for (const [label, raw] of NOT_A_NUMBER) {
  test(`isoFromEpochSeconds answers undefined for ${label}, instead of throwing or guessing`, () => {
    assert.equal(isoFromEpochSeconds(raw as number), undefined);
  });
}

// --- describeWireValue --------------------------------------------------------

test('describeWireValue renders a number as itself, with no type suffix', () => {
  assert.equal(describeWireValue(1e300), '1e+300');
  assert.equal(describeWireValue(Number.NaN), 'NaN');
  assert.equal(describeWireValue(Number.NEGATIVE_INFINITY), '-Infinity');
});

test('describeWireValue gives every non-number a visible body and names its type', () => {
  // The two cases plain interpolation gets worst: `${[]}` is the empty string,
  // and `${'0'}` reads as a number that is perfectly representable.
  assert.equal(describeWireValue([]), '[] (type object)');
  assert.equal(describeWireValue('0'), '"0" (type string)');
  assert.equal(describeWireValue(''), '"" (type string)');
  assert.equal(describeWireValue(null), 'null (type object)');
  assert.equal(describeWireValue({ at: 1 }), '{"at":1} (type object)');
});

test('describeWireValue falls back to String for values JSON cannot express', () => {
  // `JSON.stringify` answers `undefined` (not a string) for these. None can come
  // off `JSON.parse`, but the callers promise never to throw and never to print
  // an empty value, so the renderer cannot lean on where its input came from.
  assert.equal(describeWireValue(Symbol('x')), 'Symbol(x) (type symbol)');
  assert.equal(describeWireValue(undefined), 'undefined (type undefined)');
});

test('describeWireValue does not throw on values JSON.stringify throws on', () => {
  // A BigInt and a circular structure both make `JSON.stringify` throw a
  // `TypeError`. A renderer that threw would reintroduce, inside the warning,
  // the crash the guards that call it exist to prevent.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(describeWireValue(circular), '[object Object] (type object)');
  assert.equal(describeWireValue(10n), '10 (type bigint)');
});

test('describeWireValue does not throw when String() throws too (CC-DATA-128)', () => {
  // The fallback after a failed `JSON.stringify` was a bare `String(value)`,
  // which throws on a circular object with no prototype and on a revoked proxy.
  const bare: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  bare.self = bare;
  assert.equal(describeWireValue(bare), '[unrenderable] (type object)');
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(describeWireValue(proxy), '[unrenderable] (type object)');
});

// --- expiryLabel ------------------------------------------------------------

test('expiryLabel says "unknown" when there is no lifetime at all', () => {
  assert.equal(expiryLabel(undefined), 'unknown');
});

test('expiryLabel says "never" for the zero sentinel, not the 1970 epoch', () => {
  // Graph reports `expires_at: 0` for a token that does not expire. Falling
  // through to the timestamp branch tells the operator their fresh token expired
  // in 1970 — a report that reads as an expiry emergency.
  assert.equal(expiryLabel(0), 'never');
});

test('expiryLabel renders a negative expiry as the instant it names, not as "never"', () => {
  // A negative stamp is a token that died long ago, which is emphatically not
  // the same statement as "never expires"; widening the zero sentinel to `<= 0`
  // would certify a dead credential as immortal.
  assert.equal(expiryLabel(-1), '1969-12-31T23:59:59.000Z');
});

test('expiryLabel renders a normal expiry as an ISO instant, argument untouched', () => {
  assert.equal(expiryLabel(1_760_184_000), '2025-10-11T12:00:00.000Z');
  // The second assertion is what pins the HAND-OFF rather than the rendering.
  // `expiryLabel` owns the unknown/never/instant decision and nothing else: the
  // value it hands to `isoFromEpochSeconds` must be the one it was given, with no
  // rounding, truncation or normalisation of its own. An integer fixture alone
  // cannot see that — `Math.trunc(x)` and `Math.round(x)` are the identity on
  // every whole number, so a label that quietly truncated would pass the line
  // above unchanged. Sub-second precision is the one place the two spellings
  // separate, and `isoFromEpochSeconds` deliberately keeps it (see its own
  // fractional-seconds case); a second, silently disagreeing rule at this layer
  // is exactly the drift this module was extracted to prevent.
  assert.equal(expiryLabel(1_760_184_000.25), '2025-10-11T12:00:00.250Z');
});

test('expiryLabel does not read a non-number zero as the never-expires sentinel', () => {
  // The sentinel is the NUMBER zero. `"0"`, `false` and `[]` are values that are
  // not numbers; certifying them as "never" would declare an uninspectable token
  // immortal, and rendering them as the epoch would declare it long dead.
  assert.equal(
    expiryLabel('0' as unknown as number),
    'unknown (upstream reported "0" (type string), which is not a representable timestamp)',
  );
  assert.equal(
    expiryLabel([] as unknown as number),
    'unknown (upstream reported [] (type object), which is not a representable timestamp)',
  );
  assert.equal(
    expiryLabel(null as unknown as number),
    'unknown (upstream reported null (type object), which is not a representable timestamp)',
  );
});

test('expiryLabel names the offending value when it is not a representable instant', () => {
  // Two things are load-bearing here. It must not throw — this label is printed
  // by `refresh` AFTER the new token has been written to disk, so a throw turns
  // a successful rotation into a crash. And it must not collapse into a bare
  // "unknown", which is the label for "the upstream returned no lifetime": the
  // operator has just had this number stamped into their credential file, and
  // the two situations need different remedies.
  assert.equal(
    expiryLabel(1e300),
    'unknown (upstream reported 1e+300, which is not a representable timestamp)',
  );
  assert.equal(
    expiryLabel(Number.POSITIVE_INFINITY),
    'unknown (upstream reported Infinity, which is not a representable timestamp)',
  );
  assert.equal(
    expiryLabel(Number.NaN),
    'unknown (upstream reported NaN, which is not a representable timestamp)',
  );
});

// --- isRecordableExpiry / expiryFromLifetime ---------------------------------

test('isRecordableExpiry accepts 0 and whole seconds up to the last second of 9999', () => {
  assert.equal(MAX_RECORDED_EXPIRY_SEC, 253_402_300_799);
  assert.equal(new Date(MAX_RECORDED_EXPIRY_SEC * 1000).toISOString(), '9999-12-31T23:59:59.000Z');
  for (const sec of [0, 1, 1_893_456_000, MAX_RECORDED_EXPIRY_SEC]) {
    assert.equal(isRecordableExpiry(sec), true, String(sec));
  }
  // A millisecond epoch is the value this ceiling exists to refuse: it is a
  // whole number inside the `Date` range, and read as seconds it names year
  // 58692 (CC-AUTH-66).
  for (const sec of [
    -1,
    1.5,
    MAX_RECORDED_EXPIRY_SEC + 1,
    1_790_000_000_000,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.equal(isRecordableExpiry(sec), false, String(sec));
  }
});

test('expiryFromLifetime: a lifetime that is neither a number nor a canonical digit string is unknown', () => {
  // The wire payload is cast, not validated, so the slot can hold anything.
  for (const expiresIn of [undefined, null, {}, true, [5184000]]) {
    assert.equal(expiryFromLifetime(expiresIn, NOW_MS), undefined, JSON.stringify(expiresIn));
  }
});

test('expiryFromLifetime: a quoted lifetime is read only when it is a canonical non-negative integer (CC-AUTH-69)', () => {
  // Graph has been seen quoting `expires_in` (see test/cli/login.test.ts). A
  // plain decimal string of whole seconds is the same lifetime, and dropping it
  // left a fresh sixty-day token with no recorded expiry, so it is read — as a
  // number: summed, never concatenated. At the epoch a concatenation would give
  // `'0' + '5184000'`, the one clock where it lands on the right-looking value,
  // so a non-zero clock is what proves the sum.
  assert.equal(expiryFromLifetime('5184000', NOW_MS), 1_760_000_000 + 5_184_000);
  assert.equal(expiryFromLifetime('5184000', 0), 5_184_000);
  assert.equal(expiryFromLifetime('1', NOW_MS), 1_760_000_000 + 1);
  // "0" is the same never-expires sentinel as `0`.
  assert.equal(expiryFromLifetime('0', NOW_MS), 0);
  // The ceiling still applies to a quoted lifetime.
  assert.equal(expiryFromLifetime(String(10 ** 12), NOW_MS), undefined);
  assert.equal(expiryFromLifetime('9'.repeat(400), NOW_MS), undefined);
  // Anything that is not the canonical spelling is not guessed at: a sign, a
  // fraction, an exponent, a radix prefix, padding, a leading zero, a digit
  // outside ASCII, or an empty string.
  for (const expiresIn of [
    '',
    ' ',
    '-60',
    '+60',
    '60.0',
    '60.5',
    '6e1',
    '0x3c',
    ' 60',
    '60 ',
    '60\n',
    '060',
    '00',
    '\u0666\u0660',
    'Infinity',
    'NaN',
    '5184000s',
  ]) {
    assert.equal(expiryFromLifetime(expiresIn, NOW_MS), undefined, JSON.stringify(expiresIn));
  }
});

test('lifetimeFromWire: numbers pass through, canonical digit strings become numbers, the rest is undefined (CC-AUTH-69)', () => {
  assert.equal(lifetimeFromWire(5_184_000), 5_184_000);
  assert.equal(Number.isNaN(lifetimeFromWire(Number.NaN)), true, 'a number is not judged here');
  assert.equal(lifetimeFromWire(-5), -5);
  assert.equal(lifetimeFromWire('5184000'), 5_184_000);
  assert.equal(lifetimeFromWire('0'), 0);
  for (const v of [undefined, null, '', '-5', '05', '5.0', ' 5', 'abc', {}, true]) {
    assert.equal(lifetimeFromWire(v), undefined, JSON.stringify(v));
  }
});

test('expiryFromLifetime: a lifetime of exactly 0 is "never expires", whatever the clock', () => {
  // The debug_token convention, shared by login and refresh (CC-AUTH-64).
  assert.equal(expiryFromLifetime(0, NOW_MS), 0);
  assert.equal(Object.is(expiryFromLifetime(-0, NOW_MS), 0), true, '-0 is stored as 0');
  assert.equal(expiryFromLifetime(0, -2_000_000_000_000), 0, 'even on a pre-1970 clock');
});

test('expiryFromLifetime: a finite lifetime is the floored sum, and a negative one is the past', () => {
  assert.equal(expiryFromLifetime(5_184_000, NOW_MS), 1_760_000_000 + 5_184_000);
  assert.equal(expiryFromLifetime(-5, NOW_MS), 1_760_000_000 - 5);
  // The whole sum is floored, not each term: a mid-second clock plus a
  // fractional lifetime crosses into the next second exactly when it should.
  assert.equal(expiryFromLifetime(0.6, 1_000_400), 1001);
  assert.equal(expiryFromLifetime(0.5, 1_000_400), 1000);
  assert.equal(expiryFromLifetime(-0.5, 1_000_000), 999, 'floored, so never later');
});

test('expiryFromLifetime: a sum that is not recordable is unknown, never "never"', () => {
  const nowSec = NOW_MS / 1000;
  // At the epoch (0 would read as "never") and before it (a signed record).
  assert.equal(expiryFromLifetime(-nowSec, NOW_MS), undefined);
  assert.equal(expiryFromLifetime(-nowSec - 1, NOW_MS), undefined);
  assert.equal(expiryFromLifetime(-nowSec + 1, NOW_MS), 1, 'the first second after it is kept');
  // Past the ceiling, and the ceiling itself.
  assert.equal(
    expiryFromLifetime(MAX_RECORDED_EXPIRY_SEC - nowSec, NOW_MS),
    MAX_RECORDED_EXPIRY_SEC,
  );
  assert.equal(expiryFromLifetime(MAX_RECORDED_EXPIRY_SEC - nowSec + 1, NOW_MS), undefined);
  for (const expiresIn of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300]) {
    assert.equal(expiryFromLifetime(expiresIn, NOW_MS), undefined, String(expiresIn));
  }
  // A clock that is not a number cannot produce a record either.
  assert.equal(expiryFromLifetime(3600, Number.NaN), undefined);
});

test('describeWireValue escapes what JSON.stringify leaves raw and bounds the value (CC-DATA-101)', () => {
  // JSON.stringify leaves U+2028 and bidi overrides as they arrived.
  assert.equal(describeWireValue('a\u2028b\u202e'), '"a\\u{2028}b\\u{202e}" (type string)');
  assert.equal(describeWireValue('a\nb'), '"a\\nb" (type string)');
  // A value the size of a response body is cut, and the type still follows.
  const huge = Array.from({ length: 1000 }, (_, i) => i);
  const shown = describeWireValue(huge);
  assert.ok(shown.endsWith(' characters in all) (type object)'), shown);
  assert.ok(Array.from(shown).length < 260, `bounded: ${Array.from(shown).length}`);
  const words = 'word '.repeat(100);
  assert.equal(
    describeWireValue(words),
    `"${'word '.repeat(39)}word… (502 characters in all) (type string)`,
  );
});
