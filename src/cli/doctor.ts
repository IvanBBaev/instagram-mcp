/**
 * `doctor` health-check CLI command (Layer: cli). A read-only, fully-injectable
 * diagnostic for the active account profile. It answers one question honestly:
 * "can this profile actually talk to the Instagram Graph API right now, and what
 * did the server resolve?" — without ever printing a secret.
 *
 * The command is written against injected seams (`req`, `profile`, `settings`,
 * clock via `nowMs`) so it is unit-testable with no network and no global state.
 * The composition root (`src/index.ts`) supplies the real per-profile request
 * seam and the resolved profile at wire time; this module owns none of that.
 *
 * What the report covers for the active profile (docs/operations.md §6):
 *   1. Configuration — profile, auth path, transport, write mode, destructive
 *      flag, applied-write journal, active packages, refresh window (no secrets).
 *   2. Token & authentication — Path B introspects via `debug_token` (validity,
 *      scopes, expiry); Path A has no `debug_token`, so validity is confirmed
 *      only by the reachability check (CC-AUTH-7).
 *   3. Reachability — one cheap `GET /{ig-id}` to prove the token works, then,
 *      when an account id is configured, an identity check that the answer
 *      names that account and not another one (CC-AUTH-6). Still one call.
 *   4. Meta app Development-vs-Live mode (not exposed by introspection; the line
 *      points the operator at the App Dashboard — dev-mode apps face lower limits).
 *
 * `exitCode` is 0 when healthy, non-zero when the token is invalid/expired, the
 * reachability GET fails, or the configured account id is proven to be another
 * account than the one the reachability GET answered for. Near-expiry is a
 * warning, never a failure. Every check catches its `InstagramError` and
 * renders it as a failure line rather than throwing out of `runDoctor`, and the
 * whole report is passed through the secret redactor as a final safety net.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  debugToken,
  getAccount,
  summarizeDataAccessExpiry,
  summarizeTokenExpiry,
} from '../api/account.js';
import { TOKEN_EXPIRES_AT_SUFFIX, envVarFor } from '../core/config.js';
import { createRedactor } from '../core/redact.js';
import { describeWireValue } from '../core/time.js';
import { InstagramError, isInstagramError } from '../core/types.js';
import { quoteUntrusted } from '../core/untrusted.js';
import type { AuthPath, IgRequestFn, Logger, ResolvedProfile, Settings } from '../core/types.js';
import { PACKAGE_PROFILES, READONLY_PROFILES } from '../mcp/registry.js';
import { classifyScopes } from './scopes.js';

/** Injected dependencies — everything the command needs, nothing global. */
export interface DoctorDeps {
  /** The active profile's network seam (auth already bound by the composition root). */
  req: IgRequestFn;
  /** The resolved profile the checks run against. */
  profile: ResolvedProfile;
  /** Resolved runtime settings (transport, write mode, refresh window, …). */
  settings: Settings;
  /** Optional structured logger; the report is the primary output, this is telemetry. */
  log?: Logger;
  /** Injectable clock for deterministic expiry math; defaults to `Date.now()`. */
  nowMs?: number;
  /** Environment read for the package-selection summary; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface DoctorResult {
  /** The rendered, secret-redacted health report (the CLI writes this verbatim). */
  report: string;
  /** 0 when healthy; non-zero when a token/reachability check failed. */
  exitCode: number;
}

/** Per-line severity — drives both the text label and the (TTY-only) color. */
type Status = 'ok' | 'warn' | 'fail' | 'info';

const STATUS_LABEL: Record<Status, string> = {
  ok: 'OK  ',
  warn: 'WARN',
  fail: 'FAIL',
  info: 'INFO',
};

/** ANSI SGR color codes, applied only when writing to a color-capable TTY. */
const STATUS_COLOR: Record<Status, string> = {
  ok: '32', // green
  warn: '33', // yellow
  fail: '31', // red
  info: '90', // bright black / grey
};

/** The ANSI escape (`ESC`, 0x1B) — built without a raw control byte in source. */
const ESC = String.fromCharCode(27);

/** Human label for an auth path, including the host the calls target. */
function pathLabel(path: AuthPath): string {
  return path === 'fb-login'
    ? 'Facebook Login for Business — graph.facebook.com'
    : 'Instagram Login — graph.instagram.com';
}

