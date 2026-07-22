/**
 * Shared contract types (Layer 0). FROZEN at Gate G1 — parallel tasks build
 * against these. A change here is a dedicated contract-bump PR (see
 * docs/workplan.md §1), never part of a feature branch.
 */

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
   * `access_token`; `appsecret_proof` only on graph.facebook.com.
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
}
