/**
 * MCPB manifest gate (`manifest.json`) — the Claude Desktop bundle channel.
 *
 * The manifest declares two blocks that only work when they agree with each other
 * *and* with the server: `server.mcp_config.env` maps environment variables into
 * the spawned process, and `user_config` renders the form the operator fills in
 * inside Claude Desktop. Every mistake available here is silent — the bundle
 * installs, the form renders, the labelled input accepts a value, and the value
 * simply never reaches the server (or reaches the wrong variable).
 *
 * This repository has already shipped that defect once, one channel over:
 * `IG_FB_ACCESS_TOKEN` was documented across the setup guides as the Path-B token
 * variable while `core/config.ts` never read it, so everyone who followed the docs
 * configured nothing. On the MCPB channel the same mistake is worse, because it
 * comes with a title, a description and a text box that look authoritative.
 *
 * What this file locks:
 *   - phantom variables — every mapped variable is in the canonical `.env.example`
 *     catalog *and* is actually read by code under `src/`;
 *   - the env <-> user_config bijection, and the `${user_config.X}` interpolation
 *     naming the same key it is mapped to (a copy-paste there is invisible on a
 *     read and silently delivers a neighbouring field's value);
 *   - credential fields being masked in the UI;
 *   - declared defaults, read back from the code that applies them
 *     (`DEFAULT_SETTINGS`, `selectPackages`) rather than restated here, so the
 *     manifest and the server cannot drift apart while both still pass.
 *
 * Runs from the repo root (cwd) like the other `test/release/*` gates, with the
 * same walk-up fallback as `version-consistency.test.ts` for the case where the
 * compiled test is invoked from somewhere else. Strictly read-only: this file
 * opens files, never writes one, and touches no operator state.
 *
 * Deliberately out of scope: the `version` field, which
 * `test/release/version-consistency.test.ts` owns across all four channels.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProfiles } from '../../src/core/config.js';
import { DEFAULT_SETTINGS, loadSettings } from '../../src/core/settings.js';
import { PACKAGE_PROFILES, buildManifest, selectPackages } from '../../src/mcp/registry.js';
import { allTools } from '../../src/tools/index.js';

// --- Repo-root resolution ---------------------------------------------------

/** True for a plain JSON object (not `null`, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Locate the repo root: the nearest directory containing a `package.json`. Prefer
 * `process.cwd()` (the test runner's working directory); otherwise walk up from
 * this *compiled* test's own directory, which lives under `dist/` and therefore
 * cannot be used to reach the repo root by a fixed relative path.
 *
 * Mirrors `version-consistency.test.ts` on purpose — the release gates must all
 * resolve repo files the same way.
 */
function findRepoRoot(): string {
  const candidates: string[] = [process.cwd()];
  let dir = dirname(fileURLToPath(import.meta.url));
  let parent = dirname(dir);
  while (dir !== parent) {
    candidates.push(dir);
    dir = parent;
    parent = dirname(dir);
  }
  candidates.push(dir); // filesystem root

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(
    `could not locate repo root: no package.json found in any of ${candidates.join(', ')}`,
  );
}

const repoRoot = findRepoRoot();

/** Read a UTF-8 file from the repo root; fail clearly if it is absent. */
function readRepoText(file: string): string {
  const path = join(repoRoot, file);
  if (!existsSync(path)) throw new Error(`${file} not found at ${path}`);
  return readFileSync(path, 'utf8');
}

/** Read + parse a JSON file from the repo root. */
function readRepoJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readRepoText(file));
  if (!isRecord(parsed)) throw new Error(`${file} did not parse to a JSON object`);
  return parsed;
}

// --- Manifest accessors -----------------------------------------------------

/** One `user_config` form field, as declared in the manifest. */
interface UserConfigEntry {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  default?: unknown;
  sensitive?: unknown;
  required?: unknown;
}

const manifest = readRepoJson('manifest.json');

