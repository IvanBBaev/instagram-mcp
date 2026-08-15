/**
 * Entry point & composition root (docs/architecture.md §9). This is the ONE
 * place that wires the concrete infrastructure together — everything below the
 * entry depends on interfaces, so this file is where `core/auth` + `core/http`
 * meet the registry and a transport.
 *
 * Responsibilities:
 *   1. Node version guard (the runtime uses Node ≥ 22 APIs, e.g. `AbortSignal.any`).
 *   2. Env-file resolution + `dotenv` load with `override: false` (client env wins).
 *   3. Build settings, profiles, the secret redactor, and the stderr logger.
 *   4. Construct the `McpServer`, register the tool surface (packages resolved
 *      from env, D1 capability-filtered per the active profile), and inject the
 *      per-profile network seam `createIgRequest(createAuthProvider(profile))`.
 *   5. Route CLI subcommands, else start the configured transport.
 *
 * stdout is the stdio protocol channel: nothing here may write to it. All
 * diagnostics go through the logger (stderr); `no-console` is lint-enforced.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { systemClock } from './core/clock.js';
import { loadSettings } from './core/settings.js';
import { loadProfiles, resolveProfile } from './core/config.js';
import { createAuthProvider } from './core/auth.js';
import { createLogger } from './core/log.js';
import { createRedactor, registerSecret } from './core/redact.js';
import { createIgRequest } from './core/http.js';
import { refreshToken } from './core/refresh.js';
import { resolveConfigHome, writeCredentials } from './core/config-write.js';
import { isInstagramError } from './core/types.js';
import type { ResolvedProfile } from './core/types.js';
import { registerTools } from './mcp/registry.js';
import { startHttp, startStdio } from './mcp/transport.js';
import { runLogin } from './cli/login.js';
import { runDoctor } from './cli/doctor.js';
import { allTools } from './tools/index.js';

/** Mirrors package.json — the identity advertised to MCP clients. */
const SERVER_NAME = 'instagram-mcp-ai';
const SERVER_VERSION = '0.0.1';

const MIN_NODE_MAJOR = 22;

/** Fail fast on an unsupported runtime before any Node-22-only API is touched. */
function assertNodeVersion(): void {
  const major = Number(process.versions.node.split('.')[0]);
  // Equivalent-mutant note: dropping `Number.isFinite(major)` changes no
  // outcome — `NaN < MIN_NODE_MAJOR` is already false, so a version string we
  // cannot parse is tolerated either way. The guard stays because "tolerate what
  // we cannot parse" is the deliberate rule here, and the bare comparison
  // expresses it only by accident.
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `instagram-mcp-ai requires Node >= ${MIN_NODE_MAJOR} (running ${process.versions.node}).\n`,
    );
    process.exit(1);
  }
}

/**
 * Load env files with `dotenv` (`override: false`, so env passed by the MCP
 * client always wins). Resolution per §6: an explicit `IG_ENV_FILE`, else the
 * config-home path then the project `.env` (both loaded — the config home is
 * canonical, project is the fallback; already-set vars are never overwritten).
 *
 * The config home comes from `core/config-write.ts` — the same resolver the
 * write path uses (`$XDG_CONFIG_HOME`/`~/.config` on POSIX, `%APPDATA%` on
 * Windows). Resolving it here independently is how the read and write sides
 * drift apart: an XDG-only rule sends a Windows server looking in
 * `%USERPROFILE%\.config\…` for a file `login` wrote to `%APPDATA%\…`.
 */
function loadEnvFiles(): void {
  const explicit = process.env.IG_ENV_FILE?.trim();
  const candidates =
    explicit && explicit !== ''
      ? [explicit]
      : [path.join(resolveConfigHome(), SERVER_NAME, '.env'), path.resolve(process.cwd(), '.env')];
  for (const file of candidates) {
    // `quiet: true` is load-bearing, not cosmetic. From dotenv 17 a successful
    // load prints a banner ("injected env (N) from …" plus a product tip) to
    // STDOUT. On the stdio transport stdout carries JSON-RPC and nothing else,
    // so that banner is a framing error the client reports as a parse failure —
    // and it leaks the config-home path into the stream on the way. dotenv 16
    // ignores the option, so this is correct under both. Dropping it is caught
    // by the "every stdout byte is JSON-RPC" test in `test/index.test.ts`.
    //
    // Equivalent-mutant note: the `existsSync` guard is an optimisation, not a
    // behaviour — dotenv 17 given a missing path returns an error object, writes
    // nothing to either stream (with `quiet: true`) and throws nothing, so
    // calling it unconditionally is indistinguishable from skipping. It stays
    // because "load the files that exist" is the documented rule, and because it
    // is what keeps a future dotenv's missing-file diagnostics off stdout.
    if (existsSync(file)) dotenvConfig({ path: file, override: false, quiet: true });
  }
}

/** Register every secret value so the redactor masks it in all log output. */
function registerProfileSecrets(profiles: ResolvedProfile[]): void {
  for (const p of profiles) {
    registerSecret(p.accessToken);
    if (p.appSecret !== undefined) registerSecret(p.appSecret);
  }
  const httpToken = process.env.IG_HTTP_TOKEN?.trim();
  if (httpToken !== undefined && httpToken !== '') registerSecret(httpToken);
}

/**
 * Resolve the profile named by `IG_ACTIVE_PROFILE` (or the default profile when
 * it is unset or blank).
 *
 * Deliberately the SAME resolver the tool path uses, so an explicitly named but
 * unknown profile fails here exactly as it fails on a tool call — naming the bad
 * value and listing the configured profiles. Falling back to the first profile
 * instead is what let a typo in `IG_ACTIVE_PROFILE` make `doctor` report a
 * healthy `default` account while every tool call rejected the typo'd name.
 *
 * @throws InstagramError `kind: 'validation'` — unknown profile name.
 */
