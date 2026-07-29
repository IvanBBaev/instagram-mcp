/**
 * Fixture sanitizer (workplan T-E1). Turns a **raw** Graph JSON response into a
 * copy that is safe to commit under `test/fixtures/`, so mocked unit tests can
 * replay real wire shapes without the repository ever holding a token, a real
 * account/media ID, a handle, a CDN URL or a line of user-written text.
 *
 * ## Policy: default DENY
 *
 * The sanitizer is an **allowlist**, not a blocklist. A field is copied only
 * when {@link DEFAULT_FIELD_POLICY} (or a caller override) names it and says how
 * it may be copied; **every unrecognised key is dropped** and recorded in
 * {@link Sanitizer.droppedKeys}. This is deliberate: an unrecognised field is
 * exactly where a token, a signed CDN URL or a piece of PII leaks — Meta adds
 * fields without notice (CC-DATA-7), and a blocklist can only scrub what it has
 * already been taught about. Widening the policy is a conscious edit reviewed
 * like any other code; forgetting to widen it costs a missing field in a
 * fixture, never a leaked secret.
 *
 * ## What is replaced, and with what
 *
 * | Rule       | Applied to (examples)                              | Result |
 * |------------|----------------------------------------------------|--------|
 * | `id`       | `id`, `user_id`, `parent_id`, `app_id`             | stable synthetic 17-digit ID (`17800000000000001`) |
 * | `username` | `username`                                          | stable synthetic handle (`example_account_1`) |
 * | `text`     | `caption`, `text`, `biography`, `name`, `message`   | `[synthetic text: N code points removed]` |
 * | `url`      | `media_url`, `permalink`, `profile_picture_url`     | `https://example.invalid/<field>/<n>` |
 * | `graphUrl` | `paging.next`, `paging.previous`                    | rebuilt Graph URL: auth params and every unknown query key dropped |
 * | `opaque`   | `paging.cursors.{before,after}`, `fbtrace_id`        | `SYNTHETIC_OPAQUE_1` |
 * | `keep`     | `media_type`, `like_count`, `timestamp`, `code`      | copied verbatim (Meta vocabulary / counters) |
 * | `keepDeep` | *(no default — opt-in escape hatch)*                 | subtree copied verbatim |
 * | `recurse`  | `data`, `paging`, `children`, `replies`, `media`     | walked with the same policy |
 * | `drop`     | *(explicit denial)*                                  | key omitted |
 *
 * ID and handle replacements are **stable within one sanitizer instance**: the
 * same real value always maps to the same synthetic one, so cross-references
 * between captured responses (a media ID in a list, then in its detail call and
 * again in its comments) survive sanitization, while distinct real values never
 * collide (the mapping is counter-based, hence injective by construction). Use
 * ONE sanitizer per capture run for that property to hold across responses.
 *
 * ## Backstop
 *
 * The allowlist walk is followed by a pass through the production redactor
 * (`src/core/redact.ts`) — the same one the logger and MCP results use — so any
 * token-shaped string that somehow survived an allowlisted field is masked with
 * `[REDACTED]`. There is deliberately no second definition of "token-shaped" in
 * this repo: {@link findSecretLeaks} detects leaks by asking that same redactor
 * whether it would still change anything. Capture scripts register the live
 * token, app secret and `appsecret_proof` with `registerSecret()` before
 * capturing, which makes exact-value redaction (not pattern matching) the
 * primary mechanism, per the redactor's own contract.
 *
 * Pure: never mutates its input, no I/O, no clock.
 */
import { createRedactor } from '../../src/core/redact.js';

/** How one allowlisted field may be copied into a fixture. */
export type FieldRule =
  | 'keep'
  | 'keepDeep'
  | 'id'
  | 'username'
  | 'text'
  | 'url'
  | 'graphUrl'
  | 'opaque'
  | 'recurse'
  | 'drop';

/** Synthetic IDs are 17 digits, `178`-prefixed like real IG IDs but obviously fake. */
export const SYNTHETIC_ID_RE = /^178\d{14}$/;

