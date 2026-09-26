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
import { expiryLabel } from './core/time.js';
import { SETTINGS_ENV_NAMES, loadSettings } from './core/settings.js';
import {
  isProfileEnvName,
  loadProfiles,
  resolveProfile,
  strayExpiryKeys,
  unsetPlaceholderKeys,
} from './core/config.js';
import { createAuthProvider } from './core/auth.js';
import { createLogger } from './core/log.js';
import { createRedactor, registerSecret } from './core/redact.js';
import { createIgRequest } from './core/http.js';
import { refreshToken } from './core/refresh.js';
import { namedEnvFile, resolveConfigHome, writeCredentials } from './core/config-write.js';
import { InstagramError, isInstagramError } from './core/types.js';
import type { ResolvedProfile } from './core/types.js';
import { PACKAGE_ENV_NAMES, registerTools } from './mcp/registry.js';
import { closeOnSignal, startHttp, startStdio } from './mcp/transport.js';
import { runLogin } from './cli/login.js';
import { runDoctor } from './cli/doctor.js';
import { allTools } from './tools/index.js';

/** Mirrors package.json — the identity advertised to MCP clients. */
const SERVER_NAME = 'instagram-mcp-ai';
const SERVER_VERSION = '0.8.0';

const MIN_NODE_MAJOR = 22;

/** dotenv's own switches, which it reads from the environment and lets win over our options. */
const DOTENV_ENV_KNOBS = ['DOTENV_CONFIG_QUIET', 'DOTENV_CONFIG_DEBUG'] as const;