/** Color only when stdout is an interactive terminal and NO_COLOR is unset. */
function shouldUseColor(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

/** Render one status line, optionally wrapped in an ANSI color for a TTY. */
function formatLine(status: Status, text: string, useColor: boolean): string {
  const body = `  ${STATUS_LABEL[status]}  ${text}`;
  return useColor ? `${ESC}[${STATUS_COLOR[status]}m${body}${ESC}[0m` : body;
}

/**
 * Longest upstream-sourced fragment a report line quotes back, in code points.
 * Meta's `error_user_msg` runs to a couple of sentences, so a real message fits;
 * past that the text is noise at best and a screenful pushed over the verdict at
 * worst. Identifiers (account id, handle, app id, one scope name) are far
 * shorter — an Instagram handle is at most 30 characters — and get the tighter
 * cap, so a hostile value cannot bury the line it sits in (CC-DATA-89).
 */
const MAX_ECHOED_MESSAGE_LENGTH = 300;
const MAX_ECHOED_IDENTIFIER_LENGTH = 64;

/*
 * Every upstream fragment the report quotes goes through `quoteUntrusted`
 * (`core/untrusted.ts`): redacted whole, cut to one of the caps above, and every
 * control, format (bidi, zero-width) or line/paragraph separator rendered as a
 * visible escape. The report goes to a terminal, so an ESC in a username or a
 * Graph error message would otherwise repaint it (or forge a green `OK` line),
 * and a newline would forge a whole line (CC-DATA-89). The helper lived here
 * until the Graph error mapper needed the same rule (CC-DATA-91); this
 * report calls it without `wordSafe`, because its own redactor already sees
 * every secret before the cut.
 */

/**
 * Compact one-line description of a failed check. For an {@link InstagramError}
 * the discriminant and Graph codes are surfaced (docs/operations.md §3). The
 * message is untrusted text — a Graph `error.message` arrives verbatim, control
 * characters and all — so it goes through `quote`; the bracket is built from
 * numbers and this server's own `kind` and is appended AFTER the cut, so a long
 * message can never truncate the codes the docs lookup needs.
 */
function describeError(err: unknown, quote: (text: string) => string = (text) => text): string {
  if (isInstagramError(err)) {
    const parts = [`kind=${err.kind}`];
    if (err.code !== undefined) parts.push(`code=${err.code}`);
    if (err.subcode !== undefined) parts.push(`subcode=${err.subcode}`);
    if (err.status !== undefined) parts.push(`status=${err.status}`);
    return `${quote(err.message)} [${parts.join(', ')}]`;
  }
  if (err instanceof Error) return quote(err.message);
  return quote(String(err));
}

/**
 * The `debug_token` scope list, if it is one. `req` CASTS the payload, so
 * `scopes` can arrive as a string, an object, or a list holding `null`s. A
 * string used to reach `.join` and throw a TypeError whose engine text became
 * `Token introspection failed: info.scopes.join is not a function`, failing the
 * whole run over an ancillary field; a list with a non-string entry rendered it
 * as an empty scope name (CC-DATA-90). `undefined` means "not a scope list".
 */
function readScopes(scopes: unknown): string[] | undefined {
  if (!Array.isArray(scopes)) return undefined;
  return scopes.every((scope): scope is string => typeof scope === 'string') ? scopes : undefined;
}

/** The default profile name used when `IG_TOOL_PACKAGES` is unset. */
const DEFAULT_PACKAGE_PROFILE = 'core';

/**
 * Expand a package selection into the packages it actually resolves to. Derived
 * from {@link PACKAGE_PROFILES} rather than restated here — a hardcoded list
 * silently goes stale, and this is the diagnostic an operator reads to decide
 * whether the exposed surface includes write tools. An explicit comma list is
 * already its own expansion and is echoed unchanged.
 */
function expandSelection(selection: string, isDefault: boolean): string {
  const lower = selection.toLowerCase();
  const prefix = isDefault ? 'default: ' : '';
  if (lower === 'all') return `${selection} (${prefix}every package)`;
  if (!Object.hasOwn(PACKAGE_PROFILES, lower)) return selection;
  // The `?? []` arm is unreachable: the line above returns unless
  // `Object.hasOwn(PACKAGE_PROFILES, lower)`. It is here because
  // `noUncheckedIndexedAccess` types the lookup as possibly-undefined, and an
  // empty expansion is the safe reading if that guard is ever moved. The ignore
  // covers the arm, not the statement that holds it (CC-PROC-128).
  const profile =
    /* c8 ignore next */
    PACKAGE_PROFILES[lower] ?? [];
  const packages = profile.join(', ');
  const readonly = READONLY_PROFILES.includes(lower) ? '; forced read-only' : '';
  return `${selection} (${prefix}${packages}${readonly})`;
}

/**
 * Echo the configured package selection (config summary — never secret),
 * expanded so the report names the packages that are really registered.
 */
function describePackages(env: NodeJS.ProcessEnv, quote: (text: string) => string): string {
  const raw = env.IG_TOOL_PACKAGES?.trim();
  const deny = env.IG_PACKAGES_DENY?.trim();
  const readonly = env.IG_PACKAGES_READONLY?.trim();
  const isDefault = raw === undefined || raw === '';
  // All three values are echoed as the operator typed them, and `doctor` never
  // builds the registry, so nothing has validated them by the time they are
  // printed: an unknown selection falls through `expandSelection` verbatim. A
  // known profile name is printable and short, so quoting leaves it unchanged
  // and the lookup below still matches it (CC-DATA-94).
  const selection = isDefault ? DEFAULT_PACKAGE_PROFILE : quote(raw);

  let base = expandSelection(selection, isDefault);
  if (deny !== undefined && deny !== '') base = `${base} (deny: ${quote(deny)})`;
  if (readonly !== undefined && readonly !== '') base = `${base} (read-only: ${quote(readonly)})`;
  return base;
}

// --- applied-write journal --------------------------------------------------

/**
 * What a cheap look at the journal path found.
 *
 * `blocked` and `unknown` are separate on purpose: "I proved you cannot append
 * here" deserves a WARN, "I could not tell" does not. Collapsing them would
 * either cry wolf on an exotic filesystem or hide a real dead audit trail.
 */
type JournalState =
  | { kind: 'present'; bytes: number }
  | { kind: 'absent' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'unknown'; reason: string };

const KIB = 1024;
const MIB = 1024 * 1024;

/** Compact human size — the bytes come free with the existence check. */
function formatSize(bytes: number): string {
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < MIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

/** Outcome of walking up from the journal path to the first existing ancestor. */
type AnchorResult =
  { kind: 'dir'; dir: string } | { kind: 'notDir'; path: string } | { kind: 'none' };

/**
 * Walk up from the journal path to the first ancestor that exists.
 *
 * The write gate creates the journal's directory tree on the first applied write
 * (`mkdirSync({ recursive: true })`), so "is the directory missing?" is not the
 * question — "can the tree be created and appended to?" is, and that is decided
 * by the deepest ancestor that already exists. A `notDir` hit is reported rather
 * than walked past: with a regular file sitting where a directory has to go,
 * `mkdirSync` fails with `ENOTDIR` no matter how writable the directory above it
 * is, so continuing the walk would find a writable anchor and answer "fine".
 *
 * `resolve` first, so a relative `IG_WRITE_JOURNAL` is walked from the cwd the
 * append would use and the walk terminates at the filesystem root, not at `.`.
 */
function nearestExistingDir(path: string): AnchorResult {
  // Pin note, promoted out of an equivalence note on 2026-09-23. Dropping the
  // `dirname` — starting the walk at the journal path itself — used to survive
  // the whole suite, and the note used to argue it always would "from the one
  // call site there is": `probeJournal` reaches this only after `statSync` on
  // that exact path returned `undefined`, so the mutant's extra first iteration
  // stats a path already known to be absent.
  //
  // That argument holds only while the two statted spellings name the same file,
  // and they come apart, because `resolve` collapses `..` LEXICALLY while the
  // kernel expands symlinks first. With `<d>/a/link -> <d>/real` the kernel
  // reads `<d>/a/link/../writes.jsonl` as `<d>/writes.jsonl` (absent, so
  // `probeJournal` falls through to here) while `resolve` reads it as
  // `<d>/a/writes.jsonl`, which can perfectly well exist — and then the first
  // iteration stats an EXISTING regular file and answers `notDir`, turning a
  // journal that would be created without trouble into `WARN … NOT writable`.
  // Killed by "a journal path whose `..` crosses a symlink is diagnosed from its
  // parent, not itself".
  //
  // That test pins the STATUS and never the ancestor, because of a KNOWN
  // LIMITATION that stays deliberately unpinned: for such a path BOTH spellings
  // name an ancestor the append would not use — the real parent is `<d>`. The
  // consequence is confined to this one diagnostic line (the write gate hands
  // the raw path to `mkdirSync`/`appendFileSync`, which the kernel resolves
  // correctly), so the cure would be a `realpathSync` walk for a report line —
  // see docs/corner-cases.md CC-CFG-29. The `absent` branch prints no path at
  // all, which is what makes the status safe to pin while the ancestor is not.
  //
  // The `dirname` also makes the function's name true: handed a path that DOES
  // exist, the mutant answers with the path instead of an ancestor, and the next
  // caller to reach for a helper called `nearestExistingDir` would get a
  // directory that is not an ancestor of anything.
  let dir = dirname(resolve(path));
  for (;;) {
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (stat !== undefined) {
      return stat.isDirectory() ? { kind: 'dir', dir } : { kind: 'notDir', path: dir };
    }
    const parent = dirname(dir);
    /* c8 ignore start -- the walk cannot actually run out of parents: `dirname`
       is a fixed point at the filesystem root, and `statSync` on the root always
       resolves, so the loop returns above before `parent === dir` can hold. The
       guard stays because a `for(;;)` with no terminating case is a hang. */
    if (parent === dir) return { kind: 'none' };
    /* c8 ignore stop */
    dir = parent;
  }
}

/**
 * Inspect the journal path without touching it.
 *
 * Two hard rules, both load-bearing:
 *
 * 1. **Nothing is created.** `doctor` diagnoses; it does not mutate. Creating
 *    the file (or its 0700 directory) here would make the very next probe report
 *    a healthy journal that the write gate never actually wrote to, and would
 *    leave state behind on a machine the operator was only inspecting. Only
 *    `statSync` and `accessSync` are used — both pure reads.
 * 2. **Nothing throws.** Every call is inside the guard, and an unexpected
 *    failure degrades to `unknown` rather than propagating: the journal is a
 *    best-effort audit sink (`mcp/write-mode.ts` warns instead of throwing when
 *    an append fails), so it must not be able to break — let alone fail — a
 *    health check about token validity and API reachability.
 *
 * `accessSync` is an advisory answer (it can be wrong under ACLs, or on a
 * read-only mount that reports the mode bits of a writable directory), which is
 * exactly why a negative result is a WARN and never an exit-code failure.
 */
function probeJournal(path: string): JournalState {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat !== undefined) {
      if (!stat.isFile()) return { kind: 'blocked', reason: 'the path is not a regular file' };
      try {
        accessSync(path, constants.W_OK);
      } catch {
        return { kind: 'blocked', reason: 'no write permission on the file' };
      }
      return { kind: 'present', bytes: stat.size };
    }
    const anchor = nearestExistingDir(path);
    /* c8 ignore start -- unreachable for the same reason `nearestExistingDir`
       never returns `none`; kept so the exhaustive match over `AnchorResult`
       stays exhaustive rather than leaning on a cast. */
    if (anchor.kind === 'none') return { kind: 'blocked', reason: 'no existing parent directory' };
    /* c8 ignore stop */
    if (anchor.kind === 'notDir') {
      return { kind: 'blocked', reason: `${anchor.path} is not a directory` };
    }
    try {
      accessSync(anchor.dir, constants.W_OK);
    } catch {
      return { kind: 'blocked', reason: `no write permission on ${anchor.dir}` };
    }
    return { kind: 'absent' };
  } catch (err) {
    return { kind: 'unknown', reason: describeError(err) };
  }
}

