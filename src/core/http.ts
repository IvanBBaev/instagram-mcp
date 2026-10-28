/**
 * The Graph HTTP client (Layer 0). Produces the single network seam
 * {@link IgRequestFn} — the one place a socket is opened. Domain (`api/`) code
 * is written against `IgRequestFn` and tested with a mock; only this module
 * implements it. Owns: SSRF host gate, auth-param merge, version pin, per-host
 * concurrency, the retry/backoff matrix, usage-header parsing, timeout, and the
 * response-body size cap.
 *
 * Layer 0 discipline: imports only from `core/*` (types, errors, host, clock, body,
 * redact, refresh) —
 * never `api/`, `mcp/`, or `tools/` (ESLint enforces this). Behavior spec:
 * docs/architecture.md §5, docs/operations.md §§1–3.
 */
import { MAX_RESPONSE_BYTES, readCappedText } from './body.js';
import { assertAllowedHost, buildUrl } from './host.js';
import { mapGraphError, toInstagramError } from './errors.js';
import { processSecrets, surfaceForms } from './redact.js';
import { InstagramError } from './types.js';
import type { Clock } from './clock.js';
import type {
  AuthProvider,
  GraphHost,
  IgRequestFn,
  IgRequestOptions,
  Logger,
  QueueWait,
  SecretRegistry,
  SemaphoreRegistry,
  Settings,
  UsageSnapshot,
} from './types.js';

// The concurrency ports — the slot registry and the bounded queue wait
// (CC-RATE-6) — are declared in `core/types.ts` (V3-01), where `mcp/` and
// `tools/` may import them; this module re-exports them so its importers keep
// one name and there is no second copy to drift.
export type { QueueWait, SemaphoreRegistry } from './types.js';

/** Injected collaborators for {@link createIgRequest}. */
export interface IgRequestDeps {
  auth: AuthProvider;
  /** Runtime settings — this client reads `maxConcurrent` + `timeoutMs`. */
  settings: Settings;
  clock: Clock;
  log: Logger;
  /** Injectable for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Invoked on every response with the parsed rate-limit headers. */
  onUsage?: (host: GraphHost, usage: UsageSnapshot) => void;
  /**
   * Per-host concurrency counters. Defaults to the process-wide registry so the
   * limit holds across every seam this factory produces; tests inject their own
   * to stay hermetic (see {@link createSemaphoreRegistry}).
   */
  semaphores?: SemaphoreRegistry;
  /**
   * Where each attempt registers its access token (both surface spellings).
   * Defaults to the process-wide registry in `core/redact.ts`
   * ({@link processSecrets}); a context that redacts through its own registry
   * injects it here so the token is masked where that context looks.
   */
  secrets?: SecretRegistry;
}

// --- Tunables (docs/operations.md §§1–2) -----------------------------------

/** Total attempts including the first — 3 retries max. */
const MAX_ATTEMPTS = 4;
/** Exponential backoff `min(500·2^n, 8000) + jitter`. */
const BACKOFF_BASE_MS = 500;
/**
 * The ceiling of that `min` — and, at `MAX_ATTEMPTS = 4`, HALF an
 * equivalent-mutant spot: no LARGER value of this constant is observable. Proof
 * of that half: `backoffMs` has exactly two call sites, both in the retry loop
 * and both reached only when `lastAttempt` is false, i.e.
 * `attempt < MAX_ATTEMPTS - 1`, so it is only ever called with 0, 1 or 2 and the
 * base is 500/1000/2000 ms — always under the cap, so the `min` returns its first
 * argument every time. The cap first changes a delay at attempt 5
 * (500·2^5 = 16 000 ms), which would need `MAX_ATTEMPTS >= 7`. Widening it to
 * 800 000 therefore alters no sleep, no request, no log line and no timing, so
 * nothing downstream — and no test — can distinguish the two.
 *
 * Narrowing it does not get the same pass, and until 2026-09-23 this note said
 * otherwise — it generalised one direction into "no value is observable" and read
 * as a measured all-clear over a constant the suite does constrain. Any cap below
 * 2000 shortens the third backoff, and that sequence is pinned whole by "the
 * third backoff doubles again — 500, 1000, 2000 ms with the jitter pinned to
 * zero", which mocks `Math.random` to 0 and asserts `[500, 1000, 2000]` exactly;
 * a cap under 500 also leaves the first backoff outside its asserted
 * `[500, 750)` band. So the indistinguishable set is `[2000, ∞)` rather than
 * every number: no whole pin is available, but the floor is held by a test rather
 * than by argument. It stays at 8000 because it is the documented contract
 * (docs/operations.md §2, docs/architecture.md §5) and because it is what keeps a
 * future attempt-budget bump from silently turning a retry into a multi-minute
 * stall; do not contort a test into "killing" the remaining half.
 */
