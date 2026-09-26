/**
 * Unit tests for the write-acknowledgement checks (src/tools/ack.ts): which 2xx
 * bodies count as a confirmed write and which are refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import { acknowledgedId, assertNoErrorEnvelope } from '../../src/tools/ack.js';

test('acknowledgedId returns a non-empty string id unchanged', () => {
  assert.equal(acknowledgedId({ id: '17890000000000001' }, 'reply', 'x'), '17890000000000001');
});

test('acknowledgedId refuses every ack that does not carry a usable id', () => {
  for (const ack of [undefined, null, 'ok', {}, { id: '' }, { id: 17 }, { id: null }]) {
    assert.throws(
      () => acknowledgedId(ack, 'reply', 'Check before posting again.'),
      (err: unknown) => {
        assert.ok(err instanceof InstagramError, `${JSON.stringify(ack)} is refused`);
        assert.equal(err.kind, 'upstream');
        assert.equal(
          err.message,
          'Instagram acknowledged the reply without returning its id. Check before posting again.',
        );
        return true;
      },
    );
  }
});

test('an error envelope wins over an id delivered beside it', () => {
  // A body that carries `error` is a refusal whatever else it holds; the id
  // beside it is not evidence the write happened.
  assert.throws(
    () =>
      acknowledgedId({ id: 'C1', error: { message: 'Invalid parameter', code: 100 } }, 'x', 'y'),
    (err: unknown) => {
      assert.ok(err instanceof InstagramError);
      assert.equal(err.code, 100);
      assert.match(err.message, /Invalid parameter/);
      return true;
    },
  );
});

test('assertNoErrorEnvelope ignores bodies whose error field is not an object', () => {
  for (const ack of [
    undefined,
    null,
    'ok',
    {},
    { success: true },
    { error: null },
    { error: 'x' },
  ]) {
    assert.doesNotThrow(() => assertNoErrorEnvelope(ack), JSON.stringify(ack));
  }
});