/** Host used for every replaced URL: `.invalid` is reserved (RFC 2606) and never resolves. */
export const SYNTHETIC_URL_HOST = 'example.invalid';

/** Prefix of every replaced handle. */
export const SYNTHETIC_USERNAME_PREFIX = 'example_account_';

/** Prefix of every replaced opaque blob (cursors, trace IDs). */
export const SYNTHETIC_OPAQUE_PREFIX = 'SYNTHETIC_OPAQUE_';

/** Graph hosts a `paging` URL may point at — anything else is dropped. */
const ALLOWED_URL_HOSTS: ReadonlySet<string> = new Set([
  'graph.instagram.com',
  'graph.facebook.com',
]);

/**
 * Path segments a rebuilt Graph URL may keep verbatim. Everything else is either
 * a numeric ID (mapped) or replaced with `unknown-segment` — a handle is a valid
 * lowercase word, so "looks like a word" is not a safe keep rule.
 */
const ALLOWED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'me',
  'accounts',
  'media',
  'children',
  'comments',
  'replies',
  'tags',
  'insights',
  'debug_token',
  'ig_hashtag_search',
  'top_media',
  'recent_media',
  'content_publishing_limit',
  'media_publish',
]);

/**
 * Query params a rebuilt Graph URL may keep. `access_token` / `appsecret_proof`
 * are absent by construction (default deny), and so is `fields` — a `fields`
 * expression can embed a handle (`business_discovery.username(<handle>)`).
 */
const ALLOWED_QUERY_KEYS: ReadonlySet<string> = new Set([
  'limit',
  'metric',
  'period',
  'since',
  'until',
]);

/** Query params kept, but with their value replaced by a synthetic opaque blob. */
const OPAQUE_QUERY_KEYS: ReadonlySet<string> = new Set(['after', 'before']);

/**
 * The allowlist. Keys are matched by **name at any depth** — Graph reuses the
 * same field names throughout a response tree (`id`, `media_type`, `timestamp`).
 * Where one name carries different meanings on different endpoints (`name` is a
 * Page's display name on `/me/accounts` but an insights metric name on
 * `/insights`), the default is the conservative reading and the capture site
 * passes a per-endpoint override.
 */
export const DEFAULT_FIELD_POLICY: Readonly<Record<string, FieldRule>> = Object.freeze({
  // --- Containers: walked with the same policy -----------------------------
  data: 'recurse',
  paging: 'recurse',
  cursors: 'recurse',
  children: 'recurse',
  replies: 'recurse',
  media: 'recurse',
  from: 'recurse',
  summary: 'recurse',
  business_discovery: 'recurse',
  instagram_business_account: 'recurse',
  values: 'recurse',
  total_value: 'recurse',
  breakdowns: 'recurse',
  results: 'recurse',
  dimension_values: 'recurse',
  config: 'recurse',
  quota_usage: 'recurse',
  granular_scopes: 'recurse',
  error: 'recurse',
  // `value` is a number for most metrics and a breakdown object for
  // demographics; recursion keeps the number and default-denies the object's
  // keys. A demographics capture overrides this to `keepDeep` deliberately
  // (aggregate counts over >= 100 followers, no individual is identifiable).
  value: 'recurse',

  // --- Identifiers: mapped to stable synthetic IDs -------------------------
  id: 'id',
  ig_id: 'id',
  user_id: 'id',
  owner_id: 'id',
  parent_id: 'id',
  media_id: 'id',
  comment_id: 'id',
  container_id: 'id',
  creation_id: 'id',
  hashtag_id: 'id',
  account_id: 'id',
  page_id: 'id',
  app_id: 'id',
  target_ids: 'id',

  // --- Handles -------------------------------------------------------------
  username: 'username',

  // --- Free text (user-written or operator-supplied) -----------------------
  caption: 'text',
  text: 'text',
  message: 'text',
  biography: 'text',
  name: 'text',
  title: 'text',
  description: 'text',
  category: 'text',
  application: 'text',
  error_user_title: 'text',
  error_user_msg: 'text',
  // A container `status` string can quote the operator's own `image_url`.
  status: 'text',

  // --- URLs ----------------------------------------------------------------
  media_url: 'url',
  thumbnail_url: 'url',
  permalink: 'url',
  profile_picture_url: 'url',
  profile_pic_url: 'url',
  picture: 'url',
  website: 'url',
  image_url: 'url',
  video_url: 'url',
  url: 'url',
  link: 'url',

  // --- Graph pagination URLs (carry the token in their query string) -------
  next: 'graphUrl',
  previous: 'graphUrl',

  // --- Opaque blobs: no meaning to a test, plenty of meaning to Meta -------
  after: 'opaque',
  before: 'opaque',
  fbtrace_id: 'opaque',

  // --- Meta vocabulary, counters and timestamps ----------------------------
  media_type: 'keep',
  media_product_type: 'keep',
  status_code: 'keep',
  type: 'keep',
  timestamp: 'keep',
  end_time: 'keep',
  period: 'keep',
  like_count: 'keep',
  comments_count: 'keep',
  followers_count: 'keep',
  follows_count: 'keep',
  media_count: 'keep',
  count: 'keep',
  total_count: 'keep',
  quota_total: 'keep',
  quota_duration: 'keep',
  hidden: 'keep',
  is_valid: 'keep',
  is_shared_to_feed: 'keep',
  is_comment_enabled: 'keep',
  issued_at: 'keep',
  expires_at: 'keep',
  data_access_expires_at: 'keep',
  scopes: 'keep',
  scope: 'keep',
  code: 'keep',
  error_subcode: 'keep',
  // Part of Meta's error envelope, and the whole point of an error fixture.
  is_transient: 'keep',
  success: 'keep',
  limit: 'keep',
});

