/**
 * Shared contract types (Layer 0). FROZEN at Gate G1 — parallel tasks build
 * against these. A change here is a dedicated contract-bump PR (see
 * docs/workplan.md §1), never part of a feature branch. Bumped once for 3.0
 * (V3-01, docs/v3-workplan.md): the ports at the end of this file.
 */
import type { Clock } from './clock.js';

/** Which Instagram auth path a token belongs to. */
export type AuthPath = 'ig-login' | 'fb-login';

/** Graph hosts on the SSRF allowlist (v1). */
export type GraphHost = 'graph.instagram.com' | 'graph.facebook.com';

/** HTTP methods the Graph client issues. */
export type HttpMethod = 'GET' | 'POST' | 'DELETE';

/** Discriminant on {@link InstagramError} — handlers and the model branch on this. */
export type ErrorKind = 'auth' | 'permission' | 'rate_limit' | 'validation' | 'upstream';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured stderr logger. Implementations redact secrets before writing.
 * Injected via {@link import('../mcp/define.js').ToolContext}; consumers depend
 * only on this interface, never on the concrete logger.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a logger with `bindings` merged into every record. */
  child(bindings: Record<string, unknown>): Logger;
}

export interface InstagramErrorInit {
  kind: ErrorKind;
  /** HTTP status of the upstream response, when there was one. */
  status?: number;
  fbtraceId?: string;
  /** Graph `error.code`. */
  code?: number;
  /** Graph `error.error_subcode`. */
  subcode?: number;
  /** Original payload/exception, retained for logging — never surfaced raw to the model. */
  cause?: unknown;
}

/**
 * The single error class for the whole server. One class with a `kind`
 * discriminant (not a subclass hierarchy) so callers switch on `kind`.
 * Full taxonomy: docs/operations.md.
 */
export class InstagramError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly fbtraceId?: string;
  readonly code?: number;
  readonly subcode?: number;

  constructor(message: string, init: InstagramErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'InstagramError';
    this.kind = init.kind;
    this.status = init.status;
    this.fbtraceId = init.fbtraceId;
    this.code = init.code;
    this.subcode = init.subcode;
  }
}

/** Type guard for {@link InstagramError}. */
export function isInstagramError(value: unknown): value is InstagramError {
  return value instanceof InstagramError;
}

// --- Graph API wire shapes -------------------------------------------------

export interface GraphPagingCursors {
  before?: string;
  after?: string;
}

export interface GraphPaging {
  cursors?: GraphPagingCursors;
  next?: string;
  previous?: string;
}

/** A Graph list/edge response (`{ data, paging }`). */
export interface GraphListResponse<T> {
  data: T[];
  paging?: GraphPaging;
}

/** The Graph error envelope (`{ error: {...} }`). */
export interface GraphErrorBody {
  error: {
    message: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    error_user_title?: string;
    error_user_msg?: string;
  };
}

// --- Rate-limit budget -----------------------------------------------------

/**
 * Parsed from `X-App-Usage` / `X-Business-Use-Case-Usage` on every response.
 * Percentages are 0–100; the highest field wins. See docs/operations.md.
 */
export interface UsageSnapshot {
  appUsagePct?: number;
  bucUsagePct?: number;
  /** Highest of the above — the number to throttle on. */
  maxPct?: number;
  raw?: Record<string, unknown>;
}

// --- HTTP client contract --------------------------------------------------

export interface IgRequestOptions {
  method: HttpMethod;
  /** Path after the version segment, leading slash, no host: e.g. `/{ig-id}/media`. */
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, string | number | boolean | undefined>;
  /** Defaults to the active auth provider's host. */
  host?: GraphHost;
  signal?: AbortSignal;
  /** Override method-derived idempotency (GET is idempotent by default). */
  idempotent?: boolean;
}

/**
 * The one network seam. Domain (`api/`) code is written against this type and
 * tested with a mock; only `core/http.ts` implements it. Resolves auth,
 * SSRF allowlist, retries, usage-header parsing, concurrency, and version pin.
 */
export type IgRequestFn = <T>(opts: IgRequestOptions) => Promise<T>;

// --- Auth provider contract ------------------------------------------------

/**
 * Contributes auth to an outgoing request. `ig-login` targets
 * graph.instagram.com; `fb-login` targets graph.facebook.com and adds
 * `appsecret_proof`. Injected params are merged into query/body by the client.
 */
export interface AuthProvider {
  readonly path: AuthPath;
  readonly defaultHost: GraphHost;
  /**
   * Params this provider contributes for a call to `host`: always
   * `access_token`; `appsecret_time` + `appsecret_proof` only on
   * graph.facebook.com (CC-AUTH-15). The client calls this once per attempt,
   * right before sending (CC-AUTH-79), so implementations must mint fresh
   * values on every call and never cache the result.
   */
  authParams(host: GraphHost): Promise<Record<string, string>>;
}

// --- Config / profiles / settings ------------------------------------------

