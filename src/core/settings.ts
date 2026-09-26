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
 *   IG_WRITE_JOURNAL    -> writeJournal      (default `<state home>/instagram-mcp-ai/writes.jsonl`)
 *
 * Note: the HTTP port env var is `IG_PORT` (not `IG_HTTP_PORT`) per §12 and
 * `.env.example`; it pairs with `IG_HTTP_HOST` for the HTTP-transport binding.
 * `IG_HTTP_HOST` is validated like every other knob: only loopback addresses are
 * accepted, because the HTTP transport binds loopback only (docs/security.md §3).
 */
import { isAbsolute, join } from 'node:path';

import { assertNotShellSpelling, expandHomeTilde, homeDirectory } from './home-path.js';
import { InstagramError, type LogLevel, type Settings } from './types.js';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const WRITE_MODES = ['preview', 'apply'] as const;
const TRANSPORTS = ['stdio', 'http'] as const;

// --- write journal ---------------------------------------------------------

/** Directory the server owns under the state home (mirrors the config-home layout). */
const SERVER_DIR = 'instagram-mcp-ai';
/** File name of the applied-write journal inside {@link SERVER_DIR}. */
const JOURNAL_FILE = 'writes.jsonl';
/** State base used when `XDG_STATE_HOME` is unset or blank (XDG default). */
const STATE_HOME_FALLBACK = ['.local', 'state'] as const;

/**
 * Resolve the applied-write journal path — the home of `IG_WRITE_JOURNAL`
 * (docs/architecture.md §12, default
 * `$XDG_STATE_HOME/instagram-mcp-ai/writes.jsonl`, falling back to
 * `~/.local/state/...` when `XDG_STATE_HOME` is unset).
 *
 * Reading, trimming and defaulting follow the same {@link read} convention as
 * every other knob, so a blank or whitespace-only value means "use the default"
 * exactly like `IG_LOG_LEVEL` or `IG_HTTP_HOST`.
 *
 * Module-private on purpose: {@link Settings.writeJournal} is the only surface
 * anyone needs. `mcp/write-mode.ts` reads the resolved field off its context
 * like every other knob, so no second entry point into this resolution exists
 * for a caller to drift away from.
 *
 * Unlike the enum/numeric/host knobs this one has no allowed-value check: every
 * string is a syntactically legal path, and the journal is a best-effort audit
 * sink (`mcp/write-mode.ts` warns instead of throwing when an append fails), so
 * an unusable path surfaces as a warning on the first applied write rather than
 * as a load-time refusal to start the server.
 *
 * The one exception is a spelling that is not a path at all, and it follows the
 * config-home rule (CC-CFG-60/61) for both variables: a leading `~` / `~/…`
 * (plus `~\…` on win32) is the home directory, and `~user`, `$VAR`, `${VAR}` or
 * `%VAR%` is refused with `kind: validation`. An MCP client's JSON `env` hands
 * such a value over unexpanded while a shell elsewhere expanded it, so honouring
 * it literally would put the audit trail of every applied write in a directory
 * named `~` or `$HOME` under the cwd — or, for `XDG_STATE_HOME`, silently in the
 * default state home — while the operator reads the file they actually named
 * (CC-CFG-64, CC-CFG-65). That refusal is a start-up failure by design: it
 * is the same mistake the config home refuses, and a warning on the first
 * applied write would arrive only after the write it failed to record.
 *
 * The fallback's home goes through `homeDirectory` (CC-CFG-75): `os.homedir()`
 * returns `$HOME` verbatim, so a blank or relative one made the default journal
 * relative to the cwd — the scattering the XDG rule below exists to prevent. It
 * is refused like the config home's (CC-CFG-69), and consulted only when neither
 * variable names the journal's place, so a bad home never stops an explicit one.
 *
 * @throws {InstagramError} `kind: 'validation'` for a shell-only spelling, or a
 *   home that is not absolute when the fallback needs it.
 */
