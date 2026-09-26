/**
 * Unit tests for the real (system) clock — `src/core/clock.ts`.
 *
 * Everything else in the repo runs on `test/helpers/fake-clock.ts`, so the ONE
 * place the production timer behaviour is exercised is here. What matters is not
 * that `sleep` resolves, but that it is abortable and that aborting actually
 * *cancels the timer*: `core/http.ts` awaits `clock.sleep(backoffMs, signal)`
 * between retries, so a leaked timer keeps a cancelled request's backoff pinned
 * in the event loop long after the caller gave up.
 *
 * A rejected promise alone does NOT prove the timer went away — it stays armed
 * and simply resolves into nothing — so the mid-flight abort test counts the
 * process's live timer handles instead of taking the rejection as evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import { systemClock } from '../../src/core/clock.js';

/** Long enough that a leaked timer would be a real leak; never waited out. */
const NEVER_MS = 60_000;

/** Live `setTimeout` handles in this process — the only direct evidence of a leak. */
function armedTimers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

test('systemClock.now returns the wall clock in epoch milliseconds', () => {
  const before = Date.now();
  const observed = systemClock.now();
  const after = Date.now();

  assert.ok(Number.isInteger(observed), `expected epoch ms, got ${observed}`);
  assert.ok(
    observed >= before && observed <= after,
    `now() (${observed}) must fall inside [${before}, ${after}]`,
  );
});

test('systemClock.sleep resolves only after the requested delay has elapsed', async () => {
  const delay = 30;

  // `sleep` splits on the signal and arms a SEPARATE `setTimeout` on each side of
  // that split. Until 2026-09-23 this test passed no signal, so it observed one of
  // the two arming sites while its name claimed `sleep` unqualified: the signal
  // branch could have dropped `ms` entirely — `setTimeout(…, 0)` — and every
  // test in this file would still have passed, because the four signal-carrying
  // tests either abort inside the same tick or already sleep for 0, and none of
  // them measures elapsed time (CC-PROC-127). What that costs live: `cli/login.ts`
  // waits out the OAuth redirect with `clock.sleep(timeoutMs, finished.signal)` and
  // would report a timeout at once, and `core/http.ts`'s cancellable backoff would
  // turn into a hot loop against Meta.
  for (const [label, signal] of [
    ['no signal', undefined],
    ['a live signal', new AbortController().signal],
  ] as const) {
    const started = Date.now();
    await systemClock.sleep(delay, signal);
    const elapsed = Date.now() - started;

    // Node's timer may fire a hair early on some platforms; a 5 ms tolerance keeps
    // the test honest about "waited roughly this long" without being flaky.
    assert.ok(
      elapsed >= delay - 5,
      `sleep(${delay}) with ${label} returned after only ${elapsed} ms`,
    );
  }
});

test('systemClock.sleep(0) still arms a real timer instead of resolving inline', async () => {
  // Until 2026-09-23 this test had no assertion at all: the whole body was
  // `await systemClock.sleep(0)`, so the only way it could fail was a rejection or
  // a hang, and no mutation of `sleep` produces either. What is worth pinning on
  // the zero-delay path is that it still goes through `setTimeout`. An
  // `if (ms === 0) { resolve(); return; }` shortcut resolves the same promise and
  // leaves every other test in this file green, while turning the sleep into a
  // synchronous call that never yields the event loop. That branch is the one
  // every caller which passes no signal takes, `core/http.ts`'s backoff among
  // them, and a backoff that does not yield is a hot loop against Meta. Nothing
  // observes it through the promise, so the handle count is again the only
  // evidence, exactly as in the abort tests below (CC-PROC-179).
  const before = armedTimers();

  const pending = systemClock.sleep(0);
  assert.equal(armedTimers(), before + 1, 'sleep(0) must arm a timer, not resolve inline');

  await pending;
  assert.equal(armedTimers(), before, 'the timer must be released once the sleep resolves');
});

test('systemClock.sleep rejects immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  const reason = new Error('caller gave up before sleeping');
  controller.abort(reason);
  const before = armedTimers();

  await assert.rejects(
    () => systemClock.sleep(NEVER_MS, controller.signal),
    (err: unknown) => {
      // The caller's own reason is propagated untouched, so `toInstagramError`
      // upstream can classify it (timeout vs. explicit abort).
      assert.equal(err, reason);
      return true;
    },
  );

  // Rejecting is only half of it: falling through and arming the timer anyway
  // pins the event loop for the full backoff on a request that was cancelled
  // before it ever slept. Nothing observes that through the promise — it settles
  // identically either way — so the handle count is again the only evidence.
  assert.equal(armedTimers(), before, 'an already-aborted sleep must arm no timer at all');
});

test('systemClock.sleep clears its pending timer when the signal aborts mid-flight', async () => {
  // This is the case `core/http.ts` depends on: when a request is cancelled, the
  // backoff it was waiting on must release the event loop immediately. Dropping
  // `clearTimeout` still rejects the promise, so only the handle count catches it.
  const controller = new AbortController();
  const reason = new Error('aborted while sleeping');
  const before = armedTimers();

  const pending = systemClock.sleep(NEVER_MS, controller.signal);
  assert.equal(armedTimers(), before + 1, 'sleep must arm exactly one timer');

  controller.abort(reason);
  await assert.rejects(pending, (err: unknown) => err === reason);
  assert.equal(armedTimers(), before, 'the pending timer must be cleared, not left to fire');
});