/** A fully resolved account profile (default or `IG_PROFILE_<NAME>_*`). */
export interface ResolvedProfile {
  name: string;
  authPath: AuthPath;
  accessToken: string;
  accountId?: string;
  appId?: string;
  appSecret?: string;
  /**
   * Token expiry recorded by `login`/`refresh` (`IG_TOKEN_EXPIRES_AT` /
   * `IG_PROFILE_<NAME>_TOKEN_EXPIRES_AT`), Unix seconds, `0` = never expires.
   * Absent when no usable record exists. It describes the token that was
   * persisted with it, so a token swapped in by hand without updating the line
   * makes it stale.
   */
  tokenExpiresAtSec?: number;
  /**
   * Set (always `true`) when {@link tokenExpiresAtSec} came from a BARE record —
   * `<seconds>` with no `:<fingerprint>`, as an operator writes it by hand or as
   * records written before the fingerprint hold. Such a record is still read
   * (it is the documented hand-set remedy), but nothing ties it to the token,
   * so `token_status` and `doctor` report it as unverified (CC-AUTH-70). Absent
   * for a fingerprinted record, which reads back only for its own token
   * (CC-AUTH-59), and whenever `tokenExpiresAtSec` is absent.
   */
  tokenExpiryUnverified?: true;
}

/** Resolved runtime settings (every numeric/enum knob from architecture §12). */
export interface Settings {
  maxConcurrent: number;
  maxItems: number;
  refreshAfterDays: number;
  timeoutMs: number;
  logLevel: LogLevel;
  prettyJson: boolean;
  writeMode: 'preview' | 'apply';
  allowDestructive: boolean;
  transport: 'stdio' | 'http';
  httpHost: string;
  httpPort: number;
  /**
   * Absolute path of the applied-write journal (`IG_WRITE_JOURNAL`, default
   * `<XDG_STATE_HOME|~/.local/state>/instagram-mcp-ai/writes.jsonl`).
   *
   * Unlike the knobs above this one is **derived**, not a literal: its default
   * is built from the state home at load time. It is a settings field rather
   * than an ad-hoc lookup so the write gate reads a resolved value off
   * `ToolContext` like every other knob, instead of reaching into `process.env`
   * from inside `mcp/`.
   */
  writeJournal: string;
}

// --- 3.0 ports (contract bump V3-01) ----------------------------------------
//
// Everything below is frozen by the V3-01 contract bump (docs/v3-workplan.md)
// so the hosted-door tasks (V3-P1, V3-S1, V3-S2, V3-F1) can build against it in
// parallel. Nothing here is wired yet: until those tasks land, every seam is
// either an interface nobody implements in `src/` or an optional `ToolContext`
// field nobody sets, and today's behaviour is unchanged.

/**
 * A profile as anything outside the credential boundary may see it: its name,
 * auth path, account id and token *metadata* — never `accessToken`,
 * `appSecret` or `appId`. Built with {@link toProfileSummary}, which copies
 * named fields rather than deleting secret ones, so a secret field added to
 * {@link ResolvedProfile} later stays out of every summary by construction.
 */
export interface ProfileSummary {
  name: string;
  authPath: AuthPath;
  accountId?: string;
  /** As {@link ResolvedProfile.tokenExpiresAtSec}. */
  tokenExpiresAtSec?: number;
  /** As {@link ResolvedProfile.tokenExpiryUnverified}. */
  tokenExpiryUnverified?: true;
}

/**
 * The secret-free view of `profile`. Optional fields the profile does not
 * carry are omitted rather than set to `undefined`, so a summary serialises to
 * the same JSON whichever way it was built.
 */
export function toProfileSummary(profile: ResolvedProfile): ProfileSummary {
  return {
    name: profile.name,
    authPath: profile.authPath,
    ...(profile.accountId !== undefined && { accountId: profile.accountId }),
    ...(profile.tokenExpiresAtSec !== undefined && {
      tokenExpiresAtSec: profile.tokenExpiresAtSec,
    }),
    ...(profile.tokenExpiryUnverified === true && { tokenExpiryUnverified: true as const }),
  };
}

/**
 * Every configured profile plus the one a call without `account` uses. The same
 * shape as `LoadedProfiles` in `core/config.ts`, declared here so the
 * {@link CredentialProvider} port does not depend on the env-file parser.
 */
export interface ProfileSet {
  /** Every resolved profile; the default (`name === 'default'`) is always first. */
  profiles: ResolvedProfile[];
  /** Profile used when a call passes no `account` (`IG_ACTIVE_PROFILE`, else `default`). */
  defaultName: string;
}

/**
 * What a refresh (or a login) hands back to the credential store. Only
 * `accessToken` is required: an absent `authPath`, `accountId`, `appId` or
 * `appSecret` keeps the stored value. `expiresAtSec` is the exception, as in
 * `Credentials` (`core/config-write.ts`): absent means "unknown", and any
 * recorded expiry is REMOVED, because it described the token being replaced.
 * A profile the store does not hold yet needs `authPath`; without it `store`
 * refuses with `kind: 'validation'`.
 */
export interface CredentialUpdate {
  /** The new token (secret). Non-blank. */
  accessToken: string;
  /** Unix seconds, `0` = never expires; absent = unknown (clears the old record). */
  expiresAtSec?: number;
  authPath?: AuthPath;
  accountId?: string;
  appId?: string;
  /** Secret. */
  appSecret?: string;
}