/** Narrow a manifest sub-block, naming its dotted path when it is not an object. */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`manifest.json ${label} must be a JSON object, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** `server.mcp_config.env`: environment variable name -> value expression. */
function envBlock(): Record<string, string> {
  const server = asRecord(manifest.server, 'server');
  const mcpConfig = asRecord(server.mcp_config, 'server.mcp_config');
  const env = asRecord(mcpConfig.env, 'server.mcp_config.env');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      throw new Error(`manifest.json server.mcp_config.env.${key} must be a string`);
    }
    out[key] = value;
  }
  return out;
}

/** `user_config`: form-field name -> field declaration. */
function userConfigBlock(): Record<string, UserConfigEntry> {
  const block = asRecord(manifest.user_config, 'user_config');
  const out: Record<string, UserConfigEntry> = {};
  for (const [key, value] of Object.entries(block)) {
    out[key] = asRecord(value, `user_config.${key}`);
  }
  return out;
}

/** The single field of `user_config` named `key`, or a failing assertion. */
function userConfigEntry(key: string): UserConfigEntry {
  const entry = userConfigBlock()[key];
  assert.ok(entry !== undefined, `manifest.json user_config must declare "${key}"`);
  return entry;
}

// --- Shared rules -----------------------------------------------------------

/**
 * Is this variable's value a credential — something that grants access on its
 * own, or that lets the holder mint something which does?
 *
 * Decided by what the variable *is*, not by a hand-kept allowlist that a new
 * variable can quietly slip past: `IG_ACCESS_TOKEN` is a bearer token, and
 * `IG_APP_SECRET` signs `appsecret_proof` and performs token exchange/refresh, so
 * both are credentials. `IG_ACCOUNT_ID` and `IG_APP_ID` are *public identifiers* —
 * they travel in Graph URLs and in support threads, they authorise nothing on
 * their own, and masking them would only make a typo harder for the operator to
 * spot in the form. `IG_WRITE_MODE` and `IG_TOOL_PACKAGES` are plain settings.
 *
 * If a future credential does not match this predicate, extend the predicate —
 * the "must not be sensitive" half of the check below will insist on it.
 */
function isCredential(name: string): boolean {
  return /_(TOKEN|SECRET|PASSWORD|KEY)$/.test(name);
}

/** The literal MCPB token that resolves to the installed bundle's own directory. */
const DIRNAME_TOKEN = '${__dirname}';

/** `${user_config.NAME}` and nothing else, capturing NAME. */
const USER_CONFIG_REF = /^\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Field types an MCPB `user_config` entry may declare (manifest spec 0.x). */
const MCPB_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'directory', 'file']);

/**
 * `user_config` keys whose `default` this file verifies against the server. The
 * exhaustiveness check below refuses to let a new default ship unverified.
 */
const VERIFIED_DEFAULTS = new Set(['IG_WRITE_MODE', 'IG_TOOL_PACKAGES']);

// --- Launch wiring ----------------------------------------------------------

test('the MCPB launch wiring points at the built entry the package publishes', () => {
  const server = asRecord(manifest.server, 'server');
  const mcpConfig = asRecord(server.mcp_config, 'server.mcp_config');
  assert.equal(server.type, 'node', 'manifest.json server.type must be "node"');
  assert.equal(mcpConfig.command, 'node', 'manifest.json server.mcp_config.command must be "node"');

  const entryPoint = server.entry_point;
  assert.equal(typeof entryPoint, 'string', 'manifest.json server.entry_point must be a string');
  const entry = entryPoint as string;

  // The bundle ships the same build npm publishes; `main` is where that build
  // lives. Renaming the entry in one channel and not the other produces a bundle
  // that installs cleanly and then launches nothing.
  const pkg = readRepoJson('package.json');
  assert.equal(
    entry,
    pkg.main,
    `manifest.json server.entry_point (${entry}) must equal package.json main (${String(pkg.main)})`,
  );
  assert.ok(
    existsSync(join(repoRoot, entry)),
    `manifest.json server.entry_point "${entry}" does not exist under the repo root — ` +
      'the bundle would install and then fail to start (run `npm run build` first)',
  );

  const args = mcpConfig.args;
  assert.ok(Array.isArray(args), 'manifest.json server.mcp_config.args must be an array');
  const entryArgs = args.filter((arg) => typeof arg === 'string' && arg.endsWith(entry));
  assert.equal(
    entryArgs.length,
    1,
    `exactly one arg must name the entry point ${entry}; got ${JSON.stringify(args)}`,
  );
  // `${__dirname}` is what resolves the path inside the *installed bundle*. A bare
  // relative path would be resolved against whatever working directory Claude
  // Desktop happens to spawn the server with — usually not the bundle.
  assert.equal(
    entryArgs[0],
    `${DIRNAME_TOKEN}/${entry}`,
    `manifest.json server.mcp_config.args must launch "${DIRNAME_TOKEN}/${entry}" — ` +
      'a path without the ${__dirname} prefix resolves against the spawning cwd, not the bundle',
  );
});

/** `>=22`, `>= 22.0` and `>=22.0.0` all normalize to `[22, 0, 0]`. */
function parseNodeFloor(range: string, label: string): [number, number, number] {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  assert.ok(
    match !== null,
    `${label} must be a plain ">=X[.Y[.Z]]" floor so the two channels stay comparable; ` +
      `got "${range}" — widen this parser deliberately rather than loosening the check`,
  );
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

test('the MCPB node-runtime floor is the floor package.json already enforces', () => {
  const pkg = readRepoJson('package.json');
  const engines = asRecord(pkg.engines, 'package.json engines');
  const runtimes = asRecord(
    asRecord(manifest.compatibility, 'compatibility').runtimes,
    'compatibility.runtimes',
  );
  assert.equal(typeof engines.node, 'string', 'package.json engines.node must be a string');
  assert.equal(
    typeof runtimes.node,
    'string',
    'manifest.json compatibility.runtimes.node must be a string',
  );

  // Compared as parsed floors, never as strings: `>=22` and `>=22.0.0` are one
  // requirement spelled two ways, and a string compare would fail a correct
  // manifest. The number is what must not drift.
  assert.deepEqual(
    parseNodeFloor(runtimes.node as string, 'manifest.json compatibility.runtimes.node'),
    parseNodeFloor(engines.node as string, 'package.json engines.node'),
    'manifest.json compatibility.runtimes.node must require the same Node floor as ' +
      'package.json engines.node — npm refuses an install that violates `engines`, but a ' +
      'bundle advertising an older floor gets installed and only then fails to start',
  );
});

// --- Phantom-variable guards ------------------------------------------------

/**
 * Variable names declared in `.env.example`, using the same line grammar the
 * README generator uses (`test/helpers/doc-generators.ts` -> `renderEnvCatalog`):
 * only `KEY=value` lines are declarations, so group headers and the commented
 * `# IG_PROFILE_<NAME>_*` example do not count.
 */