function activeProfile(profiles: ResolvedProfile[], defaultName: string): ResolvedProfile {
  return resolveProfile(profiles, defaultName);
}

/** Human-readable, token-free expiry line for the `refresh` success message. */
function expiryLabel(expiresAtSec: number | undefined): string {
  if (expiresAtSec === undefined) return 'unknown';
  if (expiresAtSec === 0) return 'never';
  return new Date(expiresAtSec * 1000).toISOString();
}

async function main(): Promise<void> {
  assertNodeVersion();
  loadEnvFiles();

  const settings = loadSettings();
  const clock = systemClock;
  const subcommand = process.argv[2];

  // `login` runs before profile resolution — it is what an operator runs when
  // there is no valid credential yet, so it must not require a loadable profile.
  if (subcommand === 'login') {
    // `slice(3)` drops the subcommand itself. Equivalent-mutant note: `slice(2)`
    // hands `'login'` to the flag parser as a bare positional, where it is read
    // as a possible auth-path name — and `normalizePath('login')` is `undefined`,
    // so nothing changes today. The correct slice stays: the parser's positional
    // rule is first-wins, so the day `login` grows a real positional argument,
    // `slice(2)` would silently consume it.
    process.exit(await runLogin(process.argv.slice(3)));
  }

  // Build the logger with redaction wired in: register token/secret values,
  // then hand the redactor to the logger so every field is scrubbed at the sink.
  const { profiles, defaultName } = loadProfiles();
  registerProfileSecrets(profiles);
  const log = createLogger({
    level: settings.logLevel,
    clock,
    redact: createRedactor(),
  });

  // The one network seam, resolved per profile at call time. This is the join
  // point the registry stays decoupled from, and the CLI diagnostics reuse.
  const makeRequest = (profile: ResolvedProfile) =>
    createIgRequest({
      auth: createAuthProvider(profile),
      settings,
      clock,
      log,
      onUsage: (host, usage) => log.debug('graph usage', { host, maxPct: usage.maxPct }),
    });

  // `doctor` / `refresh` operate on the resolved active profile via that seam,
  // then exit — they never start a transport.
  if (subcommand === 'doctor') {
    const profile = activeProfile(profiles, defaultName);
    const { report, exitCode } = await runDoctor({
      req: makeRequest(profile),
      profile,
      settings,
      log,
      nowMs: clock.now(),
    });
    process.stdout.write(`${report}\n`);
    process.exit(exitCode);
  }

  if (subcommand === 'refresh') {
    const profile = activeProfile(profiles, defaultName);
    // No Graph seam here on purpose: the token-exchange endpoints authenticate
    // themselves, and the seam would append `access_token`/`appsecret_proof` on
    // top of that — see the transport note in core/refresh.ts.
    const refreshed = await refreshToken({
      authPath: profile.authPath,
      accessToken: profile.accessToken,
      appId: profile.appId,
      appSecret: profile.appSecret,
      nowMs: clock.now(),
    });
    const written = await writeCredentials(profile.name, {
      accessToken: refreshed.accessToken,
      authPath: profile.authPath,
      accountId: profile.accountId,
      appId: profile.appId,
      appSecret: profile.appSecret,
      expiresAtSec: refreshed.expiresAtSec,
    });
    process.stderr.write(
      `Refreshed ${profile.authPath} token for profile '${profile.name}' -> ${written.path} ` +
        `(expires: ${expiryLabel(refreshed.expiresAtSec)}).\n`,
    );
    process.exit(0);
  }

  // Build one fully-registered server instance. stdio keeps this single instance
  // for the process lifetime; the HTTP transport is stateless and the SDK
  // requires a fresh server + transport PER REQUEST (see mcp/transport.ts), so
  // it gets this as a factory instead.
  const buildServer = (): { server: McpServer; registered: string[] } => {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    const { registered } = registerTools({
      server,
      tools: allTools,
      profiles,
      defaultProfileName: defaultName,
      settings,
      clock,
      log,
      makeRequest,
    });
    return { server, registered };
  };

  // Built once up front on BOTH transports: registration is where a bad package
  // selection or an unknown `IG_ACTIVE_PROFILE` is rejected, and that must fail
  // the start — not the first request that happens to arrive.
  const built = buildServer();
  log.info('tools registered', { count: built.registered.length, transport: settings.transport });

  if (settings.transport === 'http') {
    const httpToken = process.env.IG_HTTP_TOKEN?.trim();
    await startHttp(
      () => buildServer().server,
      {
        host: settings.httpHost,
        port: settings.httpPort,
        token: httpToken !== undefined && httpToken !== '' ? httpToken : undefined,
      },
      log,
    );
  } else {
    await startStdio(built.server, log);
  }
}

main().catch((err: unknown) => {
  // Config/validation failures surface here before the server starts. Keep the
  // message clean (no stack, no token) — the redactor is not guaranteed yet.
  /* c8 ignore start -- the `String(err)` arm is defensive only: everything the
     startup path can reject with is an `InstagramError` (config/validation) or a
     plain `Error` (the runtime guard, the transport). It exists because `catch`
     is typed `unknown` and a dependency throwing a bare value must still print. */
  const message = isInstagramError(err) || err instanceof Error ? err.message : String(err);
  /* c8 ignore stop */
  process.stderr.write(`instagram-mcp-ai failed to start: ${message}\n`);
  process.exit(1);
});