const BACKOFF_CAP_MS = 8000;
/**
 * The longest `Retry-After` this client waits out. A longer one is not slept
 * on, capped or otherwise: the call fails at once with the estimate (CC-RATE-3).
 */
const RETRY_AFTER_CAP_MS = 60_000;
/** Proactively slow down once usage crosses this percentage. */
const THROTTLE_PCT = 90;
/** Short courtesy pause when over the throttle threshold. */
const THROTTLE_MS = 1000;
/** Usage-header fields that carry a 0–100 percentage. */
const USAGE_FIELDS = ['call_count', 'total_cputime', 'total_time'] as const;

// --- Per-host concurrency semaphore ----------------------------------------

/**
 * The floor of the queue-wait bound (CC-RATE-6). A call waits for a slot at
 * most `max(timeoutMs, QUEUE_WAIT_FLOOR_MS)`: one request timeout, so a queue
 * that is moving is never cut short, but never less than 30 s, so a small
 * `IG_TIMEOUT_MS` does not turn a brief burst into "server busy".
 */
const QUEUE_WAIT_FLOOR_MS = 30_000;

interface Semaphore {
  /**
   * Resolves with a release function once a slot is free. Rejects, as an
   * InstagramError, with the abort reason if `signal` is aborted first, or with
   * a "server busy" `upstream` error once the call has queued for `wait.ms`.
   */
  acquire(signal: AbortSignal | undefined, wait: QueueWait): Promise<() => void>;
}

/** The CC-RATE-6 refusal: a call that queued for a slot longer than `ms`. */
function serverBusy(max: number, ms: number): InstagramError {
  return new InstagramError(
    `Server busy: this call waited ${Math.ceil(ms / 1000)} s for one of the ${max} ` +
      'concurrent Graph request slots (IG_MAX_CONCURRENT) and none came free, so it was ' +
      'not sent. Retry it once the other in-flight calls have finished.',
    { kind: 'upstream' },
  );
}

function createSemaphore(max: number): Semaphore {
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    const next = queue.shift();
    if (next !== undefined) {
      active += 1; // hand the freed slot straight to the next waiter
      next();
    }
  };

  return {
    acquire: (signal, wait) =>
      new Promise<() => void>((resolve, reject) => {
        // The caller's signal is honoured HERE, not only by `fetch`, because
        // until 2026-09-23 it was not, and the wait for a slot is the one wait
        // on the request path nothing else can cut short. Measured with a fake
        // fetch at `maxConcurrent: 1` and one request holding the slot: an
        // already-aborted call, and a call aborted 20 ms into its wait, both
        // stayed pending for as long as the slot was held (200+ ms in the probe;
        // in production up to four timed-out attempts plus their backoffs) and
        // then TOOK the freed slot only to hand `fetch` a dead signal. A
        // cancelled call must settle when it is cancelled, and it must never
        // cost a live request its place in the queue.
        if (signal?.aborted) {
          reject(toInstagramError(signal.reason));
          return;
        }
        if (active < max) {
          active += 1;
          resolve(release);
          return;
        }
        // Detach on the grant path too: the caller's signal outlives this wait
        // (it spans every attempt of the request), and `{ once: true }` only
        // detaches when `abort` fires.
        let detach = (): void => {};
        // The queue-wait timer (CC-RATE-6). It runs on the injected clock and is
        // cancelled through its own controller on every way out of the queue,
        // so a granted or aborted wait leaves no timer behind. The `aborted`
        // check in the expiry handler is not redundant with that: a clock is
        // free to resolve a sleep it was asked to cancel (the test fake does),
        // and a late expiry must not evict a waiter that already left.
        const timer = new AbortController();
        const waiter = (): void => {
          timer.abort();
          detach();
          resolve(release);
        };
        queue.push(waiter);
        // A rejected sleep is the clock honouring `timer.abort()` — the wait
        // already ended some other way, so there is nothing left to do.
        wait.clock.sleep(wait.ms, timer.signal).then(
          () => {
            if (timer.signal.aborted) return;
            // Same exit as an abort: leave the queue, give back nothing.
            queue.splice(queue.indexOf(waiter), 1);
            detach();
            reject(serverBusy(max, wait.ms));
          },
          () => {},
        );
        if (signal !== undefined) {
          const onAbort = (): void => {
            // Leave the queue without touching `active`: a waiter never held a
            // slot, so there is nothing to give back. `release` cannot have
            // shifted this waiter already - it calls `waiter`, which detaches
            // this listener synchronously, before `abort` could fire it.
            timer.abort();
            queue.splice(queue.indexOf(waiter), 1);
            reject(toInstagramError(signal.reason));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          detach = () => signal.removeEventListener('abort', onAbort);
        }
      }),
  };
}