function envExampleKeys(): Set<string> {
  const keys = new Set<string>();
  for (const line of readRepoText('.env.example').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
    const key = match?.[1];
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

test('every variable the manifest maps exists in the canonical .env.example catalog', () => {
  const declared = envExampleKeys();
  assert.ok(declared.size > 0, '.env.example parsed to zero variables — the parser is broken');

  for (const key of Object.keys(envBlock())) {
    assert.ok(
      declared.has(key),
      `manifest.json maps "${key}", which .env.example does not declare. ` +
        "`.env.example` is the canonical env catalog (README's Configuration table is " +
        'generated from it), so a variable missing there is either a typo or a phantom: ' +
        'the MCPB form would collect a value that nothing consumes.',
    );
  }
});

/** Every `.ts` source file under `src/`, read once. */
function sourceFiles(): { path: string; text: string }[] {
  const srcDir = join(repoRoot, 'src');
  return readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.ts'))
    .map((rel) => ({ path: rel, text: readFileSync(join(srcDir, rel), 'utf8') }));
}

/**
 * Does `source` actually *read* `name` off an environment object? Matches the two
 * spellings this codebase uses: a direct `env.IG_X` access (`core/config.ts`,
 * `mcp/registry.ts`) and a bare `'IG_X'` string literal handed to a reader such as
 * `parseEnumEnv(env, 'IG_X', …)` (`core/settings.ts`).
 *
 * A mention inside prose or inside an error message is deliberately not a read —
 * that is exactly the shape the `IG_FB_ACCESS_TOKEN` phantom had, and a laxer
 * "does the name appear anywhere" scan would have waved it through.
 */
function readsEnvVar(source: string, name: string): boolean {
  return new RegExp(`(?:\\benv\\.${name}\\b)|(?:['"\`]${name}['"\`])`).test(source);
}

test('every variable the manifest maps is actually read by the server', () => {
  const sources = sourceFiles();
  assert.ok(sources.length > 0, 'no .ts sources found under src/ — the scan is broken');

  for (const key of Object.keys(envBlock())) {
    const readers = sources.filter((file) => readsEnvVar(file.text, key)).map((file) => file.path);
    assert.ok(
      readers.length > 0,
      `manifest.json maps "${key}" into the server, but no file under src/ reads it. ` +
        'That is a phantom variable: Claude Desktop renders a labelled, described input ' +
        'for it and the value it collects goes nowhere. Either wire it up or remove it ' +
        'from both server.mcp_config.env and user_config.',
    );
  }
});

// --- env <-> user_config coupling -------------------------------------------

test('the env block and the user_config form describe exactly the same variables', () => {
  const envKeys = Object.keys(envBlock()).sort();
  const formKeys = Object.keys(userConfigBlock()).sort();
  assert.deepEqual(
    envKeys,
    formKeys,
    'manifest.json server.mcp_config.env and user_config must name the same variables. ' +
      'A key only in user_config is a form field whose value is never passed to the server; ' +
      'a key only in the env block interpolates a ${user_config.X} that was never declared, ' +
      'so the server receives an unresolved placeholder or nothing at all.',
  );
});

test('every env mapping interpolates its own user_config key, not a neighbour', () => {
  for (const [key, expression] of Object.entries(envBlock())) {
    const match = USER_CONFIG_REF.exec(expression);
    assert.ok(
      match !== null,
      `manifest.json server.mcp_config.env.${key} must be exactly ` +
        `"\${user_config.${key}}", got ${JSON.stringify(expression)}`,
    );
    assert.equal(
      match[1],
      key,
      `manifest.json server.mcp_config.env.${key} is cross-wired: it interpolates ` +
        `\${user_config.${String(match[1])}}, so the server would receive whatever the ` +
        `operator typed into the "${String(match[1])}" field under the name "${key}". ` +
        'This reads as correct at a glance, which is precisely why it is asserted.',
    );
  }
});

// --- Form-field hygiene -----------------------------------------------------

test('every user_config field is renderable: valid type, non-empty title and description', () => {
  for (const [key, entry] of Object.entries(userConfigBlock())) {
    assert.ok(
      typeof entry.type === 'string' && MCPB_FIELD_TYPES.has(entry.type),
      `manifest.json user_config.${key}.type is ${JSON.stringify(entry.type)}; it must be one of ` +
        `${[...MCPB_FIELD_TYPES].join(', ')} — an unknown type is not a field Claude Desktop can render`,
    );
    for (const field of ['title', 'description'] as const) {
      const value = entry[field];
      assert.ok(
        typeof value === 'string' && value.trim() !== '',
        `manifest.json user_config.${key}.${field} must be a non-empty string — ` +
          'this is the text the operator reads while deciding what to paste in',
      );
    }
    assert.equal(
      typeof entry.required,
      'boolean',
      `manifest.json user_config.${key}.required must be declared as a boolean`,
    );
  }
});

test('credential fields are masked in the form, and non-credential fields are not', () => {
  for (const key of Object.keys(userConfigBlock())) {
    const entry = userConfigEntry(key);
    if (isCredential(key)) {
      assert.equal(
        entry.sensitive,
        true,
        `manifest.json user_config.${key} carries a credential and must set "sensitive": true — ` +
          'without it Claude Desktop renders the secret as plain text in the settings UI and ' +
          'may store it outside the OS keychain',
      );
    } else {
      assert.notEqual(
        entry.sensitive,
        true,
        `manifest.json user_config.${key} is marked sensitive but is not a credential by the ` +
          'rule in isCredential() — masking a public identifier only hides typos from the ' +
          'operator. If this really is a credential, extend isCredential() instead.',
      );
    }
  }
});

/**
 * A plausible value for every profile variable `core/config.ts` reads. Used only
 * to ask the loader which variables it genuinely refuses to start without, so the
 * manifest's `required` flags are derived from the server rather than guessed.
 * Every value is a placeholder; nothing here is dialled and nothing is written.
 */
const PROFILE_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  IG_ACCESS_TOKEN: 'placeholder-access-token',
  IG_ACCOUNT_ID: '17841400000000001',
  IG_APP_ID: '1234567890123456',
  IG_APP_SECRET: 'placeholder-app-secret',
});