/** Fail fast on an unsupported runtime before any Node-22-only API is touched. */
function assertNodeVersion(): void {
  const major = Number(process.versions.node.split('.')[0]);
  // Equivalent-mutant note: dropping `Number.isFinite(major)` changes no outcome
  // for any Node version string — `NaN < MIN_NODE_MAJOR` is already false, so a
  // version we cannot parse is tolerated either way. It is not a no-op in general:
  // `"-Infinity"` fails the finite test but makes the comparison TRUE, so the bare
  // form would refuse it. `process.versions.node` never carries that, and the guard
  // stays because "tolerate what we cannot parse" is the deliberate rule here — the
  // bare comparison expresses it only by accident.
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
function loadEnvFiles(): Map<string, string> {
  // CC-PROC-18: this was `explicit && explicit !== ''`, whose second test could
  // never be false — `''` is falsy, so the first operand had already
  // short-circuited. Spelled out the way the other two optional-string guards in
  // this file are (`httpToken !== undefined && httpToken !== ''`): the two
  // rejected cases are unset and blank, and `namedEnvFile` now returns
  // `undefined` for both.
  //
  // CC-CFG-66 / CC-CFG-67: the value is read through `namedEnvFile`, the same
  // reading the write path uses. dotenv expands any leading `~` on its own —
  // `~root/x` included, as `<home>/root/x` — so the read accepted `~/x` while
  // `login` / `refresh` refused it as relative. Now a leading `~` is the home
  // directory on both sides, and a shell-only spelling (`$HOME/…`, `%APPDATA%…`,
  // `~user/…`) stops the start with IG_ENV_FILE named instead of reaching dotenv.
  const explicit = namedEnvFile({ IG_ENV_FILE: process.env.IG_ENV_FILE });
  // `quiet: true` alone does NOT hold the stream, because dotenv 17 reads its own
  // knobs off the environment and lets them BEAT the options passed here:
  // `parseBoolean(processEnv.DOTENV_CONFIG_QUIET || (options && options.quiet))`
  // (`dotenv/lib/main.js`). An operator carrying `DOTENV_CONFIG_QUIET=false` for
  // some other project's benefit therefore gets the banner on OUR stdout in spite
  // of the option, and `DOTENV_CONFIG_DEBUG=1` adds a trace per candidate that
  // names the config-home path — both on the one stream the stdio transport owns.
  // Neither is negotiable by an environment variable, so the knobs are withdrawn
  // for the length of the load and put back exactly as they were afterwards. Note
  // that "was not set" is not the same as "set to empty": `''` parses as false,
  // so restoring a missing knob by assignment would turn quiet OFF for whoever
  // reads it next.
  const knobs = DOTENV_ENV_KNOBS.map((knob) => [knob, process.env[knob]] as const);
  for (const [knob] of knobs) delete process.env[knob];
  // Which file supplied each key the load added (a key absent here was already
  // in the environment the client passed). `override: false` means a file only
  // ever adds keys, so the before/after difference is exactly its contribution.
  const setBy = new Map<string, string>();
  const load = (file: string): ReturnType<typeof dotenvConfig> => {
    const before = new Set(Object.keys(process.env));
    const loaded = dotenvConfig({ path: file, override: false, quiet: true });
    const added = Object.keys(process.env).filter((key) => !before.has(key));
    // CC-CFG-71: a file value is judged by the rule the client's environment is
    // (CC-CFG-46). An unexpanded `${user_config.X}` template written INTO a file
    // is unset, not a value: it is dropped again, so it neither reaches Graph nor
    // keeps a later candidate (the project `.env`) from supplying the key.
    const unset = new Set(
      unsetPlaceholderKeys(Object.fromEntries(added.map((key) => [key, process.env[key]]))),
    );
    for (const key of added) {
      if (unset.has(key)) delete process.env[key];
      else setBy.set(key, file);
    }
    return loaded;
  };
  try {
    // An explicit `IG_ENV_FILE` is a statement of intent, not a candidate: it
    // REPLACES the list below, so a path that cannot be read would otherwise
    // leave the process with no env file at all and nothing saying why — the
    // operator reads "No default profile configured" about a file they did
    // configure, or, with a token in the real environment, a server that starts
    // without every other knob that file set. dotenv reports a missing file, a
    // directory and an unreadable file alike through `error` rather than
    // throwing, so that is what is checked. The path is echoed; it is where the
    // operator has to look, and it is not a secret.
    if (explicit !== undefined) {
      const loaded = load(explicit);
      if (loaded.error !== undefined) {
        throw new InstagramError(
          `IG_ENV_FILE names "${explicit}", which could not be read as an env file`,
          { kind: 'validation' },
        );
      }
      return setBy;
    }
    const candidates = [
      path.join(resolveConfigHome(), SERVER_NAME, '.env'),
      path.resolve(process.cwd(), '.env'),
    ];
    for (const file of candidates) {
      // `quiet: true` is load-bearing, not cosmetic. From dotenv 17 a successful
      // load prints a banner ("injected env (N) from …" plus a product tip) to
      // STDOUT. On the stdio transport stdout carries JSON-RPC and nothing else,
      // so that banner is a framing error the client reports as a parse failure —
      // and it leaks the config-home path into the stream on the way. dotenv 16
      // ignores the option, so this is correct under both. Dropping it is caught
      // by "loading an env file puts nothing on stdout, so the JSON-RPC framing
      // survives it", and the withdrawal above is held by "a dotenv knob in the
      // environment cannot talk its way onto stdout".
      //
      // Equivalent-mutant note: the `existsSync` guard is an optimisation, not a
      // behaviour — dotenv 17 given a missing path returns an error object, writes
      // nothing to either stream (quiet, which the withdrawal above now makes
      // unconditional) and throws nothing, so calling it unconditionally is
      // indistinguishable from skipping. It stays because "load the files that
      // exist" is the documented rule, and because it is what keeps a future
      // dotenv's missing-file diagnostics off stdout.
      if (existsSync(file)) load(file);
    }
    return setBy;
  } finally {
    for (const [knob, value] of knobs) {
      if (value === undefined) delete process.env[knob];
      else process.env[knob] = value;
    }
  }
}

/** Register every secret value so the redactor masks it in all log output. */
function registerProfileSecrets(profiles: ResolvedProfile[]): void {
  for (const p of profiles) {
    registerSecret(p.accessToken);
    if (p.appSecret !== undefined) registerSecret(p.appSecret);
  }
  // Equivalent-mutant note: neither half of this guard is observable on its own.
  // `registerSecret` already ignores a non-string and anything shorter than eight
  // characters, so both `undefined` and `''` are no-ops if they reach it. The
  // `!== undefined` half is what the type checker requires (`registerSecret`
  // takes a `string`); the `!== ''` half stays because the identical guard on the
  // HTTP transport below IS load-bearing — there a blank `IG_HTTP_TOKEN` means
  // "no authentication", which its own test pins — and the two spellings must not
  // drift. The `.trim()` is not part of that: it decides WHICH exact string is
  // registered, and an untrimmed registration would leave the bearer the
  // transport actually compares against unmasked. The padded-bearer case in
  // test/index.test.ts pins it.
  const httpToken = process.env.IG_HTTP_TOKEN?.trim();
  if (httpToken !== undefined && httpToken !== '') registerSecret(httpToken);
}

/**
 * The `IG_*` names this file reads itself, outside every owner module's set.
 *
 * Pinned by `test/env-catalog.test.ts` against the `process.env.IG_*` reads in
 * this file, in both directions: a name here that nothing below reads silences
 * the CC-CFG-13 warning for a variable that does nothing, and a read added
 * below without a name here reports a working knob to the operator as a typo.
 * That pin is textual rather than the recording `Proxy` the two sibling lists
 * use, because this module reads `process.env` directly and cannot be imported
 * at all — `main()` runs at module scope. Measured 2026-09-23: without it,
 * dropping a name from this list survived the whole suite.
 */
const ENTRY_ENV_NAMES: readonly string[] = ['IG_ENV_FILE', 'IG_HTTP_TOKEN'];

/**
 * Every `IG_*` name in `env` that nothing reads (CC-CFG-13), sorted. A mistyped
 * knob — the write-mode name with its underscore dropped, a token filed under
 * the reserved `default` profile name — used to be a silent default: the server
 * ran in `preview` and the operator believed otherwise. The recognised set is assembled HERE because no module can see all
 * of it: `core/settings.ts` owns the knobs, `core/config.ts` the profile scheme
 * (and the expiry metadata `login` writes back), `mcp/registry.ts` the
 * tool-selection knobs, and this file `IG_ENV_FILE` / `IG_HTTP_TOKEN`. Each
 * owner publishes its half and pins it against what it actually reads, so a
 * knob added to one of them cannot start being reported as a typo.
 *
 * Names only, never values: the result is logged, and a value could be a token.
 * The match is exact — env names are case-sensitive on POSIX, so `ig_transport`
 * is simply not in the namespace, and on Windows `process.env` folds case before
 * this ever sees the key.
 */
function unrecognisedEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter(
      (name) =>
        name.startsWith('IG_') &&
        !SETTINGS_ENV_NAMES.includes(name) &&
        !isProfileEnvName(name) &&
        !PACKAGE_ENV_NAMES.includes(name) &&
        !ENTRY_ENV_NAMES.includes(name),
    )
    .sort();
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

/** The subcommands the entry routes; anything else on argv[2] is refused. */
const SUBCOMMANDS = ['login', 'doctor', 'refresh'] as const;

const USAGE_TEXT = `Usage:
  instagram-mcp-ai                        Start the MCP server (transport from IG_TRANSPORT).
  instagram-mcp-ai login --path <ig|fb>   Obtain and persist a long-lived token (login --help).
  instagram-mcp-ai doctor                 Health-check the active profile (exit 0 when healthy).
  instagram-mcp-ai refresh                Refresh the active profile's long-lived token.
`;

/**
 * Argv discipline for the entry, before anything else runs: a usage error must
 * be reported as one, not as whatever the misread line happens to do next.
 *
 * Without this, `instagram-mcp-ai docter` (a typo) fell through to "no
 * subcommand" and started the stdio server — a process that sits on stdin
 * waiting for JSON-RPC, which from a terminal looks like a hang — and
 * `doctor --bogus` ran the doctor with the stray token dropped, so a
 * mistyped flag was indistinguishable from a clean run. Both are refused with
 * exit 2 (the usage code the `login` parser already uses for its own unknown
 * arguments), naming the offending token. `--help`/`-h` on their own print the
 * usage and exit 0. Returns only when the line is one of the routed shapes.
 */
/**
 * How a refused argv token is named on stderr: cut at its first `=` and passed
 * through the token-shape backstop of the redactor (CC-PROC-208).
 *
 * Both refusals below echo a token the operator did not mean to pass, and a
 * launcher's stderr is not the operator's terminal: an MCP host writes it to
 * its own log file. The stray-argument refusal already dropped the value after
 * an `=`; the unknown-subcommand refusal echoed the whole token, so a client
 * config carrying `"args": ["--access-token=EAA…"]` copied the token into that
 * log. The flag part is what tells the operator what was wrong; the value is
 * the one part that could be a secret. A bare token (`args: ["EAA…"]`) has no
 * `=` to cut at, so the redactor's shape patterns are what mask it — nothing is
 * registered yet at this point, so the shapes are all it can know.
 */
function argvName(token: string): string {
  const eq = token.indexOf('=');
  return String(createRedactor()(eq === -1 ? token : token.slice(0, eq)));
}

function assertUsage(argv: string[]): void {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined) return;
  if (subcommand === '--help' || subcommand === '-h') {
    process.stderr.write(USAGE_TEXT);
    process.exit(0);
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    process.stderr.write(
      `instagram-mcp-ai: unknown subcommand '${argvName(subcommand)}'.\n\n${USAGE_TEXT}`,
    );
    process.exit(2);
  }
  // `login` parses its own line; `doctor` and `refresh` take nothing at all.
  // Only the first stray token is named, and only as `argvName` shows it: a
  // `--flag=value` typed here is a flag no command takes, and the value after
  // the `=` is the one part of the line that could be a secret.
  const stray = rest[0];
  if (subcommand !== 'login' && stray !== undefined) {
    process.stderr.write(
      `${subcommand}: unknown argument '${argvName(stray)}'; ${subcommand} takes no arguments.\n\n${USAGE_TEXT}`,
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  assertNodeVersion();
  assertUsage(process.argv.slice(2));
  // An MCPB host passes an optional field the user left empty as its literal
  // `${user_config.X}` template (CC-CFG-46). Dropped BEFORE the env files load,
  // so a file can still supply the key and `IG_ENV_FILE` is not read as a path.
  for (const key of unsetPlaceholderKeys(process.env)) delete process.env[key];
  const setBy = loadEnvFiles();
  // `IG_ENV_FILE` is read once, above, from the environment the client passed.
  // One that an env file supplied was never followed — the load was already
  // under way — yet `login` / `refresh` write to whatever `IG_ENV_FILE` names
  // (CC-CFG-63). Left in place it would send a fresh token to a file this
  // server does not read, so it is dropped and the write lands where the read
  // came from.
  if (setBy.has('IG_ENV_FILE')) delete process.env.IG_ENV_FILE;
  // A recorded expiry is only true of the token stored beside it. One that
  // reached this process from a different source than its profile's token (the
  // client passed the token, a file supplied the record) describes some other
  // token, so it is dropped and the expiry reads as unknown (core/config.ts).
  for (const key of strayExpiryKeys(process.env, (k) => setBy.get(k) ?? 'environment')) {
    delete process.env[key];
  }

  const settings = loadSettings();
  const clock = systemClock;
  const subcommand = process.argv[2];

  // `login` runs before profile resolution — it is what an operator runs when
  // there is no valid credential yet, so it must not require a loadable profile.
  if (subcommand === 'login') {
    // `slice(3)` drops the subcommand itself. `slice(2)` would hand `'login'`
    // to the flag parser as a bare positional, and since 2026-09-19 the parser
    // refuses any positional that is not an auth-path name, so every `login`
    // invocation would exit 2 with `login: unknown argument 'login'.` — which is
    // what the entry test's bare-`login` case (expecting the `--path` usage
    // error instead) pins against.
    process.exit(await runLogin(process.argv.slice(3)));
  }

  // Build the logger with redaction wired in. `createRedactor` reads the secret
  // registry live, so the logger can exist BEFORE the profiles are loaded and
  // their token/secret values registered: every field is still scrubbed at the
  // sink from the first registration on. It has to exist first, because the one
  // line logged before the profiles is the unrecognised-name warning, and the
  // operator it is for is exactly the one whose misspelt token key makes
  // `loadProfiles` refuse to start on the next line.
  const log = createLogger({
    level: settings.logLevel,
    clock,
    redact: createRedactor(),
  });
  const unrecognised = unrecognisedEnvNames(process.env);
  if (unrecognised.length > 0) {
    log.warn('ignoring unrecognised IG_* environment variables', {
      names: unrecognised,
      hint: 'nothing reads these; check the spelling against .env.example',
    });
  }
  const { profiles, defaultName } = loadProfiles();
  registerProfileSecrets(profiles);

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
      // Equivalent-mutant note: the same one the `refresh` call below carries —
      // `cli/doctor.ts` defaults `nowMs` to `Date.now()`, which is exactly what
      // `systemClock.now()` reads, so dropping this line is not separable by any
      // input. It stays because the composition root is the one place that
      // injects the clock, and a `doctor` that read the wall clock directly
      // would be the one health check a substituted clock stopped reaching.
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
      // Equivalent-mutant note: dropping `nowMs` cannot be separated by any
      // input — `core/refresh.ts` defaults it to `Date.now()`, which is what
      // `systemClock.now()` returns, so the only difference is the sub-
      // millisecond gap between the two reads and the rendered expiry is floored
      // to whole seconds. It stays because the composition root is the one place
      // that injects the clock: every other timestamp in a run comes from
      // `clock`, and a `refresh` that quietly read the wall clock instead is how
      // a substituted clock would stop applying to precisely the path that mints
      // credentials.
      nowMs: clock.now(),
    });
    // F-4 (docs/security.md §2, core/redact.ts): the exchange has just minted a
    // LIVE long-lived credential, and it is a value the redactor cannot know on
    // sight — a Page token or a rotated secret routinely looks like nothing in
    // particular, and the `EAA…`/`IG…` shape backstop is best-effort only. Until
    // it is registered, every string built from here to process exit carries it
    // in the clear: the persist below (whose fs errors quote the file it was
    // rewriting), any log line added to this path, an unhandled rejection Node
    // prints itself. So it is registered HERE — between the mint and the first
    // thing that can touch it — not after the write, which would leave a failed
    // rotation as the one case where the new token is still unmasked.
    // `createRedactor` reads the registry live, so the logger built above starts
    // masking it without being rebuilt.
    //
    // `login` mints at the same point in its own flow and deliberately does NOT
    // register (CC-AUTH-24). It is dispatched at the `subcommand === 'login'`
    // branch above and exits from there, before this logger exists, so nothing
    // in that process ever builds a redactor for a registration to reach. Its
    // guarantee is local instead: it prints no token at all, and its only
    // unbounded output — `login failed: <message>` — carries a Graph
    // `error.message`, never the request URL or the raw response body, and is
    // passed through a redactor built there from the app secret, the code and
    // every token that run minted.
    registerSecret(refreshed.accessToken);
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
    const running = await startHttp(
      () => buildServer().server,
      {
        host: settings.httpHost,
        port: settings.httpPort,
        token: httpToken !== undefined && httpToken !== '' ? httpToken : undefined,
      },
      log,
    );
    // Keep the handle: SIGTERM/SIGINT would otherwise kill the process at the
    // signal and `close()` — the graceful teardown — would never run outside the
    // tests (CC-PROC-204).
    closeOnSignal(running, log);
  } else {
    // No signal handler on stdio, deliberately. Its clean close is stdin EOF
    // (the client leaving), which `startStdio` turns into a transport close
    // (CC-PROC-206) — the SDK transport alone never listens for it; there is no
    // listener or socket for a handler to tear down, and the in-flight handlers
    // a signal would cut off are cut off by `process.exit` just the same, so a
    // handler would only replace Node's default "die by the signal" with an
    // exit code that claims more than happened.
    // Equivalent-mutant note: handing `startStdio` a second, freshly registered
    // instance (`buildServer().server`) is indistinguishable by any test —
    // registration is a pure function of the same inputs and logs nothing of its
    // own, so the two instances are identical and stdio serves exactly one of
    // them either way. `built` stays because the line above already LOGGED
    // `built`: `count` is meant to describe the surface this process serves, and
    // serving a different instance makes that true only by coincidence. Building
    // twice would also pay for a full second registration whose only product is
    // discarded.
    await startStdio(built.server, log);
  }
}

main().catch((err: unknown) => {
  // Config/validation failures surface here before the server starts. Keep the
  // message clean (no stack, no token). The message is routed through a
  // redactor because this line is reached AFTER secrets exist, too: a failed
  // `refresh` exchange carries Meta's `error.message` verbatim, a failed start
  // of the transport follows profile loading, and a mis-filed token (a token
  // pasted into `IG_AUTH_MODE`) is echoed by the config parser's refusal. A
  // fresh redactor reads the live registry — every profile secret and minted
  // token registered so far — plus the token-shape backstop, which is all that
  // covers a failure before registration.
  // The `String(err)` arm is defensive only: everything the startup path can
  // reject with is an `InstagramError` (config/validation) or a plain `Error`
  // (the runtime guard, the transport). It exists because `catch` is typed
  // `unknown` and a dependency throwing a bare value must still print. The
  // ignore covers that arm, not the statement that chooses between them
  // (CC-PROC-128).
  const message =
    /* c8 ignore next */
    isInstagramError(err) || err instanceof Error ? err.message : String(err);
  process.stderr.write(`instagram-mcp-ai failed to start: ${String(createRedactor()(message))}\n`);
  process.exit(1);
});