/** Options for {@link createSanitizer}. */
export interface SanitizerOptions {
  /**
   * Per-capture policy tweaks merged over {@link DEFAULT_FIELD_POLICY}. Use this
   * to widen a field for one endpoint where the default reading is too strict
   * (e.g. `{ name: 'keep' }` for insights, where `name` is a metric name).
   */
  overrides?: Readonly<Record<string, FieldRule>>;
  /** Extra exact secrets for the backstop redactor, on top of the global registry. */
  extraSecrets?: readonly string[];
}

/** A capture-scoped sanitizer. One instance per capture run (see the module docstring). */
export interface Sanitizer {
  /**
   * Sanitize one raw Graph response; never mutates `value`.
   *
   * `overrides` are merged over the instance policy for this call only, which is
   * how a capture run keeps ONE sanitizer (hence one ID mapping across every
   * fixture) while still widening a field for a single endpoint — `name` means
   * "metric name" on `/insights` and "the operator's display name" everywhere
   * else, and only the former may be kept.
   */
  sanitize(value: unknown, overrides?: Readonly<Record<string, FieldRule>>): unknown;
  /** Paths of every key dropped for not being in the policy, sorted and de-duplicated. */
  readonly droppedKeys: readonly string[];
  /** Real-ID -> synthetic-ID mapping accumulated so far (for diagnostics/tests). */
  readonly idMap: ReadonlyMap<string, string>;
}

/** Sentinel returned by the walk for "omit this key entirely". */
const DROP = Symbol('drop');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Code points, not UTF-16 units — emoji and ZWJ sequences count as authored. */
function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Build a capture-scoped {@link Sanitizer}. Reuse one instance for every
 * response in a capture so IDs and handles stay consistent across fixtures.
 */