test('systemClock.sleep detaches its abort listener when it completes normally', async () => {
  // The other half of the leak the test above measures, and the half nothing
  // else in the repo would notice. `{ once: true }` detaches a listener when
  // `abort` fires; on the path where the sleep simply finishes it never fires,
  // so the listener stays attached for as long as the SIGNAL lives — not as long
  // as the sleep does. One signal reused across a retry loop therefore
  // accumulates one dead closure per completed backoff, and an `AbortSignal`
  // emits no `MaxListenersExceededWarning`, so the growth is entirely silent.
  //
  // Counting is the only evidence available: the promise resolves either way,
  // and every existing assertion in this file is satisfied by the leaking
  // version. Ten iterations rather than one, because a fix that detaches only
  // the most recent listener would pass a single-iteration test.
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, 'abort').length;

  for (let i = 0; i < 10; i += 1) {
    await systemClock.sleep(0, controller.signal);
  }

  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    before,
    'a completed sleep must leave the signal with no listener of its own',
  );
  // And the detach must not have cost the abort path its listener: a sleep
  // started after all of those must still be abortable.
  const pending = systemClock.sleep(NEVER_MS, controller.signal);
  controller.abort(new Error('still abortable'));
  await assert.rejects(pending, (err: unknown) => err instanceof Error);
});

test('systemClock.sleep detaches its abort listener when the signal aborts', async () => {
  // The mirror of the test above, for the path `{ once: true }` is actually the
  // detach for. Nothing else in this file measures it: the promise rejects
  // identically with `{ once: false }`, and the timer assertions above are
  // satisfied by `clearTimeout` alone. The leak it guards is the same one the
  // resolve path has — a controller reused across a retry loop outlives every
  // sleep it cancels, so a listener left attached per aborted backoff grows for
  // as long as the signal does, and an `AbortSignal` never warns about it.
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, 'abort').length;

  const pending = systemClock.sleep(NEVER_MS, controller.signal);
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    before + 1,
    'a pending sleep must attach exactly one listener',
  );

  controller.abort(new Error('aborted while sleeping'));
  await assert.rejects(pending, (err: unknown) => err instanceof Error);

  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    before,
    'an aborted sleep must leave the signal with no listener of its own',
  );
});

test('systemClock.sleep wraps a non-Error abort reason in an Error, keeping it as the cause', async () => {
  // `AbortController.abort()` with no argument produces a DOMException, and a
  // caller may abort with any value at all. Callers (`core/http.ts`) treat the
  // rejection as an Error, so a bare string must never be thrown as-is.
  const controller = new AbortController();
  const pending = systemClock.sleep(NEVER_MS, controller.signal);
  controller.abort('shutting down');

  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof Error, `expected an Error, got ${typeof err}`);
    assert.equal(err.message, 'Aborted');
    assert.equal(err.cause, 'shutting down');
    return true;
  });
});

test('systemClock.sleep propagates the default DOMException reason unchanged', async () => {
  // `abort()` with no reason yields a DOMException, which IS an Error — it must
  // be passed through rather than re-wrapped, so the AbortError name survives.
  const controller = new AbortController();
  const pending = systemClock.sleep(NEVER_MS, controller.signal);
  controller.abort();

  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'AbortError');
    return true;
  });
});

test('systemClock cannot have its methods swapped at runtime', async () => {
  // Production hands this one object to every time-dependent path: token-expiry
  // math, retry backoff, and the composite-publish poll budget all call
  // `systemClock.now()`. Replacing `now` with a function that answers a fixed
  // past timestamp makes an expired token look fresh; replacing `sleep` with a
  // no-op turns every backoff into a hot loop against Meta's API. Neither write
  // is a type error — a `Clock`'s members are ordinary writable properties — so
  // the freeze is the whole defence, and `Object.isFrozen` alone would only be a
  // claim about a flag (CC-CFG-33).
  assert.ok(Object.isFrozen(systemClock), 'must be frozen, not merely typed');
  assert.throws(() => {
    systemClock.now = () => 0;
  }, TypeError);
  assert.throws(() => {
    systemClock.sleep = () => Promise.resolve();
  }, TypeError);
  assert.throws(() => {
    delete (systemClock as Partial<typeof systemClock>).now;
  }, TypeError);

  // Read back by BEHAVIOUR, not by identity. Capturing `systemClock.now` to
  // compare references is the unbound-method pattern the lint config refuses,
  // and behaviour is the stronger evidence anyway: it refutes the two swaps
  // named above rather than one particular way of performing them.
  assert.ok(systemClock.now() > 1_700_000_000_000, 'now() no longer answers a real timestamp');
  const started = Date.now();
  await systemClock.sleep(25);
  assert.ok(Date.now() - started >= 15, 'sleep() returned early — a no-op resolves instantly');
});