/**
 * The `Write journal:` line — path, whether it will really receive anything, and
 * whether it can be appended to.
 *
 * The bare path alone is the misleading version of this diagnostic. The journal
 * is written **only** on an applied write, so in the default `preview` mode an
 * operator reading `Write journal: …/writes.jsonl` reasonably concludes their
 * audit trail is live, when in fact nothing has been or will be recorded until
 * something flips to apply. The mode clause states that in the same breath as
 * the path, so the line cannot be read the wrong way.
 *
 * Existence and writability are reported for the complementary reason: an
 * unwritable path is the one failure mode the write gate deliberately swallows
 * (it warns to the log and returns success, so the write happens un-audited),
 * which makes `doctor` the only place an operator can find out *before* trusting
 * the trail. It is a WARN in either write mode — an unwritable journal path is
 * never intentional, and in preview mode it is precisely the latent problem you
 * want to learn about before switching to apply — but never a failure: `doctor`
 * answers "can this profile talk to the Graph API", and a broken audit sink is
 * not an answer of "no" to that question.
 */
function describeJournal(
  settings: Settings,
  quotePath: (text: string) => string,
): { status: Status; text: string } {
  const state = probeJournal(settings.writeJournal);
  const applying = settings.writeMode === 'apply';
  const mode = applying
    ? 'apply mode — every applied write is appended here'
    : 'preview mode — nothing is recorded until a write is applied via IG_WRITE_MODE=apply or apply:true';

  let status: Status = 'info';
  let detail: string;
  switch (state.kind) {
    case 'present':
      detail = `file exists, ${formatSize(state.bytes)}`;
      break;
    case 'absent':
      detail = 'not created yet — it appears on the first applied write';
      break;
    case 'blocked':
      status = 'warn';
      detail = `NOT writable (${quotePath(state.reason)}) — applied writes ${
        applying ? 'will' : 'would'
      } NOT be audited`;
      break;
    case 'unknown':
    default:
      detail = `state could not be determined (${quotePath(state.reason)})`;
      break;
  }

  return {
    status,
    text: `Write journal:      ${quotePath(settings.writeJournal)} (${mode}; ${detail})`,
  };
}