export function createSanitizer(opts: SanitizerOptions = {}): Sanitizer {
  const basePolicy: Record<string, FieldRule> = {
    ...DEFAULT_FIELD_POLICY,
    ...(opts.overrides ?? {}),
  };
  const redact = createRedactor({ extraSecrets: [...(opts.extraSecrets ?? [])] });

  const ids = new Map<string, string>();
  const usernames = new Map<string, string>();
  const urls = new Map<string, string>();
  const opaques = new Map<string, string>();
  const dropped = new Set<string>();

  /** Counter-based, hence injective: distinct inputs can never share an output. */
  const mapId = (raw: string): string => {
    const existing = ids.get(raw);
    if (existing !== undefined) return existing;
    const synthetic = `178${String(ids.size + 1).padStart(14, '0')}`;
    ids.set(raw, synthetic);
    return synthetic;
  };

  const mapUsername = (raw: string): string => {
    const existing = usernames.get(raw);
    if (existing !== undefined) return existing;
    const synthetic = `${SYNTHETIC_USERNAME_PREFIX}${usernames.size + 1}`;
    usernames.set(raw, synthetic);
    return synthetic;
  };

  const mapUrl = (key: string, raw: string): string => {
    const cacheKey = `${key} ${raw}`;
    const existing = urls.get(cacheKey);
    if (existing !== undefined) return existing;
    const synthetic = `https://${SYNTHETIC_URL_HOST}/${key}/${urls.size + 1}`;
    urls.set(cacheKey, synthetic);
    return synthetic;
  };

  const mapOpaque = (raw: string): string => {
    const existing = opaques.get(raw);
    if (existing !== undefined) return existing;
    const synthetic = `${SYNTHETIC_OPAQUE_PREFIX}${opaques.size + 1}`;
    opaques.set(raw, synthetic);
    return synthetic;
  };

  /**
   * Rebuild a Graph pagination URL from allowlisted parts only. The token and
   * the `appsecret_proof` ride this URL's query string, so nothing is copied
   * across: host must be a known Graph host, path segments are either the
   * version, a mapped ID or a known edge name, and only
   * {@link ALLOWED_QUERY_KEYS} / {@link OPAQUE_QUERY_KEYS} survive.
   */
  const mapGraphUrl = (raw: string): string | typeof DROP => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return DROP;
    }
    if (parsed.protocol !== 'https:' || !ALLOWED_URL_HOSTS.has(parsed.hostname)) return DROP;

    const segments = parsed.pathname.split('/').map((segment) => {
      if (segment === '') return segment;
      if (/^v\d+\.\d+$/.test(segment)) return segment;
      if (/^\d{5,}$/.test(segment)) return mapId(segment);
      if (ALLOWED_PATH_SEGMENTS.has(segment)) return segment;
      return 'unknown-segment';
    });

    const query = new URLSearchParams();
    for (const [key, value] of parsed.searchParams) {
      if (OPAQUE_QUERY_KEYS.has(key)) query.append(key, mapOpaque(value));
      else if (ALLOWED_QUERY_KEYS.has(key)) query.append(key, value);
    }
    const search = query.toString();
    const base = `https://${parsed.hostname}${segments.join('/')}`;
    return search === '' ? base : `${base}?${search}`;
  };

  /**
   * The walker is built per call so a per-call `overrides` can change the policy
   * without disturbing the ID/handle/cursor maps, which live in the instance
   * closure and are what makes fixtures cross-referenceable.
   */
  const makeWalk = (policy: Record<string, FieldRule>) => {
    const walk = (
      value: unknown,
      rule: FieldRule,
      path: string,
      seen: WeakSet<object>,
    ): unknown => {
      if (rule === 'drop') return DROP;
      // Verbatim escape hatch: still passes the redactor backstop at the end.
      if (rule === 'keepDeep') return structuredClone(value);

      // Scalar rules apply elementwise to arrays; `recurse` handles them below.
      if (Array.isArray(value) && rule !== 'recurse') {
        return value
          .map((item) => walk(item, rule, `${path}[]`, seen))
          .filter((item) => item !== DROP);
      }

      switch (rule) {
        case 'id':
          if (typeof value === 'string' || typeof value === 'number') return mapId(String(value));
          return walk(value, 'recurse', path, seen);
        case 'username':
          if (typeof value === 'string') return mapUsername(value);
          return walk(value, 'recurse', path, seen);
        case 'text':
          if (typeof value === 'string') {
            return `[synthetic text: ${codePointLength(value)} code points removed]`;
          }
          return walk(value, 'recurse', path, seen);
        case 'url':
          if (typeof value === 'string') {
            const field = path.slice(path.lastIndexOf('.') + 1).replace(/[^a-z_]/gi, '') || 'url';
            return mapUrl(field, value);
          }
          return walk(value, 'recurse', path, seen);
        case 'graphUrl':
          if (typeof value === 'string') return mapGraphUrl(value);
          return DROP;
        case 'opaque':
          if (typeof value === 'string' || typeof value === 'number') {
            return mapOpaque(String(value));
          }
          return walk(value, 'recurse', path, seen);
        case 'keep':
          // A `keep` on a container would smuggle its unknown children through.
          if (isPlainObject(value)) return walk(value, 'recurse', path, seen);
          return value;
        default:
          break;
      }

      // 'recurse': the default-deny walk.
      if (typeof value === 'string') {
        // A string where a container was expected is unclassified free text.
        return `[synthetic text: ${codePointLength(value)} code points removed]`;
      }
      if (value === null || typeof value !== 'object') return value;
      if (seen.has(value)) return DROP;
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return value
            .map((item) => walk(item, 'recurse', `${path}[]`, seen))
            .filter((item) => item !== DROP);
        }
        const out: Record<string, unknown> = {};
        for (const [key, raw] of Object.entries(value)) {
          const childRule = policy[key];
          const childPath = `${path}.${key}`;
          if (childRule === undefined) {
            dropped.add(childPath);
            continue;
          }
          const result = walk(raw, childRule, childPath, seen);
          if (result !== DROP) out[key] = result;
        }
        return out;
      } finally {
        seen.delete(value);
      }
    };
    return walk;
  };

  const baseWalk = makeWalk(basePolicy);

  return {
    sanitize(value: unknown, overrides?: Readonly<Record<string, FieldRule>>): unknown {
      const walk = overrides === undefined ? baseWalk : makeWalk({ ...basePolicy, ...overrides });
      const cleaned = walk(value, 'recurse', '$', new WeakSet<object>());
      // Backstop: the production redactor masks anything token-shaped that an
      // allowlisted field let through (and every registered exact secret).
      return redact(cleaned === DROP ? null : cleaned);
    },
    get droppedKeys(): readonly string[] {
      return [...dropped].sort();
    },
    get idMap(): ReadonlyMap<string, string> {
      return new Map(ids);
    },
  };
}