/**
 * An independent set of per-host counters — a {@link SemaphoreRegistry}
 * (declared in `core/types.ts`); one per process, tests make their own.
 * `IG_MAX_CONCURRENT` is a budget against **Meta**, not against a call site, so
 * the counters must outlive any single {@link createIgRequest} call: the
 * composition root builds a fresh seam per tool call, and a map owned by the
 * factory would silently multiply the limit by the number of in-flight calls.
 * `max` is used only the first time a host is seen — `maxConcurrent` is
 * resolved once per process by the composition root, so every caller passes the
 * same value. A wait longer than `wait.ms` rejects with "server busy"
 * (CC-RATE-6).
 */
export function createSemaphoreRegistry(): SemaphoreRegistry {
  // One semaphore per host, created lazily; only allowlisted hosts reach here.
  const semaphores = new Map<GraphHost, Semaphore>();
  return {
    acquire(
      host: GraphHost,
      max: number,
      signal: AbortSignal | undefined,
      wait: QueueWait,
    ): Promise<() => void> {
      let sem = semaphores.get(host);
      if (sem === undefined) {
        sem = createSemaphore(max);
        semaphores.set(host, sem);
      }
      return sem.acquire(signal, wait);
    },
  };
}

/**
 * The registry every seam shares unless one is injected — the default behind
 * `IgRequestDeps.semaphores` and `ToolContext.semaphores`.
 */
export const sharedSemaphores: SemaphoreRegistry = createSemaphoreRegistry();

// --- Usage-header parsing (docs/operations.md §1) ---------------------------

/** Highest of the known percentage fields present on a usage object. */
function maxOfUsageFields(obj: unknown): number | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const record = obj as Record<string, unknown>;
  let max: number | undefined;
  for (const field of USAGE_FIELDS) {
    const value = record[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      max = max === undefined ? value : Math.max(max, value);
    }
  }
  return max;
}

/** Parse `X-App-Usage` (a flat `{call_count,total_cputime,total_time}` object). */
function parseAppUsage(header: string | null): number | undefined {
  if (header === null || header === '') return undefined;
  try {
    return maxOfUsageFields(JSON.parse(header));
  } catch {
    return undefined;
  }
}

/** Parse `X-Business-Use-Case-Usage` (`{ <id>: [ {call_count,...}, ... ] }`). */
function parseBucUsage(header: string | null): number | undefined {
  if (header === null || header === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  let max: number | undefined;
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      const m = maxOfUsageFields(entry);
      if (m !== undefined) max = max === undefined ? m : Math.max(max, m);
    }
  }
  return max;
}

/** Build a {@link UsageSnapshot} from a response's rate-limit headers. */
function parseUsage(headers: Headers): UsageSnapshot {
  const appHeader = headers.get('x-app-usage');
  const bucHeader = headers.get('x-business-use-case-usage');
  const appUsagePct = parseAppUsage(appHeader);
  const bucUsagePct = parseBucUsage(bucHeader);

  const snapshot: UsageSnapshot = {};
  if (appUsagePct !== undefined) snapshot.appUsagePct = appUsagePct;
  if (bucUsagePct !== undefined) snapshot.bucUsagePct = bucUsagePct;

  const present = [appUsagePct, bucUsagePct].filter((n): n is number => n !== undefined);
  if (present.length > 0) snapshot.maxPct = Math.max(...present);

  const raw: Record<string, unknown> = {};
  if (appHeader !== null) raw['x-app-usage'] = appHeader;
  if (bucHeader !== null) raw['x-business-use-case-usage'] = bucHeader;
  if (Object.keys(raw).length > 0) snapshot.raw = raw;

  return snapshot;
}

// --- Retry helpers ----------------------------------------------------------

/**
 * Throttle codes that are never auto-retried, not even on a GET (owner decision
 * 2026-10-22): 4 (app), 17 (user), 32 (page/user call count) and 613 (custom
 * rate limit) are call-count limits over a window of minutes to an hour, so a
 * replay within the few seconds the backoff spends lands against the same
 * exhausted counter — and every such replay is one more call charged to it.
 * 80002 (Instagram BUC) and a 429 without one of these codes keep retrying.
 */
const UNRETRIED_THROTTLE_CODES: ReadonlySet<number | undefined> = new Set([4, 17, 32, 613]);

/**
 * A throttle or a transient upstream failure is retryable — but only on an
 * idempotent call. A non-idempotent write is never replayed: Meta may have
 * accepted it before the 429/5xx reached us, so retrying `media_publish` costs
 * publishing quota and leaves a duplicate, publicly visible post, and retrying
 * a comment write duplicates the comment (`api/publishing.ts`, docs/operations.md
 * §2). `validation`/`auth`/`permission` are never retried at all, and neither
 * is a throttle carrying one of `UNRETRIED_THROTTLE_CODES`. GET is idempotent
 * by default, so a read retries a BUC (80002) throttle, a plain 429 and a 5xx.
 */