function resolveWriteJournal(env: NodeJS.ProcessEnv): string {
  const platform = process.platform;
  const explicit = read(env, 'IG_WRITE_JOURNAL');
  if (explicit !== undefined) {
    // A relative value is left relative: the operator is naming one file, not
    // supplying a base directory (see the XDG note below).
    const expanded = expandHomeTilde(explicit, platform);
    assertNotShellSpelling(expanded, 'IG_WRITE_JOURNAL', 'for the write journal');
    return expanded;
  }
  // A RELATIVE `XDG_STATE_HOME` is dropped for the reason the XDG spec gives for
  // dropping it — those variables must hold absolute paths — and for a reason of
  // this server's own: the journal is the audit trail of every applied write, and
  // resolving it against the cwd would scatter it across whichever directories
  // the MCP client spawned the server from, so no single file answers "what did
  // this server post?" (CC-CFG-24). An explicit `IG_WRITE_JOURNAL` is left alone:
  // there the operator is naming one file, not supplying a base directory.
  //
  // Equivalent-mutant note: the `!== undefined` tests in this function cannot be
  // turned into truthiness checks and observed. {@link read} maps both "unset"
  // and "blank after trimming" to `undefined`, so `undefined` is the only falsy
  // value it can ever return. They are spelled out because they state the rule
  // that is meant: only an ABSENT (or unusable) state home falls back.
  const stateHome = read(env, 'XDG_STATE_HOME');
  let base: string | undefined;
  if (stateHome !== undefined) {
    const expanded = expandHomeTilde(stateHome, platform);
    if (isAbsolute(expanded)) base = expanded;
    // Equivalent-mutant note: checking `stateHome` instead of `expanded` on this
    // line cannot be observed. The two differ only when a `~` was expanded, and
    // an expanded `~` is the home joined with the rest — absolute, so it took
    // the branch above and never reaches this one. `expanded` is what is meant:
    // the refusal is about the value after the home's own `~` is spelled out.
    else assertNotShellSpelling(expanded, 'XDG_STATE_HOME', 'for the write journal');
  }
  base ??= join(homeDirectory(platform), ...STATE_HOME_FALLBACK);
  return join(base, SERVER_DIR, JOURNAL_FILE);
}

/**
 * Canonical defaults from docs/architecture.md §12.
 *
 * `writeJournal` is the one derived entry: it is resolved from an EMPTY env, so
 * it is the path you get with no `IG_WRITE_JOURNAL` and no `XDG_STATE_HOME`
 * override — the documented `~/.local/state/...` default, not whatever this
 * process happens to be configured with. {@link loadSettings} resolves it
 * against the real environment.
 *
 * It is a getter, resolved on each read rather than at import (CC-CFG-75): the
 * fallback refuses a home that is not absolute, and a refusal at import would
 * kill every module that imports this one — before the CLI could print why. A
 * getter on a frozen object still cannot be reassigned.
 */
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
  get writeJournal(): string {
    return resolveWriteJournal({});
  },
});

/** Truthy/falsy spellings accepted for boolean knobs (case-insensitive). */
const TRUE_TOKENS = new Set(['true', '1', 'yes', 'on']);
const FALSE_TOKENS = new Set(['false', '0', 'no', 'off']);

function fail(message: string): never {
  throw new InstagramError(message, { kind: 'validation' });
}

/**
 * Longest refused value a message quotes back. Every refusal in this file is
 * thrown by `loadSettings`, which the entry point calls before any secret is
 * registered for redaction, so only the token-shape backstop stands between a
 * quoted value and the `failed to start:` line on stderr — and a 32-hex app
 * secret matches no shape. The longest spelling any knob accepts is the
 * expanded IPv6 loopback `[0:0:0:0:0:0:0:1]` (17), so a typo of a real value
 * fits; a longer value is far more likely a credential pasted into the wrong
 * variable and is reported by length alone. Same cap and policy as the
 * auth-path refusal in `core/config.ts` (CC-CFG-47).
 */
const MAX_ECHOED_VALUE_LENGTH = 24;

/**
 * Control, format (bidi overrides, zero-width) and line/paragraph separators.
 * `read` trims only the ends, so an inner newline or ANSI escape would survive
 * into the message and let an env value forge a log line or repaint the
 * terminal; such a value is described, never quoted.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * How a refusal shows the offending value: quoted as typed while it is short and
 * printable (`"ture"` stays useful), otherwise described by its length only.
 */
function describeValue(raw: string): string {
  const size = `a value of ${raw.length} characters`;
  if (raw.length > MAX_ECHOED_VALUE_LENGTH) {
    return `${size} (not echoed — it may be a credential set under the wrong name)`;
  }
  if (UNPRINTABLE.test(raw)) {
    return `${size} (not echoed — it contains control or invisible characters)`;
  }
  return `"${raw}"`;
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
    fail(`${name} must be an integer, got ${describeValue(raw)}`);
  }
  // Equivalent-mutant note: `Number(raw)` and `parseInt(raw, 10)` agree on every
  // string that can reach this line. The anchored guard above has already
  // narrowed `raw` to an optional sign plus decimal digits and nothing else —
  // exactly the grammar `parseInt` consumes — and on that grammar they do not
  // diverge at all, not even past 2^53: `parseInt` rounds the mathematical value
  // to a double exactly as `Number` does, so `9007199254740993`, a 400-digit
  // literal (both `Infinity`) and `-0` all convert identically (measured).
  // `Number` stays because it refuses rather than truncates: were the guard ever
  // loosened, `parseInt` would read `5.9` as a clean 5 while `Number` yields 5.9
  // and is rejected on the next line.
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    fail(`${name} must be a safe integer, got ${describeValue(raw)}`);
  }
  if (value < range.min || value > range.max) {
    // The range refusal shows the number bare, as the operator SPELLED it — not
    // `${value}`, which re-renders the parsed double. Those differ more often
    // than they look: `String(-0)` is `"0"`, so `IG_PORT=-0` was reported as
    // `got 0`, a value that appears nowhere in the operator's file; and `+70000`
    // or `0070000` lost the sign or the padding they were typed with
    // (CC-CFG-57). The guard above has narrowed `raw` to a sign and ASCII
    // digits, so it is always printable; only the length cap of
    // {@link describeValue} can still apply, and it is honoured, because a
    // zero-padded value is the one spelling here that can pass the safe-integer
    // test at any length.
    const shown = raw.length > MAX_ECHOED_VALUE_LENGTH ? describeValue(raw) : raw;
    fail(`${name} must be in [${range.min}, ${range.max}], got ${shown}`);
  }
  return value;
}