/**
 * One-shot convenience: sanitize a single response with a fresh sanitizer.
 * Prefer {@link createSanitizer} when capturing several responses — cross-
 * response ID stability only holds within one instance.
 */
export function sanitizeGraphResponse(value: unknown, opts?: SanitizerOptions): unknown {
  return createSanitizer(opts).sanitize(value);
}

/**
 * JSON paths at which the production redactor would still change something —
 * i.e. every place a registered secret or a token-shaped string survives. An
 * empty array is the fixture-safe verdict used by the capture scripts before
 * anything is written to disk.
 */
export function findSecretLeaks(
  value: unknown,
  opts: { extraSecrets?: readonly string[] } = {},
): string[] {
  const redact = createRedactor({ extraSecrets: [...(opts.extraSecrets ?? [])] });
  return diffPaths(value, redact(value), '$');
}

/**
 * Throw unless `value` is free of secret-shaped content. The last gate a capture
 * script passes before writing a fixture: a fixture that trips this is never
 * written, because a leaked token in git history cannot be un-leaked.
 */
export function assertFixtureSafe(value: unknown, label: string): void {
  const leaks = findSecretLeaks(value);
  if (leaks.length > 0) {
    throw new Error(
      `Refusing to write fixture "${label}": secret-shaped content at ${leaks.join(', ')}`,
    );
  }
}

/** Structural diff returning the paths whose leaf values differ. */
function diffPaths(a: unknown, b: unknown, path: string): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      out.push(...diffPaths(a[i], b[i], `${path}[${i}]`));
    }
    return out;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: string[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out.push(...diffPaths(a[key], b[key], `${path}.${key}`));
    }
    return out;
  }
  return Object.is(a, b) ? [] : [path];
}