function isRetryableKind(kind: string, idempotent: boolean, code: number | undefined): boolean {
  if (kind === 'rate_limit') return idempotent && !UNRETRIED_THROTTLE_CODES.has(code);
  if (kind === 'upstream') return idempotent;
  return false;
}

/**
 * The IMF-fixdate form of an HTTP-date (RFC 9110 §5.6.7), the one form senders
 * are required to generate: `Sun, 06 Nov 1994 08:49:37 GMT`. HTTP-date is
 * case-sensitive. Anything else is refused BEFORE `Date.parse` sees it, because
 * V8's legacy fallback reads almost any string as a date (`'1.5'` and `'-1'` are
 * 2001-01-01, `'+5'` is 2001-05-01, `'60,'` is 1960): each became a past
 * instant and so a zero-delay retry (CC-RATE-17). The obsolete RFC 850 and
 * asctime forms fall to backoff too, even though RFC 9110 asks recipients to
 * accept them: Meta sends delta-seconds, and V8 reads asctime in LOCAL time, so
 * honoring it through `Date.parse` would be wrong by the host's UTC offset
 * (CC-RATE-18, an owner decision).
 */
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse `Retry-After` (delta-seconds or an IMF-fixdate) into milliseconds,
 * UNCAPPED — the caller compares it with {@link RETRY_AFTER_CAP_MS}, because a
 * wait over the cap is a different decision (fail fast), not a shorter wait.
 * `now` anchors the date form. Any other value is `undefined`, so the caller
 * backs off instead.
 */
function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    if (!IMF_FIXDATE.test(trimmed)) return undefined;
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  return Math.max(ms, 0);
}

/**
 * A wait as an operator reads it: whole minutes under two hours, whole hours
 * past that, always rounded UP so the estimate never invites a retry that is
 * still too early. Only ever called with more than {@link RETRY_AFTER_CAP_MS},
 * so the smallest answer is `~2 min`.
 */
function humanWait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return minutes < 120 ? `~${minutes} min` : `~${Math.ceil(minutes / 60)} h`;
}

/**
 * CC-RATE-3 — the refusal for a `Retry-After` longer than
 * {@link RETRY_AFTER_CAP_MS} (owner decision, 2026-10-22). Until then the wait
 * was clamped to the cap and slept up to three times: a BUC reset hours away
 * held the MCP call for three minutes and then failed anyway, and every replay
 * spent another request against a limit Meta had just said would not lift. The
 * call now fails on the spot, keeping every field of the mapped Graph error and
 * Meta's own text, with the estimate appended so the operator knows when to try
 * again.
 */
function retryAfterTooLong(mapped: InstagramError, waitMs: number): InstagramError {
  // CC-RATE-19: a delta-seconds value of 309+ digits parses to `Infinity`, and
  // one past 2^53 ms prints in exponent notation, so the sentence read "a
  // Infinity s wait … retry in ~Infinity h". Past the safe-integer range the
  // numbers carry nothing an operator can act on: keep the refusal, drop them.
  // `<=` and `<` are equivalent: a delta-seconds wait is a multiple of 1000 and
  // 2^53 − 1 is not, and an IMF-fixdate (four-digit year) never gets that far.
  const tail =
    waitMs <= Number.MAX_SAFE_INTEGER
      ? `a ${Math.ceil(waitMs / 1000)} s wait (Retry-After), longer than the ` +
        `${RETRY_AFTER_CAP_MS / 1000} s this server holds a call for, so it was not ` +
        `retried; retry in ${humanWait(waitMs)}.`
      : `a Retry-After wait too long to estimate, longer than the ` +
        `${RETRY_AFTER_CAP_MS / 1000} s this server holds a call for, so it was not retried.`;
  return new InstagramError(`${mapped.message} — Instagram asked for ${tail}`, {
    kind: mapped.kind,
    status: mapped.status,
    code: mapped.code,
    subcode: mapped.subcode,
    fbtraceId: mapped.fbtraceId,
    cause: mapped.cause,
  });
}

/**
 * True when `value` is a string carrying at least one non-whitespace character.
 *
 * Deliberately the same predicate, by the same name, as the one in
 * `core/refresh.ts`: both modules hand a header value to `mapGraphError` as the
 * fallback trace id, and CC-DATA-21 is the defect that appears when either of
 * them treats "absent" and "present but blank" as different facts. Typed
 * `unknown` rather than `string | null` for the same reason it is there — the
 * `typeof` half is what stops a non-string reaching `.trim()`, and this file is
 * one refactor away from feeding it something wider than a `Headers` lookup.
 */