/** Does the server still resolve a profile when `omitted` is unset? */
function startsWithout(omitted: string): boolean {
  const env: NodeJS.ProcessEnv = { ...PROFILE_ENV };
  delete env[omitted];
  try {
    loadProfiles(env);
    return true;
  } catch {
    return false;
  }
}

test('a field is required exactly when the server refuses to start without it', () => {
  // Settings knobs are defaulted by construction, so an empty env must load.
  assert.doesNotThrow(() => loadSettings({}), 'loadSettings must succeed on an empty environment');

  for (const [key, entry] of Object.entries(userConfigBlock())) {
    const optional = startsWithout(key);
    assert.equal(
      entry.required,
      !optional,
      `manifest.json user_config.${key}.required is ${JSON.stringify(entry.required)}, but ` +
        `core/config.ts ${optional ? 'starts fine without it' : 'refuses to start without it'}. ` +
        'Marking a truly optional variable required blocks installs that never needed it ' +
        '(Path A needs no app credentials); marking a required one optional produces an ' +
        'install that completes and then cannot start.',
    );
  }
});

// --- Declared defaults, read back from the code that applies them ------------

test('the MCPB write-mode default is the server default and can never ship as "apply"', () => {
  const declared = userConfigEntry('IG_WRITE_MODE').default;
  assert.equal(typeof declared, 'string', 'user_config.IG_WRITE_MODE.default must be a string');
  const value = declared as string;

  // Read back from the loader that applies it, so the string is never stated twice.
  assert.equal(
    value,
    DEFAULT_SETTINGS.writeMode,
    `manifest.json declares IG_WRITE_MODE default "${value}" but DEFAULT_SETTINGS.writeMode is ` +
      `"${DEFAULT_SETTINGS.writeMode}" — the form would prefill a mode the server does not use`,
  );
  // ...and the loader really round-trips the declared string, so a value that is
  // merely spelled like the default (wrong case, stray space) still fails here.
  assert.equal(
    loadSettings({ IG_WRITE_MODE: value }).writeMode,
    loadSettings({}).writeMode,
    `IG_WRITE_MODE="${value}" must resolve to the same write mode as leaving it unset`,
  );

  // Safety interlock, not bookkeeping. `IG_WRITE_MODE` is the *standing consent*
  // for writes: under `apply` the server executes mutations without the
  // plan-then-apply step. A manifest that shipped `apply` as the prefilled default
  // would hand every MCPB installation unattended write access to a real Instagram
  // account — posting, commenting and deleting on the operator's behalf — from the
  // first tool call, and nobody would have to type anything to opt in. This
  // assertion is independent of the two above on purpose: if the *server* default
  // were ever flipped to `apply`, the derived checks would agree with each other
  // and pass, and this is the line that would still fail.
  assert.notEqual(
    value,
    'apply',
    'manifest.json must never prefill IG_WRITE_MODE with "apply" — that is standing consent ' +
      'for unattended writes to a real Instagram account, granted to every MCPB install by ' +
      'default. Writes must stay opt-in.',
  );
});