/** Exact secret values scoped to this run so redaction never depends on global state. */
function collectSecrets(profile: ResolvedProfile): string[] {
  const secrets = [profile.accessToken];
  if (profile.appSecret !== undefined) secrets.push(profile.appSecret);
  return secrets;
}

/**
 * Run the health check for `deps.profile` and return a rendered report plus an
 * exit code. Never throws for an expected upstream failure — each check renders
 * its error as a failure line instead.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorResult> {
  const { req, profile, settings } = deps;
  const log = deps.log;
  const nowMs = deps.nowMs ?? Date.now();
  const env = deps.env ?? process.env;
  const useColor = shouldUseColor();
  const redact = createRedactor({ extraSecrets: collectSecrets(profile) });
  const redactText = (text: string): string => String(redact(text));
  const quoteMessage = (text: string): string =>
    quoteUntrusted(text, MAX_ECHOED_MESSAGE_LENGTH, redactText);
  const quoteIdentifier = (text: string): string =>
    quoteUntrusted(text, MAX_ECHOED_IDENTIFIER_LENGTH, redactText);
  // Operator-configured paths are escaped but never cut: a truncated path names
  // a different file, and the one thing the journal line exists to say is which
  // file. Their length is the operator's own, not an upstream's.
  const quotePath = (text: string): string =>
    quoteUntrusted(text, Number.POSITIVE_INFINITY, redactText);
  // The profile name is env-derived (the `<NAME>` of `IG_PROFILE_<NAME>_*`) and
  // the config parser accepts any character in it, ESC and newline included, so
  // every line that prints it — or an env var name built from it — quotes it
  // (CC-DATA-94).
  const profileName = quoteIdentifier(profile.name);
  const envName = (suffix: string): string => quoteMessage(envVarFor(profile.name, suffix));

  const lines: string[] = [];
  let healthy = true;

  const section = (title: string): void => {
    lines.push('', title);
  };
  const item = (status: Status, text: string): void => {
    lines.push(formatLine(status, text, useColor));
  };
  const markUnhealthy = (): void => {
    healthy = false;
  };

  /**
   * Emit one telemetry record, surviving a sink that fails.
   *
   * The logger is injected, and `core/log.ts` deliberately RETHROWS for a sink
   * it can make no sense of at all (CC-PROC-24 — an `ENOSPC` from a full disk, a
   * non-stream handed in by an embedder); it is only the gone-away sink it
   * latches and swallows. Failing loudly there is right for the server's request
   * path, where a logger nobody can write to is a misconfiguration worth
   * stopping on. It is wrong here: these two records sit OUTSIDE every check's
   * guard, so an unguarded throw from either one costs the entire report —
   * `runDoctor` propagates, the composition root's top-level catch prints
   * "failed to start", and an operator diagnosing a token learns nothing about
   * the token. `log` is documented as telemetry and the report as the primary
   * output; this keeps that ordering true when the SINK is the broken thing.
   *
   * Nothing is added to the report about the failure. A dead log sink is not an
   * answer to "can this profile reach the Graph API", and the honest place to
   * complain about a sink is the sink.
   */
  const telemetry = (emit: () => void): void => {
    try {
      emit();
    } catch {
      // Deliberately silent — see above.
    }
  };

  telemetry(() => {
    log?.debug('doctor: starting health check', {
      profile: profile.name,
      authPath: profile.authPath,
    });
  });

  /**
   * Render the token-expiry verdict; `undefined` expiry means "unknown".
   * `recordedIn` names the env var of a Path-A record (not live introspection);
   * the label carries it when a record was read, so an operator can tell a stale
   * record from a token fact. `recordUnverified` marks a bare record with no
   * token fingerprint (CC-AUTH-70).
   */
  const renderExpiry = (
    expiresAtSec?: number,
    recordedIn?: string,
    recordUnverified = false,
  ): void => {
    const summary = summarizeTokenExpiry({
      expiresAtSec,
      nowMs,
      refreshAfterDays: settings.refreshAfterDays,
      recordedIn,
      recordUnverified,
    });
    // `valid` and `never` carry a warning only for an unverified (bare, hand-set)
    // record (CC-AUTH-70); the verdict keeps its level, since the reachability
    // check below is the authority on the token, but the line says so.
    const note = summary.warning === undefined ? '' : ` ${summary.warning}`;
    const source =
      recordedIn === undefined || expiresAtSec === undefined
        ? undefined
        : `recorded in ${recordedIn}`;
    const label = source === undefined ? 'Token expiry' : `Token expiry (${source})`;
    switch (summary.state) {
      case 'valid':
        item(
          'ok',
          `${label}: valid — expires ${summary.expiresAt} (~${summary.daysLeft} day(s) left).${note}`,
        );
        break;
      case 'never':
        item('ok', `${label}: this token never expires.${note}`);
        break;
      case 'expiring_soon':
        // Near-expiry is a warning, not a failure (surface without failing).
        item('warn', `${label}: expiring_soon — ${summary.warning}`);
        break;
      case 'expired':
        // A recorded (Path A) expiry is file metadata, not a token fact: the
        // token may have been replaced by hand or passed in by the client. The
        // reachability check below is the authority there, so a lapsed record
        // warns instead of failing a run whose token still works.
        if (source !== undefined) {
          item('warn', `${label}: expired — ${summary.warning}`);
          break;
        }
        markUnhealthy();
        item('fail', `${label}: expired — ${summary.warning}`);
        break;
      case 'unknown':
      default:
        // The one expiry verdict that can quote the wire: an unrepresentable
        // `expires_at` is named in it via `describeWireValue`, whose
        // `JSON.stringify` escapes C0 controls but passes a bidi override or a
        // U+2028 straight through. Escaped, not capped — the warning's own
        // remediation text is longer than any sensible cap (CC-DATA-89).
        item(
          'info',
          `${label}: unknown — ${quoteUntrusted(String(summary.warning), Number.POSITIVE_INFINITY, redactText)}`,
        );
        break;
    }
  };

  // --- Header ---------------------------------------------------------------
  lines.push('Instagram MCP — doctor');
  lines.push(
    `Active profile: ${profileName} (${profile.authPath} — ${pathLabel(profile.authPath)})`,
  );

  // --- Configuration --------------------------------------------------------
  section('Configuration');
  item('info', `Profile:            ${profileName}`);
  item('info', `Auth path:          ${profile.authPath} (${pathLabel(profile.authPath)})`);
  item('info', `Transport:          ${settings.transport}`);
  item('info', `Write mode:         ${settings.writeMode}`);
  item('info', `Allow destructive:  ${settings.allowDestructive}`);
  const journal = describeJournal(settings, quotePath);
  item(journal.status, journal.text);
  item('info', `Active packages:    ${describePackages(env, quoteMessage)}`);
  item('info', `Refresh after:      ${settings.refreshAfterDays} day(s)`);

  // --- Token & authentication ----------------------------------------------
  section('Token & authentication');
  let appId = profile.appId;
  if (profile.authPath === 'fb-login') {
    // Path B: graph.facebook.com exposes `debug_token` — introspect it.
    try {
      const info = await debugToken(req, { inputToken: profile.accessToken });
      // This was `info.appId ?? appId` until 2026-09-23, under a note arguing
      // that the two operators differ only on an empty-string id and that no
      // profile can carry one because the config parser's `clean()` maps a blank
      // field to `undefined`. That reasoning named the wrong operand: `clean()`
      // governs `profile.appId`, which is the FALLBACK side, while the side `??`
      // inspects is `info.appId` — the raw `debug_token` wire value, copied
      // through untouched by `src/api/account.ts` and cleaned by nobody. A
      // response reporting `app_id: ""` therefore overwrote the id the operator
      // configured and printed `(App ID )`, turning the one line that says WHICH
      // dashboard to open into noise. A blank wire id is no id, and is now read
      // as one. Pinned by "a blank app id on the wire does not erase the
      // configured one".
      appId = info.appId !== undefined && info.appId !== '' ? info.appId : appId;
      if (info.isValid === false) {
        markUnhealthy();
        item(
          'fail',
          'Token introspection reports the token is INVALID (is_valid=false) — run the `login` CLI to obtain a new token.',
        );
      } else if (info.isValid === true) {
        item('ok', 'Token is valid (Path B introspection via debug_token).');
      } else {
        // No `is_valid` on the wire is no verdict either way: not a failure
        // (Meta omits fields, CC-DATA-2), but not an OK line either — the
        // reachability check below is then the only evidence the token works.
        item(
          'info',
          'Token validity: not reported by debug_token (no is_valid field) — ' +
            'see the reachability check below.',
        );
      }
      const scopes = readScopes(info.scopes);
      if (info.scopes !== undefined && scopes === undefined) {
        // An unreadable grant is not a failed token: validity and reachability
        // are decided elsewhere. It is a WARN because the drift check below
        // cannot run, and saying nothing would read as "no drift".
        item(
          'warn',
          `Granted scopes: unreadable — debug_token sent ${quoteMessage(describeWireValue(info.scopes))}, not a list of scope names; the scope grant cannot be checked.`,
        );
      } else if (scopes !== undefined && scopes.length > 0) {
        item('ok', `Granted scopes: ${scopes.map(quoteIdentifier).join(', ')}`);
        // Listing the grant is not the same as reviewing it, and the operator
        // cannot review it without the expected set in front of them — which is
        // why this compares rather than prints. Both directions warn instead of
        // failing: a deliberately trimmed grant (`login --scopes=<subset>` for a
        // read-only deployment) is a legitimate setup, and flipping doctor's exit
        // code on it would make the check something operators route around.
        const drift = classifyScopes(profile.authPath, scopes);
        if (drift.missing.length > 0) {
          item(
            'warn',
            `Missing scopes: ${drift.missing.join(', ')} — tools needing them will fail with a permission error; re-run \`login\` (or pass \`--scopes\`) to add them.`,
          );
        }
        if (drift.extra.length > 0) {
          item(
            'warn',
            `Over-granted scopes: ${drift.extra.map(quoteIdentifier).join(', ')} — this server never uses them; re-run \`login\` to mint a token without them.`,
          );
        }
        if (drift.missing.length === 0 && drift.extra.length === 0) {
          item('ok', 'Scope grant matches exactly what this server needs.');
        }
      } else {
        item('info', 'Granted scopes: (none reported by debug_token)');
      }
      renderExpiry(info.expiresAtSec);
      // The data-access window expires independently of the token (CC-AUTH-12),
      // and doctor used to say nothing about it: a valid token with a closed
      // window printed only OK lines here (CC-AUTH-77). A closed window is a
      // WARN, not a FAIL, for the reason a lapsed Path-A record is: the
      // reachability check below is the authority on whether data reads work,
      // and it fails on its own when they do not. No window (`0` or omitted)
      // prints nothing, exactly as `token_status` publishes nothing.
      const dataAccess = summarizeDataAccessExpiry({
        dataAccessExpiresAtSec: info.dataAccessExpiresAtSec,
        nowMs,
      });
      if (dataAccess.state === 'open') {
        item('ok', `Data access expiry: open until ${dataAccess.expiresAt}.`);
      } else if (dataAccess.state === 'expired') {
        item('warn', `Data access expiry: expired — ${dataAccess.warning}`);
      } else if (dataAccess.state === 'unknown') {
        // The warning quotes the wire value through `describeWireValue`, which
        // already escapes and bounds it (CC-DATA-101); the rest is literal text,
        // and the whole report passes the redactor below.
        item('info', `Data access expiry: unknown — ${dataAccess.warning}`);
      }
    } catch (err) {
      markUnhealthy();
      item('fail', `Token introspection failed: ${describeError(err, quoteMessage)}`);
    }
  } else {
    // Path A: graph.instagram.com has no `debug_token` (CC-AUTH-7) — be honest,
    // and let the reachability check below be the real validity signal.
    item(
      'info',
      'Path A (ig-login): token introspection via `debug_token` is unavailable; token validity is confirmed only by the reachability check below.',
    );
    // The expiry `login`/`refresh` recorded is the only one Path A has; without
    // a usable record it is honestly unknown.
    // The env var name carries the profile name, so it is quoted before it
    // reaches the label and the expiry warning, which print it verbatim.
    renderExpiry(
      profile.tokenExpiresAtSec,
      envName(TOKEN_EXPIRES_AT_SUFFIX),
      profile.tokenExpiryUnverified === true,
    );
  }

  // --- Reachability ---------------------------------------------------------
  section('Reachability');
  // `??`, not `||`: a blank configured id must stay blank (the check then
  // fails upstream and the line below prints `GET /`) rather than silently
  // probing the token owner's `/me` and reporting it as reachable. Pinned by
  // test, as in `instagram_get_account` and `instagram_list_media`.
  const igId = profile.accountId ?? 'me';
  // The configured id is env-derived, so it is quoted wherever it is printed
  // (CC-DATA-94).
  const igIdText = quoteIdentifier(igId);
  let resolvedId: string | undefined;
  try {
    const account = await getAccount(req, { igId });
    // The id is what "reachable" means here: an answer that names no account
    // proves the host answered, not that this profile can address its account.
    // The body is cast, so `{}` — or an id that is `null`, a number, blank —
    // arrives typed `string`, and printed `id=undefined` under an OK line and a
    // passing summary (CC-DATA-88). It fails even with an account id
    // configured, although `instagram_get_account` falls back to that id: the
    // tool's job is to publish a profile, doctor's is to prove the Graph API
    // resolved one, and an answer without an id is no such proof.
    const id: unknown = account.id;
    if (typeof id !== 'string' || id === '') {
      throw new InstagramError(
        `the answer carries no usable account id (${
          id === undefined ? 'no id field' : `id ${describeWireValue(id)}`
        }), so it does not prove this profile can address its account; retry, and if it persists check the account id and the token`,
        { kind: 'upstream' },
      );
    }
    // `!== ''` as well as `!== undefined`, spelled the way the `debug_token`
    // app-id fallback above is spelled. `api/account.ts` maps the wire response
    // field for field and cleans nothing — that layer is a faithful mapping on
    // purpose, and the tools layer depends on it, because a CLEARED text field
    // must not read to a model as an undisclosed one. This is the display layer
    // and the audience is a human reading one line: whatever produces a blank
    // handle, a presence test alone renders ` (@)`, which is the phantom clause
    // this file already guards against on the app-id side, reached by a
    // different route. The clause exists to name a handle; there is none to name.
    const who =
      account.username !== undefined && account.username !== ''
        ? ` (@${quoteIdentifier(String(account.username))})`
        : '';
    resolvedId = id;
    item(
      'ok',
      `Reachability OK — GET /${igIdText} resolved account id=${quoteIdentifier(id)}${who}.`,
    );
  } catch (err) {
    markUnhealthy();
    item('fail', `Reachability FAILED — GET /${igIdText}: ${describeError(err, quoteMessage)}`);
  }

  // --- Account identity (CC-AUTH-6, CC-AUTH-63) ----------------------------
  // A reachable id is not the same as the RIGHT id. Every tool addresses the
  // configured account id, so an answer for another node than the one asked
  // for can mean each tool acts on an account other than the configured one —
  // while the reachability line above reads OK.
  //
  // It is a WARN, not a FAIL, because the evidence is not conclusive: on Path A
  // Instagram Login knows an account by two ids (the app-scoped `id` and the
  // professional-account `user_id`), and whether `GET /{id}` echoes the id it
  // was asked for has not been verified live for both spellings. A FAIL would
  // turn a working profile red on a false alarm; a WARN names both ids and
  // leaves the verdict to the operator.
  //
  // The reachability answer is the only evidence consulted, on both paths. On
  // Path B `me` is the Facebook user or Page behind the token, never the IG
  // account, so it cannot name the owner. Naming the owner on Path A would take
  // a second `GET /me`, and the reachability check is pinned to a single Graph
  // call (`test/index.test.ts` counts them).
  //
  // Nothing to compare when no id is configured (calls then address `me`, the
  // token's own account by definition) or when reachability failed (nothing
  // was resolved, and the run has already failed).
  if (
    profile.accountId !== undefined &&
    resolvedId !== undefined &&
    resolvedId !== profile.accountId
  ) {
    const idVar = envName('ACCOUNT_ID');
    item(
      'warn',
      `Account identity MISMATCH — ${idVar} is ${igIdText}, but GET /${igIdText} answered for account ${quoteIdentifier(resolvedId)}; every tool addresses ${igIdText}. If that is not the account you mean to operate, set ${idVar} to the id of the account the token belongs to.`,
    );
  }

  // --- Meta app mode (Development vs Live) -----------------------------------
  section('Meta app mode (Development vs Live)');
  item(
    'info',
    `Meta app mode is not exposed by token introspection — verify Development vs Live in the Meta App Dashboard${
      appId !== undefined ? ` (App ID ${quoteIdentifier(String(appId))})` : ''
    }. Development-mode apps may face lower rate limits and can only act on app roles/testers.`,
  );

  // --- Summary --------------------------------------------------------------
  section('Summary');
  const exitCode = healthy ? 0 : 1;
  if (healthy) {
    item('ok', 'Health check passed — the active profile can reach the Instagram Graph API.');
  } else {
    item(
      'fail',
      'Health check FAILED — see the FAIL line(s) above; fix the reported issue and re-run `doctor`.',
    );
  }

  telemetry(() => {
    log?.info('doctor: completed', { profile: profile.name, healthy, exitCode });
  });

  // Final safety net: mask any secret that could have slipped into a message
  // (e.g. an upstream error string). The report is built to never embed tokens,
  // but redaction here guarantees it regardless of upstream payloads (F-4).
  const report = redactText(lines.join('\n'));
  return { report, exitCode };
}
