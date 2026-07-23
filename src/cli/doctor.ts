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
 *      flag, active packages, refresh window (no secrets).
 *   2. Token & authentication — Path B introspects via `debug_token` (validity,
 *      scopes, expiry); Path A has no `debug_token`, so validity is confirmed
 *      only by the reachability check (CC-AUTH-7).
 *   3. Reachability — one cheap `GET /{ig-id}` to prove the token works.
 *   4. Meta app Development-vs-Live mode (not exposed by introspection; the line
 *      points the operator at the App Dashboard — dev-mode apps face lower limits).
 *
 * `exitCode` is 0 when healthy, non-zero when the token is invalid/expired or the
 * reachability GET fails. Near-expiry is a warning, never a failure. Every check
 * catches its `InstagramError` and renders it as a failure line rather than
 * throwing out of `runDoctor`, and the whole report is passed through the secret
 * redactor as a final safety net.
 */
import { debugToken, getAccount, summarizeTokenExpiry } from '../api/account.js';
import { createRedactor } from '../core/redact.js';
import { isInstagramError } from '../core/types.js';
import type { AuthPath, IgRequestFn, Logger, ResolvedProfile, Settings } from '../core/types.js';

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
 * Compact one-line description of a failed check. For an {@link InstagramError}
 * the discriminant and Graph codes are surfaced (docs/operations.md §3); the
 * message may still contain untrusted text, so the caller redacts the report.
 */
function describeError(err: unknown): string {
  if (isInstagramError(err)) {
    const parts = [`kind=${err.kind}`];
    if (err.code !== undefined) parts.push(`code=${err.code}`);
    if (err.subcode !== undefined) parts.push(`subcode=${err.subcode}`);
    if (err.status !== undefined) parts.push(`status=${err.status}`);
    return `${err.message} [${parts.join(', ')}]`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Echo the configured package selection (config summary — never secret). */
function describePackages(): string {
  const raw = process.env.IG_TOOL_PACKAGES?.trim();
  const deny = process.env.IG_PACKAGES_DENY?.trim();
  const base = raw !== undefined && raw !== '' ? raw : 'core (default: account, insights, media)';
  return deny !== undefined && deny !== '' ? `${base} (deny: ${deny})` : base;
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
  const useColor = shouldUseColor();

  log?.debug('doctor: starting health check', {
    profile: profile.name,
    authPath: profile.authPath,
  });

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

  /** Render the token-expiry verdict; `undefined` expiry means "unknown" (Path A). */
  const renderExpiry = (expiresAtSec?: number): void => {
    const summary = summarizeTokenExpiry({
      expiresAtSec,
      nowMs,
      refreshAfterDays: settings.refreshAfterDays,
    });
    switch (summary.state) {
      case 'valid':
        item(
          'ok',
          `Token expiry: valid — expires ${summary.expiresAt} (~${summary.daysLeft} day(s) left).`,
        );
        break;
      case 'never':
        item('ok', 'Token expiry: this token never expires.');
        break;
      case 'expiring_soon':
        // Near-expiry is a warning, not a failure (surface without failing).
        item('warn', `Token expiry: expiring_soon — ${summary.warning}`);
        break;
      case 'expired':
        markUnhealthy();
        item('fail', `Token expiry: expired — ${summary.warning}`);
        break;
      case 'unknown':
      default:
        item('info', `Token expiry: unknown — ${summary.warning}`);
        break;
    }
  };

  // --- Header ---------------------------------------------------------------
  lines.push('Instagram MCP — doctor');
  lines.push(
    `Active profile: ${profile.name} (${profile.authPath} — ${pathLabel(profile.authPath)})`,
  );

  // --- Configuration --------------------------------------------------------
  section('Configuration');
  item('info', `Profile:            ${profile.name}`);
  item('info', `Auth path:          ${profile.authPath} (${pathLabel(profile.authPath)})`);
  item('info', `Transport:          ${settings.transport}`);
  item('info', `Write mode:         ${settings.writeMode}`);
  item('info', `Allow destructive:  ${settings.allowDestructive}`);
  item('info', `Active packages:    ${describePackages()}`);
  item('info', `Refresh after:      ${settings.refreshAfterDays} day(s)`);

  // --- Token & authentication ----------------------------------------------
  section('Token & authentication');
  let appId = profile.appId;
  if (profile.authPath === 'fb-login') {
    // Path B: graph.facebook.com exposes `debug_token` — introspect it.
    try {
      const info = await debugToken(req, { inputToken: profile.accessToken });
      appId = info.appId ?? appId;
      if (info.isValid === false) {
        markUnhealthy();
        item(
          'fail',
          'Token introspection reports the token is INVALID (is_valid=false) — run the `login` CLI to obtain a new token.',
        );
      } else {
        item('ok', 'Token is valid (Path B introspection via debug_token).');
      }
      if (info.scopes !== undefined && info.scopes.length > 0) {
        item('ok', `Granted scopes: ${info.scopes.join(', ')}`);
      } else {
        item('info', 'Granted scopes: (none reported by debug_token)');
      }
      renderExpiry(info.expiresAtSec);
    } catch (err) {
      markUnhealthy();
      item('fail', `Token introspection failed: ${describeError(err)}`);
    }
  } else {
    // Path A: graph.instagram.com has no `debug_token` (CC-AUTH-7) — be honest,
    // and let the reachability check below be the real validity signal.
    item(
      'info',
      'Path A (ig-login): token introspection via `debug_token` is unavailable; token validity is confirmed only by the reachability check below.',
    );
    renderExpiry(undefined);
  }

  // --- Reachability ---------------------------------------------------------
  section('Reachability');
  const igId = profile.accountId ?? 'me';
  try {
    const account = await getAccount(req, { igId });
    const who = account.username !== undefined ? ` (@${account.username})` : '';
    item('ok', `Reachability OK — GET /${igId} resolved account id=${account.id}${who}.`);
  } catch (err) {
    markUnhealthy();
    item('fail', `Reachability FAILED — GET /${igId}: ${describeError(err)}`);
  }

  // --- Meta app mode (Development vs Live) -----------------------------------
  section('Meta app mode (Development vs Live)');
  item(
    'info',
    `Meta app mode is not exposed by token introspection — verify Development vs Live in the Meta App Dashboard${
      appId !== undefined ? ` (App ID ${appId})` : ''
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

  log?.info('doctor: completed', { profile: profile.name, healthy, exitCode });

  // Final safety net: mask any secret that could have slipped into a message
  // (e.g. an upstream error string). The report is built to never embed tokens,
  // but redaction here guarantees it regardless of upstream payloads (F-4).
  const redact = createRedactor({ extraSecrets: collectSecrets(profile) });
  const report = String(redact(lines.join('\n')));
  return { report, exitCode };
}