test('the MCPB tool-packages default selects exactly what an unset variable selects', () => {
  const declared = userConfigEntry('IG_TOOL_PACKAGES').default;
  assert.equal(typeof declared, 'string', 'user_config.IG_TOOL_PACKAGES.default must be a string');
  const value = declared as string;

  // The tool surface is the security-relevant output of this knob, so compare the
  // resolved surfaces rather than the strings: `selectPackages` is the authority on
  // what "unset" means, and it is asked directly instead of restating "core" here.
  const packages = buildManifest(allTools);
  const unset = selectPackages(packages, {});
  const prefilled = selectPackages(packages, { IG_TOOL_PACKAGES: value });

  assert.deepEqual(
    [...prefilled.active].sort(),
    [...unset.active].sort(),
    `manifest.json prefills IG_TOOL_PACKAGES="${value}", which registers a different set of ` +
      'packages than the server registers when the variable is unset — the MCPB form would ' +
      'silently change the exposed tool surface for every bundle user',
  );
  assert.deepEqual(
    [...prefilled.readonly].sort(),
    [...unset.readonly].sort(),
    `IG_TOOL_PACKAGES="${value}" must force the same packages read-only as the unset default`,
  );
  // A comma list that happens to expand identically today would freeze today's
  // expansion: the profile is the thing that keeps tracking the registry.
  assert.ok(
    Object.hasOwn(PACKAGE_PROFILES, value.toLowerCase()),
    `manifest.json must prefill IG_TOOL_PACKAGES with a profile name (one of ` +
      `${Object.keys(PACKAGE_PROFILES).join(', ')}), not "${value}" — an explicit package list ` +
      'stops following the profile the moment the registry gains or drops a package',
  );
});

