/**
 * The Graph HTTP client (Layer 0). Produces the single network seam
 * {@link IgRequestFn} — the one place a socket is opened. Domain (`api/`) code
 * is written against `IgRequestFn` and tested with a mock; only this module
 * implements it. Owns: SSRF host gate, auth-param merge, version pin, per-host
 * concurrency, the retry/backoff matrix, usage-header parsing, and timeout.
 *
 * Layer 0 discipline: imports only from `core/*` (types, errors, host, clock) —
 * never `api/`, `mcp/`, or `tools/` (ESLint enforces this). Behavior spec:
 * docs/architecture.md §5, docs/operations.md §§1–3.
 */
import { assertAllowedHost, buildUrl } from './host.js';
import { mapGraphError, toInstagramError } from './errors.js';
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
}

// --- Tunables (docs/operations.md §§1–2) -----------------------------------

/** Total attempts including the first — 3 retries max. */
const MAX_ATTEMPTS = 4;
/** Exponential backoff `min(500·2^n, 8000) + jitter`. */
const BACKOFF_BASE_MS = 500;
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
  /** Resolves with a release function once a slot is free. */
  acquire(): Promise<() => void>;
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
    acquire: () =>
      new Promise<() => void>((resolve) => {
        if (active < max) {
          active += 1;
          resolve(release);
        } else {
          queue.push(() => resolve(release));
        }
      }),
  };
}

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
 * A mapped error is retryable when it is a throttle (any method) or a transient
 * upstream failure on an idempotent call. `validation`/`auth`/`permission` are
 * never retried (docs/operations.md §2).
 */
function isRetryableKind(kind: string, idempotent: boolean): boolean {
  if (kind === 'rate_limit') return true;
  if (kind === 'upstream') return idempotent;
  return false;
}

/**
 * Parse `Retry-After` (delta-seconds or an HTTP-date) into milliseconds, capped
 * at {@link RETRY_AFTER_CAP_MS}. `now` anchors the HTTP-date form.
 */
function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  if (ms < 0) ms = 0;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

/** Exponential backoff with jitter for attempt `n` (0-based). */
function backoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  return base + Math.random() * (base / 2);
}

// --- Response-body reader ---------------------------------------------------

/** Read a response body as JSON when possible, else as raw text (for errors). */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
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
 */
export function createIgRequest(deps: IgRequestDeps): IgRequestFn {
  const { auth, settings, clock, log, onUsage } = deps;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;

  // One semaphore per host, created lazily; only allowlisted hosts reach here.
  const semaphores = new Map<GraphHost, Semaphore>();
  const semaphoreFor = (host: GraphHost): Semaphore => {
    let sem = semaphores.get(host);
    if (sem === undefined) {
      sem = createSemaphore(settings.maxConcurrent);
      semaphores.set(host, sem);
    }
    return sem;
  };

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
        if (value !== undefined) form.append(key, String(value));
      }
      body = form.toString();
    }

    const idempotent = opts.idempotent ?? opts.method === 'GET';

    // Never log the token or the query string (both carry secrets) — path only.
    log.debug('graph request', { method: opts.method, host, path: opts.path });

    const release = await semaphoreFor(host).acquire();
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
          const mapped = mapGraphError(
            res.status,
            payload,
            res.headers.get('x-fb-trace-id') ?? undefined,
          );
          if (lastAttempt || !isRetryableKind(mapped.kind, idempotent)) {
            throw mapped;
          }
          // Honor Retry-After (capped) when present, else exponential backoff.
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'), clock.now());
          await sleep(retryAfter ?? backoffMs(attempt), opts.signal);
          continue;
        }

        // 4. Success: parse usage, proactively throttle if hot, return the body.
        const usage = reportUsage(host, res.headers);
        if (usage.maxPct !== undefined && usage.maxPct > THROTTLE_PCT) {
          log.warn('approaching Instagram rate limit; throttling before returning', {
            host,
            usagePct: usage.maxPct,
          });
          await sleep(THROTTLE_MS, opts.signal);
        }
        return (await readBody(res)) as T;
      }
    } finally {
      release();
    }
  };

  return request;
}