function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Exponential backoff with jitter for attempt `n` (0-based). */
function backoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  return base + Math.random() * (base / 2);
}

// --- Response-body reader ---------------------------------------------------

/**
 * The refusal for a body over {@link MAX_RESPONSE_BYTES}. `seen` is what gave it
 * away — the declared `Content-Length`, or the running count once the stream
 * passed the cap — so the operator can tell "the proxy said so up front" from
 * "it kept sending".
 *
 * `upstream`, because the fault is on the far side of the socket; and never
 * retried, because nothing about a replay would make the same page smaller.
 * The kind alone does not guarantee that — `isRetryableKind` would retry an
 * `upstream` GET — what does is that both `readBody` call sites sit outside the
 * retry loop's `try`, so this throw leaves `createIgRequest` on the attempt that
 * raised it. The message names the cap and the remedy, and quotes nothing from
 * the body, so no upstream text reaches the log or the model through it.
 */
function responseTooLarge(status: number, seen: string): InstagramError {
  return new InstagramError(
    `Graph response body is larger than the ${MAX_RESPONSE_BYTES / (1024 * 1024)} MiB this ` +
      `server buffers (${seen}); it was discarded unread. Request a smaller page (a lower ` +
      '`limit`) or fewer fields; if a proxy sits between this server and Meta, check what it ' +
      'is returning.',
    { kind: 'upstream', status },
  );
}

/**
 * Read a response body as JSON when possible, else as raw text (for errors).
 * Bounded by {@link MAX_RESPONSE_BYTES} (see {@link readCappedText}).
 */
async function readBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await readCappedText(res, responseTooLarge);
  } catch (err) {
    // A response body is a STREAM, and it is still governed by the same
    // per-attempt AbortSignal that carried the headers. Reaching this point
    // therefore does NOT mean the server misbehaved: the headers arrived, the
    // deadline then passed, and the already-delivered bytes were torn up on the
    // way to `text()`. Measured on Node v22.23.2 against a real loopback server
    // under `AbortSignal.timeout(300)`: with no delay the body resolves at 8 ms;
    // with 600 ms of delay between the headers and `res.text()` the SAME body
    // throws `AbortError: The operation was aborted.` at 602 ms.
    //
    // Both call sites below are outside the transport `try`/`catch`, so without
    // this mapping the rejection left `createIgRequest` as whatever undici threw
    // - a raw `DOMException` that `isInstagramError` answers false for, carrying
    // no `kind` for the retry matrix and no shape the tool layer can render.
    // Mapping it here rather than at each call site keeps a third reader from
    // having to rediscover that a body read is a network operation (CC-PROC-184).
    // The size refusal above is already an InstagramError and passes through
    // unchanged. (The measurement was taken on `res.text()`; the reader loop in
    // `readCappedText` pulls from the same signal-governed stream.)
    throw toInstagramError(err);
  }
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// --- Factory ----------------------------------------------------------------

/**
 * Build the {@link IgRequestFn} network seam. Every call: resolves + asserts the
 * host, merges auth params, pins the version, enforces per-host concurrency and
 * a timeout, retries per the matrix, parses usage headers, and returns the
 * parsed JSON body.
 *
 * Cheap to call — the composition root builds one seam per tool call. The
 * concurrency counters deliberately live outside this factory
 * ({@link SemaphoreRegistry}) so `maxConcurrent` bounds the process, not the
 * seam.
 */