/** Where a {@link CredentialProvider.store} landed — names only, never values. */
export interface CredentialReceipt {
  /**
   * Operator-facing description of the place written: the absolute env-file
   * path for the file backend, a non-secret locator for any other.
   */
  location: string;
  /** Keys created or updated, e.g. `IG_ACCESS_TOKEN` — names only. */
  keys: string[];
}

/**
 * The credential-provider port (V3-P1 implements it; the env-file provider is
 * the default). Today `src/index.ts` loads raw tokens once at start-up and only
 * the `refresh` CLI writes them back; behind this port the server can pick up a
 * rotated token without a restart, and a non-file backend (a keychain, a
 * secret manager) can replace the env file without touching `core/http.ts`.
 *
 * Secret boundary (docs/security.md §2, F-4): an implementation registers every
 * token and app secret it returns or stores with the {@link SecretRegistry}
 * BEFORE the value leaves the method, and never puts a secret value in an error
 * message, a log field or a {@link CredentialReceipt}. Errors are
 * {@link InstagramError}s; `kind: 'validation'` for a configuration problem,
 * exactly as `loadProfiles` / `resolveProfile` / `writeCredentials` throw today.
 */
export interface CredentialProvider {
  /** Short, non-secret backend label for logs and `doctor`, e.g. `env-file`. */
  readonly kind: string;
  /**
   * Read every configured profile from the backend. Called at start-up; may be
   * called again to pick up profiles added since.
   */
  load(): Promise<ProfileSet>;
  /**
   * The CURRENT credentials of one profile — the per-call read that makes
   * rotation without restart possible: after a successful {@link store} (or
   * an out-of-band rotation the backend can see) it returns the new token.
   * Lookup follows `resolveProfile`: case-insensitive, a blank or absent name
   * is the default profile, an unknown name throws `kind: 'validation'` naming
   * the configured profiles (names only).
   */
  resolve(name?: string): Promise<ResolvedProfile>;
  /**
   * Persist a refreshed or newly minted token for profile `name`, atomically.
   * Resolves only once the write is durable; from then on {@link resolve}
   * returns the new value.
   */
  store(name: string, update: CredentialUpdate): Promise<CredentialReceipt>;
}

// --- Process-wide singletons, injectable (V3-S1 wires them) ----------------

/** Redaction function: a deep copy of `value` with every known secret masked. */
export type Redactor = (value: unknown) => unknown;

/**
 * The secret registry behind the redactor (today the module-level set in
 * `core/redact.ts`). Injectable so two servers in one process (a hosted
 * embedder, a test) do not share one set of secrets.
 */
export interface SecretRegistry {
  /**
   * Register a secret the instant it exists. Values shorter than eight
   * characters are ignored, as `registerSecret` does today (an empty
   * registration would mask everything).
   */
  register(secret: string): void;
  /**
   * A redactor that reads this registry LIVE on every call, so one built at
   * start-up still masks secrets registered later; `extraSecrets` are scoped
   * to that redactor only (as `createRedactor({ extraSecrets })` today).
   */
  redactor(opts?: { extraSecrets?: readonly string[] }): Redactor;
}

/**
 * How long a call queued for a concurrency slot waits, measured on `clock`
 * ("server busy"). Structurally identical to `QueueWait` in `core/http.ts`, which
 * `mcp/` and `tools/` may not import (architecture §2); V3-S1 makes that one a
 * re-export of this.
 */
export interface QueueWait {
  readonly clock: Clock;
  readonly ms: number;
}

/**
 * The per-host concurrency counters behind `IG_MAX_CONCURRENT` (today the
 * module-level `sharedSemaphores` in `core/http.ts`). Structurally identical to
 * `SemaphoreRegistry` there — `test/contracts.test.ts` pins that the two are
 * assignable both ways — and declared here for the same layering reason as
 * {@link QueueWait}.
 */
export interface SemaphoreRegistry {
  /**
   * Take a slot for `host`, resolving with its release function. `max` is used
   * only the first time a host is seen. An aborted `signal` rejects the wait,
   * and so does a wait longer than `wait.ms`, with a "server busy" error.
   */
  acquire(
    host: GraphHost,
    max: number,
    signal: AbortSignal | undefined,
    wait: QueueWait,
  ): Promise<() => void>;
}

/**
 * Storage for the ADVISORY hashtag-search counter (Meta's 30 unique hashtags
 * per account per rolling 7 days; today the module-level map in
 * `tools/discovery.ts`). The ledger only stores; the limit, the window length
 * and the snapshot wording stay tool policy.
 */
export interface HashtagBudgetLedger {
  /**
   * Record one search of the normalised `hashtag` for `accountId` at `nowMs`:
   * first evict that account's entries at least `windowMs` old, then keep the
   * first-seen time of `hashtag` (a repeat does not move it). Returns the
   * number of unique hashtags the account holds in the window afterwards.
   */
  record(accountId: string, hashtag: string, nowMs: number, windowMs: number): number;
}
