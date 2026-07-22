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
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(abortError(signal));
        },
        { once: true },
      );
    }),
};
