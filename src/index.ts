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
import { homedir } from 'node:os';
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { systemClock } from './core/clock.js';
import { loadSettings } from './core/settings.js';
import { loadProfiles } from './core/config.js';
import { createAuthProvider } from './core/auth.js';
import { createLogger } from './core/log.js';
import { createRedactor, registerSecret } from './core/redact.js';
import { createIgRequest } from './core/http.js';
import { refreshToken } from './core/refresh.js';
import { writeCredentials } from './core/config-write.js';
import { InstagramError, isInstagramError } from './core/types.js';
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
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `instagram-mcp-ai requires Node >= ${MIN_NODE_MAJOR} (running ${process.versions.node}).\n`,
    );
    process.exit(1);
  }
}

/** XDG config home, honoring `XDG_CONFIG_HOME` (POSIX) with the `~/.config` default. */
function xdgConfigHome(): string {
  const override = process.env.XDG_CONFIG_HOME?.trim();
  return override && override !== '' ? override : path.join(homedir(), '.config');
}

/**
 * Load env files with `dotenv` (`override: false`, so env passed by the MCP
 * client always wins). Resolution per §6: an explicit `IG_ENV_FILE`, else the
 * XDG path then the project `.env` (both loaded — XDG is canonical, project is
 * the fallback; already-set vars are never overwritten).
 */
function loadEnvFiles(): void {
  const explicit = process.env.IG_ENV_FILE?.trim();
  const candidates =
    explicit && explicit !== ''
      ? [explicit]
      : [path.join(xdgConfigHome(), SERVER_NAME, '.env'), path.resolve(process.cwd(), '.env')];
  for (const file of candidates) {
    if (existsSync(file)) dotenvConfig({ path: file, override: false });
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

/** Resolve the active (default) profile, or throw a clear auth error. */
function activeProfile(profiles: ResolvedProfile[], defaultName: string): ResolvedProfile {
  const found = profiles.find((p) => p.name === defaultName) ?? profiles[0];
  if (found === undefined) {
    throw new InstagramError(
      'No account profile is configured — run the `login` subcommand first.',
      {
        kind: 'auth',
      },
    );
  }
  return found;
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
    const refreshed = await refreshToken(makeRequest(profile), {
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
  log.info('tools registered', { count: registered.length, transport: settings.transport });

  if (settings.transport === 'http') {
    const httpToken = process.env.IG_HTTP_TOKEN?.trim();
    await startHttp(
      server,
      {
        host: settings.httpHost,
        port: settings.httpPort,
        token: httpToken !== undefined && httpToken !== '' ? httpToken : undefined,
      },
      log,
    );
  } else {
    await startStdio(server, log);
  }
}

main().catch((err: unknown) => {
  // Config/validation failures surface here before the server starts. Keep the
  // message clean (no stack, no token) — the redactor is not guaranteed yet.
  const message = isInstagramError(err)
    ? err.message
    : err instanceof Error
      ? err.message
      : String(err);
  process.stderr.write(`instagram-mcp-ai failed to start: ${message}\n`);
  process.exit(1);
});