export function createIgRequest(deps: IgRequestDeps): IgRequestFn {
  const { auth, settings, clock, log, onUsage } = deps;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const semaphores = deps.semaphores ?? sharedSemaphores;
  const secrets = deps.secrets ?? processSecrets;

  /** Parse usage headers, notify `onUsage`, and return the snapshot. */
  const reportUsage = (host: GraphHost, headers: Headers): UsageSnapshot => {
    const usage = parseUsage(headers);
    if (onUsage) onUsage(host, usage);
    return usage;
  };

  /** Sleep, converting an abort/timeout rejection into an InstagramError. */
  const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    try {
      await clock.sleep(ms, signal);
    } catch (err) {
      throw toInstagramError(err);
    }
  };

  const request: IgRequestFn = async <T>(opts: IgRequestOptions): Promise<T> => {
    // 1. Resolve + SSRF-gate the host BEFORE anything else (no fetch, no auth).
    const host = opts.host ?? auth.defaultHost;
    assertAllowedHost(host);

    // 2. Build the caller's form fields once; the credential is placed per
    //    attempt by `sign` below, because the Path-B proof is time-bound.
    // POST/DELETE carry `opts.body` as an x-www-form-urlencoded request body.
    const form = new URLSearchParams();
    if (opts.method !== 'GET' && opts.body) {
      for (const [key, value] of Object.entries(opts.body)) {
        // Absent, not empty — the same rule the query-string sink applies in
        // `host.ts` (CC-DATA-10), restated here because this is a SECOND,
        // independent sink: nothing that guards `buildUrl` runs on a request
        // body. `IgRequestOptions.body` excludes `null`, and like `QueryParams`
        // that annotation is a declaration of intent, not a guarantee — it is
        // erased before this line runs and nothing validates the object that
        // arrives. `String(null)` would then put the four characters `null` into
        // the payload (`caption=ok&alt_text=null`), and Graph would store the
        // word itself as a caption or alt text on a publicly visible post.
        // No cast is needed to write the check: TypeScript permits `=== null`
        // against a type that excludes it, so the boundary can defend itself
        // without weakening the declaration it defends.
        //
        // Reachability, stated exactly rather than assumed: since CC-PROC-25
        // every write in `api/comments.ts` and `api/publishing.ts` that has
        // fields sends them here, so this is the live sink for every caption,
        // comment and container field. None of those callers can hand it a
        // `null` — each field is a typed argument or is assigned only under an
        // `!== undefined` test — so a `null` still needs a JavaScript consumer
        // of the shipped `.d.ts` (this package ships types, not enforcement) or
        // one of the two untyped `scripts/*.mjs` entry points that drive this
        // seam directly. The guard is here because a write is the one place
        // where a silently wrong value is also irreversible.
        //
        // Nullish, never falsy: `false`, `0` and `''` are values a caller chose
        // (an explicit opt-out, a zero offset, a cleared field), each has a real
        // spelling on the wire, and dropping one would perform a different write
        // than the one asked for.
        //
        // Equivalent-mutant note: the pair may be written as the single loose
        // `value == null`, which is defined as exactly this test, so no test can
        // tell the spellings apart. The explicit form names both values it skips.
        if (value === undefined || value === null) continue;
        // Equivalent-mutant note: appending versus overwriting cannot be told
        // apart here — object keys are unique, so no key is ever written twice.
        form.append(key, String(value));
      }
    }

    // 3. Place the auth params, then build the pinned, allowlisted URL. CC-PROC-25
    //    — the credential travels with the payload. A request that sends a form
    //    body (every write that has fields: a caption, a comment `message`,
    //    `user_tags`, `creation_id`) carries `access_token` and
    //    `appsecret_proof` in that body too, so the request line of a write names
    //    the path and nothing else: no caption percent-encoded 3–4× into a URL an
    //    intermediary can refuse with an opaque 414, and no credential in the one
    //    line proxies and access logs record by default. Graph documents both
    //    params as ordinary request parameters, accepted from the form body of a
    //    POST exactly as from the query string. A request with NO body — every
    //    GET, and the bodyless `DELETE /{comment-id}` — keeps them on the query
    //    string, unchanged: a DELETE's content has no defined semantics
    //    (RFC 9110 §9.3.5), so inventing a body just to carry the token would
    //    trade a known-good request for an unverified one.
    //
    //    Auth wins on BOTH channels, the rule the query merge has always
    //    enforced: `form.set` replaces a caller field of the same name, and the
    //    `undefined` written over the query copy removes it (`buildUrl` skips an
    //    `undefined` value), so a caller-supplied `access_token` cannot ride the
    //    request line beside the real one in the body — Graph would then see two
    //    credentials and the caller would have chosen which one it reads.
    //
    //    The decision is the FIELD COUNT, never "a body was passed": `body: {}`
    //    and an all-nullish body send nothing (CC-DATA-15), so they must keep the
    //    credential on the query string rather than conjure a body of auth alone.
    //
    //    Equivalent-mutant note: `delete query[key]` cannot be told apart from
    //    the `undefined` assignment — `buildUrl` skips an `undefined` value, so
    //    both leave the key off the URL.
    //
    // CC-DATA-15 — two spellings of "no payload" were two different requests.
    // `init.body` and the `content-type` header below are set together on
    // `body !== undefined`, so assigning unconditionally here meant `body: {}`
    // — and, since CC-DATA-12 closed, a body whose every field is nullish —
    // sent an empty form payload PLUS an
    // `application/x-www-form-urlencoded` header that `body: undefined` does
    // not send, and a DELETE went out carrying a zero-length form body. A
    // caller that spelled "nothing to send" the other way got a different
    // request on the wire for no reason it could see.
    //
    // The test is the FIELD COUNT, never "the serialized string is empty":
    // `{ caption: '' }` contributed a field whose value the caller chose and
    // must still send `caption=`. The two spellings happen to agree — a
    // `URLSearchParams` holding one pair serializes to at least `=` — but only
    // the count says what is meant, and the next reader has to know which.
    //
    // Reachability, stated exactly rather than assumed: no in-repo caller
    // builds an empty form today — every body-carrying write in `api/` has at
    // least one always-present field, and `deleteComment` passes no body at
    // all. The guard holds because "an empty body and no body are the same
    // request" is the kind of invariant a future api function will assume
    // rather than check, and because since CC-PROC-25 the count ALSO decides
    // where the credential travels (above).
    //
    // Equivalent-mutant note: `form.toString() !== ''` — and its truthiness
    // twin — cannot be told apart from the field count by any input. A
    // `URLSearchParams` holding one pair serializes to at least `=` (that is
    // what `append('', '')` produces), so "no pairs" and "empty serialization"
    // coincide for every possible form. The count is kept because it is the
    // question actually being asked; the string test would agree here only by
    // arithmetic, and would stop agreeing the moment someone reached for `!`.
    //
    // CC-AUTH-79 — signed per ATTEMPT, never once per call. Since CC-AUTH-15 the
    // Path-B credential is time-bound: `authParams` mints `appsecret_time` from
    // the clock and signs it into `appsecret_proof`, and Graph refuses a stale
    // time. Until 2026-10-10 this seam resolved the params once, BEFORE waiting
    // for a concurrency slot and before the retry loop, so every attempt carried
    // the instant the call was first made: a call that queued behind
    // `maxConcurrent` others, or that retried after a 60 s Retry-After
    // (three times over, plus a `timeoutMs` per attempt), went out minutes
    // late with the first attempt's timestamp — the replay window CC-AUTH-15
    // bounds, reopened by the transport's own patience, and a recoverable 429
    // turned into a refusal of the proof. `sign` therefore runs inside the loop,
    // after the slot is held, so each attempt is signed at the moment it is sent.
    const sign = async (): Promise<{ url: string; body: string | undefined }> => {
      // Resolve the auth params and register the access token with the
      //    redactor in BOTH surface spellings — as held, and form-encoded exactly
      //    as `URLSearchParams` puts it on the wire, in the query or in the body
      //    below (CC-PROC-25). The redactor matches exact substrings, so a token
      //    with a character the form encoder rewrites (`+`, `/`, `=`, a space) is
      //    masked as held but printed whole in its encoded spelling, which is the
      //    one a transport or proxy that names the request quotes. `login`/
      //    `refresh` register the same two forms for the secrets THEY put on the
      //    wire (CC-AUTH-76). Only `access_token` is registered: since CC-AUTH-15
      //    `appsecret_proof` and `appsecret_time` change every second, so
      //    registering them would grow the process-wide registry without bound,
      //    and a registered 10-digit `appsecret_time` would mask that digit run
      //    inside any Graph id or payload. The proof is 64-hex by construction,
      //    which the token-shape backstop masks in either spelling (hex survives
      //    form encoding unchanged); the time is not a secret. Registration is
      //    idempotent (the registry is a `Set`), so doing it per attempt costs a
      //    lookup.
      const authParams = await auth.authParams(host);
      const token = authParams['access_token'];
      if (token !== undefined) {
        for (const spelling of surfaceForms(token)) secrets.register(spelling);
      }

      const query: Record<string, string | number | boolean | undefined> = {
        ...opts.params,
        ...authParams,
      };
      let body: string | undefined;
      if (form.size > 0) {
        // A fresh copy per attempt: `form` holds the caller's fields only, so
        // a retry never carries the previous attempt's proof or time.
        const signed = new URLSearchParams(form);
        for (const [key, value] of Object.entries(authParams)) {
          signed.set(key, value);
          query[key] = undefined;
        }
        body = signed.toString();
      }
      return { url: buildUrl(host, opts.path, query), body };
    };

    // The URL is validated once up front, without the credential: an unpinned
    // path or a mangled host spelling fails here, before a slot is spent and
    // before the auth provider (which on Path B computes an HMAC keyed with the
    // app secret) runs for a request that can never be sent. Auth params are
    // strings, so a URL that builds without them builds with them; a caller
    // value the credential would have replaced is refused here rather than
    // silently overwritten.
    buildUrl(host, opts.path, opts.params);

    const idempotent = opts.idempotent ?? opts.method === 'GET';

    // Never log the token, the query string or the body (all can carry
    // secrets) — path only.
    log.debug('graph request', { method: opts.method, host, path: opts.path });

    // A cancelled call leaves here, before any slot or socket is spent on it:
    // an already-aborted signal rejects at once, and one aborted while queued
    // rejects when it fires (see `createSemaphore`).
    const release = await semaphores.acquire(host, settings.maxConcurrent, opts.signal, {
      clock,
      ms: Math.max(settings.timeoutMs, QUEUE_WAIT_FLOOR_MS),
    });
    try {
      for (let attempt = 0; ; attempt++) {
        const lastAttempt = attempt >= MAX_ATTEMPTS - 1;
        const { url, body } = await sign();

        // 4. Per-attempt timeout signal combined with the caller's signal.
        const timeout = AbortSignal.timeout(settings.timeoutMs);
        const signal = opts.signal
          ? AbortSignal.any([opts.signal, timeout])
          : AbortSignal.any([timeout]);

        let res: Response;
        try {
          const init: RequestInit = { method: opts.method, signal, redirect: 'error' };
          if (body !== undefined) {
            init.body = body;
            init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
          }
          res = await doFetch(url, init);
        } catch (err) {
          // Transport error / timeout / abort. A caller-initiated abort is never
          // retried; a transport failure retries only on an idempotent call.
          if (opts.signal?.aborted || lastAttempt || !idempotent) {
            throw toInstagramError(err);
          }
          await sleep(backoffMs(attempt), opts.signal);
          continue;
        }

        if (!res.ok) {
          const payload = await readBody(res);
          reportUsage(host, res.headers); // usage headers arrive on errors too
          // CC-DATA-21 — present-but-empty is not a trace id. `mapGraphError`
          // ran its non-empty filter over the id it found in the BODY only; the
          // header argument was adopted verbatim until 2026-09-24. So `x-fb-trace-id: ` (a blank
          // value, which a proxy or a load balancer in front of Meta can emit)
          // arrived on the error as `fbtraceId: ''` — an id-shaped field with no
          // id in it. It prints as a plausible reference in the line the operator
          // forwards to Meta support, where it is worthless, and it passes every
          // `fbtraceId !== undefined` check between here and the sink, so nothing
          // downstream can tell it apart from a real id. "Absent" is the honest
          // answer, and it is the one this seam already gives when the header is
          // missing altogether. The identical defect was closed first in
          // `core/refresh.ts`; this is the same fix on the path EVERY Graph call
          // takes, so the two must not drift apart.
          const traceId = res.headers.get('x-fb-trace-id');
          const mapped = mapGraphError(
            res.status,
            payload,
            isNonBlank(traceId) ? traceId : undefined,
          );
          const retryable = !lastAttempt && isRetryableKind(mapped.kind, idempotent, mapped.code);
          // `Retry-After` is read whenever the answer would be retried, and on
          // every throttle even when it will not be (a write, the last attempt):
          // a reset past the cap is news the caller needs either way (CC-RATE-3).
          if (retryable || mapped.kind === 'rate_limit') {
            const retryAfter = parseRetryAfter(res.headers.get('retry-after'), clock.now());
            if (retryAfter !== undefined && retryAfter > RETRY_AFTER_CAP_MS) {
              throw retryAfterTooLong(mapped, retryAfter);
            }
            if (retryable) {
              // Honor Retry-After when present, else exponential backoff.
              await sleep(retryAfter ?? backoffMs(attempt), opts.signal);
              continue;
            }
          }
          throw mapped;
        }

        // 5. Success: parse usage, DRAIN THE BODY, then throttle if hot.
        //
        // The order is the whole point. `sleep` here waits on `opts.signal`, not
        // on the per-attempt `timeout` from the top of the loop - so the throttle
        // burns its full THROTTLE_MS no matter how little of the deadline is
        // left, and the body stream it leaves unread is still governed by that
        // deadline. Reading after sleeping therefore threw away a response that
        // had already arrived in full. Measured end-to-end against the real
        // undici and the real clock, one loopback request whose headers land at
        // ~2 ms carrying `x-app-usage` at 95%: at `timeoutMs: 30_000` it returns
        // at 1009 ms, and at `timeoutMs: 900` the identical response fails at
        // 1004 ms with `DOMException` / `AbortError`. Nothing about the server
        // changed between those two runs - only how much deadline the throttle
        // had spent before anyone read the bytes.
        //
        // Draining first costs nothing: the bytes are on the wire already, and
        // the throttle's job is to delay the NEXT call, which a sleep placed
        // after the read does just as well (CC-PROC-184).
        const usage = reportUsage(host, res.headers);
        const parsed = (await readBody(res)) as T;
        if (usage.maxPct !== undefined && usage.maxPct > THROTTLE_PCT) {
          log.warn('approaching Instagram rate limit; throttling before returning', {
            host,
            usagePct: usage.maxPct,
          });
          await sleep(THROTTLE_MS, opts.signal);
        }
        return parsed;
      }
      /* c8 ignore start -- V8 reports the fall-through point after an endless
         `for` as an uncovered range: the loop has no exit condition, so control
         leaves it only by `return` or `throw`. Nothing here is skippable code. */
    } finally {
      /* c8 ignore stop */
      release();
    }
  };

  return request;
}