function parseBoolEnv(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const raw = read(env, name);
  if (raw === undefined) return def;
  const token = raw.toLowerCase();
  // Equivalent-mutant note: consulting FALSE_TOKENS before TRUE_TOKENS cannot
  // change an answer, because the two sets are disjoint — no spelling appears in
  // both, so at most one branch can ever match and the order is not load-bearing.
  // It becomes load-bearing the moment a spelling is added to both sets: whichever
  // set is consulted first would silently decide, and the operator would get the
  // opposite of the other reading with no diagnostic to explain it.
  if (TRUE_TOKENS.has(token)) return true;
  if (FALSE_TOKENS.has(token)) return false;
  fail(`${name} must be a boolean (true/false), got ${describeValue(raw)}`);
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
  // Equivalent-mutant note: dropping the dot from `'127.'` is not separable
  // today. {@link isIpv4} has already capped the first octet at three digits and
  // 255, so every dotted quad whose text starts `127` starts with the octet
  // `127` — no host exists for which the two spellings disagree. The dot stays
  // because it is what the check means. Note WHICH of those two caps does that
  // work: not `\d{1,3}` but `Number(p) <= 255`, which refuses `1270` on its own,
  // so widening the digit cap alone would still not make `1270.0.0.1` reachable.
  // Loosen the RANGE test and the dot becomes the entire defence between this
  // and a prefix match on `1270.x.y.z` that would publish the whole write
  // surface.
  //
  // The prefix is emphatically NOT a substring test, and that one IS separable:
  // `10.127.0.1` is a routable LAN address containing `127.`, so `includes`
  // would bind the server where anyone on the network could reach it.
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
      `${name} must be one of the loopback spellings this transport accepts (127.0.0.0/8, ` +
        `localhost, ::1 or [::1]), got ${describeValue(raw)} — the HTTP transport binds ` +
        'loopback only; to expose it, put an authenticating reverse proxy in front of a loopback bind.',
    );
  }
  return raw;
}

/**
 * Enum knobs are case-insensitive, exactly like the boolean knobs
 * ({@link TRUE_TOKENS}): `IG_TRANSPORT=HTTP`, `Http` and `http` are one value.
 * The CANONICAL spelling (the lower-case entry of `allowed`) is what comes back,
 * so nothing downstream ever compares against the operator's casing. A refusal
 * echoes the value as typed — the operator is looking for it in their own file —
 * unless {@link describeValue} judges it too long or unprintable to quote.
 * (Case-sensitive until 2026-09-19: the two parsers spelled one convention two
 * ways, see docs/corner-cases.md CC-CFG-13.)
 */
function parseEnumEnv<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  def: T,
  allowed: readonly T[],
): T {
  const raw = read(env, name);
  if (raw === undefined) return def;
  const token = raw.toLowerCase();
  if ((allowed as readonly string[]).includes(token)) return token as T;
  fail(`${name} must be one of ${allowed.join(' | ')}, got ${describeValue(raw)}`);
}

/**
 * Every environment variable {@link loadSettings} reads — the settings half of
 * the recognised `IG_*` namespace. The composition root joins it with the halves
 * `core/config.ts` and `mcp/registry.ts` own to warn about an `IG_*` name nothing
 * reads (CC-CFG-13); no single module can see the whole set, so each owner
 * publishes its own. `test/core/settings.test.ts` pins this list against the
 * names `loadSettings` actually touches, so a knob added below without an entry
 * here fails the suite instead of being reported to the operator as a typo.
 */
export const SETTINGS_ENV_NAMES: readonly string[] = Object.freeze([
  'IG_MAX_CONCURRENT',
  'IG_MAX_ITEMS',
  'IG_REFRESH_AFTER_DAYS',
  'IG_TIMEOUT_MS',
  'IG_LOG_LEVEL',
  'IG_PRETTY_JSON',
  'IG_WRITE_MODE',
  'IG_ALLOW_DESTRUCTIVE',
  'IG_TRANSPORT',
  'IG_HTTP_HOST',
  'IG_PORT',
  'IG_WRITE_JOURNAL',
]);

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
    // Resolved against `env`, not defaulted from `d` — the fallback depends on
    // `XDG_STATE_HOME`/`$HOME`, which only this env knows.
    writeJournal: resolveWriteJournal(env),
  };
}