test('no user_config default ships unverified, and no credential ships one at all', () => {
  for (const [key, entry] of Object.entries(userConfigBlock())) {
    if (entry.default === undefined) continue;
    // A committed default for a credential *is* a committed credential: the
    // manifest is a public release artifact.
    assert.ok(
      !isCredential(key),
      `manifest.json user_config.${key} carries a credential and must never declare a ` +
        `"default" — manifest.json is a public release artifact, so the value would be ` +
        'published verbatim',
    );
    assert.ok(
      VERIFIED_DEFAULTS.has(key),
      `manifest.json user_config.${key} declares default ${JSON.stringify(entry.default)}, but ` +
        'no test in this file checks it against the value the server actually applies. Add the ' +
        'check and list the key in VERIFIED_DEFAULTS — an unverified prefilled default is how ' +
        'the form starts lying about how the server behaves.',
    );
  }
});

// --- Descriptions the operator actually acts on -----------------------------

test('the write-mode field advertises only modes the server accepts', () => {
  const description = String(userConfigEntry('IG_WRITE_MODE').description);
  const quoted = [...description.matchAll(/"([a-z-]+)"/g)].map((match) => match[1] ?? '');
  assert.ok(
    quoted.length > 0,
    'the IG_WRITE_MODE description must name its accepted values in quotes',
  );
  for (const mode of quoted) {
    assert.doesNotThrow(
      () => loadSettings({ IG_WRITE_MODE: mode }),
      `the IG_WRITE_MODE description advertises "${mode}", which core/settings.ts rejects — ` +
        'an operator who types it gets a server that refuses to start',
    );
  }
  assert.ok(
    quoted.includes(DEFAULT_SETTINGS.writeMode),
    `the IG_WRITE_MODE description must mention the default mode "${DEFAULT_SETTINGS.writeMode}"`,
  );
});

test('the tool-packages field advertises exactly the profiles the registry implements', () => {
  const description = String(userConfigEntry('IG_TOOL_PACKAGES').description);
  // The description spells the choices as a pipe-separated run, e.g. `a | b | c`.
  const run = /([a-z]+(?:\s*\|\s*[a-z]+)+)/.exec(description);
  assert.ok(
    run !== null,
    'the IG_TOOL_PACKAGES description must list its profiles as a `a | b | c` run so this ' +
      `gate can compare them against the registry; got: ${JSON.stringify(description)}`,
  );
  const advertised = (run[1] ?? '').split('|').map((name) => name.trim());
  // `all` is handled by selectPackages outside PACKAGE_PROFILES, so it is added here.
  const implemented = [...Object.keys(PACKAGE_PROFILES), 'all'];
  assert.deepEqual(
    [...advertised].sort(),
    [...implemented].sort(),
    'the IG_TOOL_PACKAGES description must list exactly the profiles mcp/registry.ts ' +
      'implements — advertising a removed profile hands the operator a value that makes the ' +
      'server refuse to start, and omitting a new one hides it from every bundle user',
  );
});
