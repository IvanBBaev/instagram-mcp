/**
 * Injectable clock (Layer 0). FROZEN at Gate G1. Every time-dependent path
 * (token expiry math, retry backoff, composite poll budget) takes a `Clock`
 * so tests drive time deterministically via `test/helpers/fake-clock.ts`.
 */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Resolves after `ms`; rejects with the signal reason if aborted first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Coerce an abort `signal.reason` (typed `any`) into a rejectable Error. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('Aborted', { cause: reason });
}

/** The real clock used in production. */
export const systemClock: Clock = Object.freeze<Clock>({
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      // Split on the signal rather than reaching for `?.` throughout: everything
      // below needs it narrowed, and an optional chain would leave the abort
      // callback holding an `AbortSignal | undefined` it can only get past with
      // an assertion.
      if (signal === undefined) {
        setTimeout(resolve, ms);
        return;
      }
      if (signal.aborted) {
        reject(abortError(signal));
        return;
      }
      const timer = setTimeout(() => {
        // The mirror of `clearTimeout` on the abort path: a sleep that ran to
        // completion must hand the signal back exactly as it found it. `{ once:
        // true }` detaches the listener when `abort` FIRES, which on this path
        // it never does — so without this line every completed sleep leaves a
        // closure attached, and the count grows for as long as the signal lives.
        // Measured on Node 22: fifteen resolved sleeps on one signal leave
        // fifteen listeners, and an `AbortSignal` emits no
        // `MaxListenersExceededWarning`, so nothing would ever say so.
        //
        // Latent, not live: no api-layer call passes `signal` today, so the only
        // signal that reaches here is `login`'s own short-lived one. It stops
        // being latent the day cancellation is wired through `IgRequestOptions`
        // to the retry loop in `core/http.ts`, where one signal spans every
        // attempt of a request — and a leak that only appears once a feature is
        // finished is the kind nobody attributes to this file.
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError(signal));
      };
      // Equivalent-mutant note: `{ once: true }` -> `{ once: false }` survives every
      // assertion about the PROMISE — `abort` fires at most once per controller, so
      // the listener is never invoked twice and the rejection is identical either
      // way. It is still observable, through the same listener count the resolve
      // path above is pinned with: once `abort` has fired, `{ once: true }` leaves
      // the signal with no listener of this sleep's and `{ once: false }` leaves
      // one. A signal that outlives the sleep — one retry loop's controller
      // spanning every attempt — therefore accumulates one dead closure per
      // aborted backoff. That mutant survived the whole suite until the abort-path
      // detach test in `test/core/clock.test.ts` was added to pin it. `once` is the
      // detach for the branch this function rejects on, as the `removeEventListener`
      // above is the detach for the branch it resolves on. Dropping the option
      // entirely is the SAME mutant, not a second one: `addEventListener(type,
      // listener)` with no options is spec-identical to `{ once: false }`. This
      // note used to say that spelling hangs the runner; it does not, and nothing
      // had ever measured it. Measured 2026-09-23: both spellings are killed by
      // that same test at the same line with the same assertion (`1 !== 0`),
      // neither times out under a 20s per-test limit, and each finishes in under
      // a second.
      signal.addEventListener('abort', onAbort, { once: true });
    }),
});
