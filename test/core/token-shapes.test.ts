import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskTokenShapes } from '../../src/core/token-shapes.js';

// The shared token-shape list (CC-PROC-19). Its behaviour is pinned shape by
// shape through both consumers in `test/core/redact.test.ts` and
// `test/core/errors.test.ts`; what is pinned here is the contract the two of
// them rely on: the marker is a parameter, written verbatim, and the shapes run
// in their load-bearing order whatever bracketed marker is passed.

const EAA = `EAA${'X'.repeat(30)}`;
const IGQ = `IGQ${'Y'.repeat(30)}`;
const PROOF = 'a1b2c3d4'.repeat(8);

test('every shape is replaced by the caller-supplied marker, verbatim', () => {
  for (const marker of ['[redacted]', '[REDACTED]', '<<gone>>']) {
    assert.equal(
      maskTokenShapes(`a ${EAA} b ${IGQ} c ${PROOF} d`, marker),
      `a ${marker} b ${marker} c ${marker} d`,
    );
  }
});

test('order holds for any bracketed marker: IG before the proof, EAA before IG', () => {
  // A proof glued to an IG token is only seen once the IG splice puts a
  // boundary in front of it; an EAA body starting `IG` is only masked whole
  // because EAA runs first.
  assert.equal(maskTokenShapes(`p=${PROOF}IG${'x'.repeat(20)}`, '{m}'), 'p={m}{m}');
  assert.equal(maskTokenShapes(`t EAAIG${'a'.repeat(20)} e`, '{m}'), 't {m} e');
});

test('text with no token shape comes back unchanged', () => {
  const prose = 'set IG_PROFILE_BRAND_ACCESS_TOKEN and retry #instagood 17841400000000000';
  assert.equal(maskTokenShapes(prose, '[redacted]'), prose);
});
