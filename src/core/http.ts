/**
 * The Graph HTTP client (Layer 0). Produces the single network seam
 * {@link IgRequestFn} — the one place a socket is opened. Domain (`api/`) code
 * is written against `IgRequestFn` and tested with a mock; only this module
 * implements it. Owns: SSRF host gate, auth-param merge, version pin, per-host
 * concurrency, the retry/backoff matrix, usage-header parsing, timeout, and the
 * response-body size cap.
 *
 * Layer 0 discipline: imports only from `core/*` (types, errors, host, clock, body) —
 * never `api/`, `mcp/`, or `tools/` (ESLint enforces this). Behavior spec:
 * docs/architecture.md §5, docs/operations.md §§1–3.
 */
import { MAX_RESPONSE_BYTES, readCappedText } from './body.js';
import { assertAllowedHost, buildUrl } from './host.js';
import { mapGraphError, toInstagramError } from './errors.js';
import { InstagramError } from './types.js';
import type { Clock } from './clock.js';
import type {
  AuthProvider,
  GraphHost,
  IgRequestFn,
  IgRequestOptions,
  Logger,
  Settings,
  UsageSnapshot,
} from './types.js';

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
/** `Retry-After` is honored but never trusted beyond this ceiling. */
const RETRY_AFTER_CAP_MS = 60_000;
/** Proactively slow down once usage crosses this percentage. */
const THROTTLE_PCT = 90;
/** Short courtesy pause when over the throttle threshold. */
const THROTTLE_MS = 1000;
/** Usage-header fields that carry a 0–100 percentage. */
const USAGE_FIELDS = ['call_count', 'total_cputime', 'total_time'] as const;

// --- Per-host concurrency semaphore ----------------------------------------

interface Semaphore {
  /**
   * Resolves with a release function once a slot is free; rejects with the
   * abort reason, as an InstagramError, if `signal` is aborted before then.
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
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
    acquire: (signal) =>
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
        const waiter = (): void => {
          detach();
          resolve(release);
        };
        queue.push(waiter);
        if (signal !== undefined) {
          const onAbort = (): void => {
            // Leave the queue without touching `active`: a waiter never held a
            // slot, so there is nothing to give back. `release` cannot have
            // shifted this waiter already - it calls `waiter`, which detaches
            // this listener synchronously, before `abort` could fire it.
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
 * Holder of the per-host semaphores. `IG_MAX_CONCURRENT` is a budget against
 * **Meta**, not against a call site, so the counters must outlive any single
 * {@link createIgRequest} call: the composition root builds a fresh seam per
 * tool call, and a map owned by the factory would silently multiply the limit
 * by the number of in-flight calls.
 */
export interface SemaphoreRegistry {
  /**
   * Take a slot for `host`, resolving with its release function. `max` is used
   * only the first time a host is seen — `maxConcurrent` is resolved once per
   * process by the composition root, so every caller passes the same value.
   * An aborted `signal` rejects the wait and removes it from the queue.
   */
  acquire(host: GraphHost, max: number, signal?: AbortSignal): Promise<() => void>;
}

/** An independent set of per-host counters (one per process; tests make their own). */
export function createSemaphoreRegistry(): SemaphoreRegistry {
  // One semaphore per host, created lazily; only allowlisted hosts reach here.
  const semaphores = new Map<GraphHost, Semaphore>();
  return {
    acquire(host: GraphHost, max: number, signal?: AbortSignal): Promise<() => void> {
      let sem = semaphores.get(host);
      if (sem === undefined) {
        sem = createSemaphore(max);
        semaphores.set(host, sem);
      }
      return sem.acquire(signal);
    },
  };
}

/** The registry every seam shares unless one is injected. */
const sharedSemaphores = createSemaphoreRegistry();

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
 * A throttle or a transient upstream failure is retryable — but only on an
 * idempotent call. A non-idempotent write is never replayed: Meta may have
 * accepted it before the 429/5xx reached us, so retrying `media_publish` costs
 * publishing quota and leaves a duplicate, publicly visible post, and retrying
 * a comment write duplicates the comment (`api/publishing.ts`, docs/operations.md
 * §2). `validation`/`auth`/`permission` are never retried at all. GET is
 * idempotent by default, so read-path throttle retries are unaffected.
 */
function isRetryableKind(kind: string, idempotent: boolean): boolean {
  if (kind === 'rate_limit' || kind === 'upstream') return idempotent;
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
 * capped at {@link RETRY_AFTER_CAP_MS}. `now` anchors the date form. Any other
 * value is `undefined`, so the caller backs off instead.
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
  if (ms < 0) ms = 0;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
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

    // 2. Merge auth params (auth wins) and build the pinned, allowlisted URL.
    //    Auth params ride the query string for every method (Graph accepts it).
    const authParams = await auth.authParams(host);
    const url = buildUrl(host, opts.path, { ...opts.params, ...authParams });

    // POST/DELETE carry `opts.body` as an x-www-form-urlencoded request body.
    let body: string | undefined;
    if (opts.method !== 'GET' && opts.body) {
      const form = new URLSearchParams();
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
        // Reachability, stated exactly rather than assumed: no in-repo caller
        // populates `opts.body` at all today. Every write in `api/comments.ts`
        // and `api/publishing.ts` passes its fields as `params` — Graph accepts
        // them on a POST, and `buildUrl` already guards that path — and the two
        // untyped `scripts/*.mjs` entry points that drive this seam directly do
        // the same. So a `null` needs a future api function that starts using
        // the body, or a JavaScript consumer of the shipped `.d.ts` (this
        // package ships types, not enforcement). The guard is here because the
        // sink is permanent while the caller set is not, and because a write is
        // the one place where a silently wrong value is also irreversible.
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
      // Reachability, stated exactly rather than assumed: as with CC-DATA-12, no
      // in-repo caller populates `opts.body` at all today, so nothing in this
      // repo can reach the empty form. The guard is here because the sink is
      // permanent while the caller set is not, and because "an empty body and no
      // body are the same request" is the kind of invariant a future api
      // function will assume rather than check.
      //
      // Equivalent-mutant note: `form.toString() !== ''` — and its truthiness
      // twin — cannot be told apart from the field count by any input. A
      // `URLSearchParams` holding one pair serializes to at least `=` (that is
      // what `append('', '')` produces), so "no pairs" and "empty serialization"
      // coincide for every possible form. The count is kept because it is the
      // question actually being asked; the string test would agree here only by
      // arithmetic, and would stop agreeing the moment someone reached for `!`.
      if (form.size > 0) body = form.toString();
    }

    const idempotent = opts.idempotent ?? opts.method === 'GET';

    // Never log the token or the query string (both carry secrets) — path only.
    log.debug('graph request', { method: opts.method, host, path: opts.path });

    // A cancelled call leaves here, before any slot or socket is spent on it:
    // an already-aborted signal rejects at once, and one aborted while queued
    // rejects when it fires (see `createSemaphore`).
    const release = await semaphores.acquire(host, settings.maxConcurrent, opts.signal);
    try {
      for (let attempt = 0; ; attempt++) {
        const lastAttempt = attempt >= MAX_ATTEMPTS - 1;

        // 3. Per-attempt timeout signal combined with the caller's signal.
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
          if (lastAttempt || !isRetryableKind(mapped.kind, idempotent)) {
            throw mapped;
          }
          // Honor Retry-After (capped) when present, else exponential backoff.
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'), clock.now());
          await sleep(retryAfter ?? backoffMs(attempt), opts.signal);
          continue;
        }

        // 4. Success: parse usage, DRAIN THE BODY, then throttle if hot.
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
