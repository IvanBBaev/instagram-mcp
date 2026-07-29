/**
 * Settings loader (Layer 0). Reads every numeric/enum knob from the environment,
 * applies the canonical defaults from docs/architecture.md §12, coerces and
 * validates, and throws `InstagramError({ kind: 'validation' })` on bad input.
 *
 * Env-name mapping (docs/architecture.md §12 is authoritative):
 *   IG_MAX_CONCURRENT   -> maxConcurrent     (default 4)
 *   IG_MAX_ITEMS        -> maxItems          (default 200)
 *   IG_REFRESH_AFTER_DAYS -> refreshAfterDays(default 45)
 *   IG_TIMEOUT_MS       -> timeoutMs         (default 30000)
 *   IG_LOG_LEVEL        -> logLevel          (default 'info')
 *   IG_PRETTY_JSON      -> prettyJson        (default false)
 *   IG_WRITE_MODE       -> writeMode         (default 'preview')
 *   IG_ALLOW_DESTRUCTIVE-> allowDestructive  (default false)
 *   IG_TRANSPORT        -> transport         (default 'stdio')
 *   IG_HTTP_HOST        -> httpHost          (default '127.0.0.1', loopback only)
 *   IG_PORT             -> httpPort          (default 3000)
 *
 * Note: the HTTP port env var is `IG_PORT` (not `IG_HTTP_PORT`) per §12 and
 * `.env.example`; it pairs with `IG_HTTP_HOST` for the HTTP-transport binding.
 * `IG_HTTP_HOST` is validated like every other knob: only loopback addresses are
 * accepted, because the HTTP transport binds loopback only (docs/security.md §3).
 */
import { InstagramError, type LogLevel, type Settings } from './types.js';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const WRITE_MODES = ['preview', 'apply'] as const;
const TRANSPORTS = ['stdio', 'http'] as const;

/** Canonical defaults from docs/architecture.md §12. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  maxConcurrent: 4,
  maxItems: 200,
  refreshAfterDays: 45,
  timeoutMs: 30000,
  logLevel: 'info',
  prettyJson: false,
  writeMode: 'preview',
  allowDestructive: false,
  transport: 'stdio',
  httpHost: '127.0.0.1',
  httpPort: 3000,
});

/** Truthy/falsy spellings accepted for boolean knobs (case-insensitive). */
const TRUE_TOKENS = new Set(['true', '1', 'yes', 'on']);
const FALSE_TOKENS = new Set(['false', '0', 'no', 'off']);

function fail(message: string): never {
  throw new InstagramError(message, { kind: 'validation' });
}

/** Trimmed value, or `undefined` when unset or blank (blank means "use default"). */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

interface IntRange {
  min: number;
  max: number;
}

function parseIntEnv(env: NodeJS.ProcessEnv, name: string, def: number, range: IntRange): number {
  const raw = read(env, name);
  if (raw === undefined) return def;
  if (!/^[+-]?\d+$/.test(raw)) {
    fail(`${name} must be an integer, got "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    fail(`${name} must be a safe integer, got "${raw}"`);
  }
  if (value < range.min || value > range.max) {
    fail(`${name} must be in [${range.min}, ${range.max}], got ${value}`);
  }
  return value;
}

function parseBoolEnv(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const raw = read(env, name);
  if (raw === undefined) return def;
  const token = raw.toLowerCase();
  if (TRUE_TOKENS.has(token)) return true;
  if (FALSE_TOKENS.has(token)) return false;
  fail(`${name} must be a boolean (true/false), got "${raw}"`);
}

/**
 * Loopback host literals accepted for the HTTP-transport bind address, plus the
 * expanded and bracketed spellings of the IPv6 loopback. Everything in
 * `127.0.0.0/8` is additionally recognized by {@link isLoopbackHost}.
 */
const LOOPBACK_LITERALS = new Set([
  'localhost',
  '::1',
  '[::1]',
  '0:0:0:0:0:0:0:1',
  '[0:0:0:0:0:0:0:1]',
]);

/** True for `a.b.c.d` with every octet in 0–255. */
function isIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Is `host` a loopback bind address? Accepts `localhost`, the whole IPv4
 * loopback block `127.0.0.0/8`, and the IPv6 loopback `::1` (bracketed or
 * expanded). Wildcards (`0.0.0.0`, `::`) and every routable address are NOT
 * loopback — binding one exposes the full tool surface, writes included, to
 * anyone who can route to it.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (LOOPBACK_LITERALS.has(h)) return true;
  return isIpv4(h) && h.startsWith('127.');
}

/**
 * The HTTP transport binds loopback only (docs/security.md §3, SECURITY.md:
 * "the Streamable HTTP transport stays loopback-bound"), and `IG_HTTP_TOKEN` is
 * optional — so an unvalidated bind address is the difference between a local
 * developer transport and an unauthenticated public one. Validate it like every
 * other knob instead of passing it through verbatim.
 */
function parseHostEnv(env: NodeJS.ProcessEnv, name: string, def: string): string {
  const raw = read(env, name);
  if (raw === undefined) return def;
  if (!isLoopbackHost(raw)) {
    fail(
      `${name} must be a loopback address (127.0.0.1, localhost or ::1), got "${raw}" — the ` +
        'HTTP transport binds loopback only; to expose it, put an authenticating reverse proxy ' +
        'in front of a loopback bind.',
    );
  }
  return raw;
}

function parseEnumEnv<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  def: T,
  allowed: readonly T[],
): T {
  const raw = read(env, name);
  if (raw === undefined) return def;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  fail(`${name} must be one of ${allowed.join(' | ')}, got "${raw}"`);
}

/**
 * Resolve runtime {@link Settings} from `env` (defaults to `process.env`).
 * Every field is defaulted, coerced and validated; invalid input raises
 * `InstagramError({ kind: 'validation' })` with a message naming the variable.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const d = DEFAULT_SETTINGS;
  return {
    maxConcurrent: parseIntEnv(env, 'IG_MAX_CONCURRENT', d.maxConcurrent, { min: 1, max: 64 }),
    maxItems: parseIntEnv(env, 'IG_MAX_ITEMS', d.maxItems, { min: 1, max: 100_000 }),
    refreshAfterDays: parseIntEnv(env, 'IG_REFRESH_AFTER_DAYS', d.refreshAfterDays, {
      min: 1,
      max: 60,
    }),
    timeoutMs: parseIntEnv(env, 'IG_TIMEOUT_MS', d.timeoutMs, { min: 1, max: 600_000 }),
    logLevel: parseEnumEnv<LogLevel>(env, 'IG_LOG_LEVEL', d.logLevel, LOG_LEVELS),
    prettyJson: parseBoolEnv(env, 'IG_PRETTY_JSON', d.prettyJson),
    writeMode: parseEnumEnv(env, 'IG_WRITE_MODE', d.writeMode, WRITE_MODES),
    allowDestructive: parseBoolEnv(env, 'IG_ALLOW_DESTRUCTIVE', d.allowDestructive),
    transport: parseEnumEnv(env, 'IG_TRANSPORT', d.transport, TRANSPORTS),
    httpHost: parseHostEnv(env, 'IG_HTTP_HOST', d.httpHost),
    httpPort: parseIntEnv(env, 'IG_PORT', d.httpPort, { min: 1, max: 65535 }),
  };
}
