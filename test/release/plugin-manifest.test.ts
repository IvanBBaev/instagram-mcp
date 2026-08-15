/**
 * Claude Code plugin gate (`.claude-plugin/`) — the fourth distribution channel.
 *
 * Two files make this channel work and they are only useful when they agree.
 * `marketplace.json` is the catalog `/plugin marketplace add IvanBBaev/instagram-mcp`
 * reads: it names the marketplace, names its owner, and points at the plugin.
 * `plugin.json` is the plugin itself: it declares the stdio MCP server Claude Code
 * spawns, and — since this gate was written — a `userConfig` block that prompts the
 * operator for the access token at enable time and delivers it to the server through
 * `${user_config.IG_ACCESS_TOKEN}`.
 *
 * Every failure available here is silent. A marketplace whose entry name drifts from
 * the plugin manifest still adds cleanly and then keys `enabledPlugins` under a name
 * the docs never mention. A `userConfig` key that no `env` mapping consumes renders a
 * prompt, accepts a secret, stores it in the keychain, and passes it to nothing. An
 * `env` mapping naming a key `userConfig` never declared hands the server an
 * unresolved placeholder that `core/config.ts` cannot tell apart from a real token.
 *
 * This repository has already shipped exactly that defect one channel over:
 * `IG_FB_ACCESS_TOKEN` was documented across the setup guides as the Path-B token
 * variable while `core/config.ts` never read it, so everyone who followed the docs
 * configured nothing. There is only one token variable, `IG_ACCESS_TOKEN`, and it
 * serves both auth paths.
 *
 * What this file locks:
 *   - phantom variables — every variable the plugin injects is in the canonical
 *     `.env.example` catalog *and* is actually read by code under `src/`, and no
 *     prose in either manifest names an `IG_*` variable the server does not read;
 *   - phantom *fields* — every key in either file is one the published schemas
 *     recognise, because Claude Code ignores unknown manifest fields at load time,
 *     which is how an invented credential mechanism would look correct and do
 *     nothing;
 *   - the `env` <-> `userConfig` bijection and the `${user_config.X}` interpolation
 *     naming the same key it is mapped to;
 *   - credential options being masked (`sensitive`), which is also what moves the
 *     value out of `settings.json` and into the OS keychain;
 *   - marketplace/plugin agreement on name, version and every other shared field,
 *     plus the `instagram-mcp-ai@<version>` npx pin;
 *   - that neither file can carry a credential value, by shape rather than by
 *     inspection.
 *
 * Runs from the repo root (cwd) like the other `test/release/*` gates, with the same
 * walk-up fallback as `version-consistency.test.ts` for the case where the compiled
 * test is invoked from somewhere else. Strictly read-only: this file opens files,
 * never writes one, and touches no operator state.
 *
 * Deliberately out of scope: the launch transport itself (`type`, `command`, the
 * absence of a `dist/` path) which `test/release/packaging.test.ts` and
 * `test/release/version-consistency.test.ts` own between them, and the cross-channel
 * version comparison against `server.json` and `manifest.json`, which
 * `version-consistency.test.ts` owns for all four channels at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProfiles } from '../../src/core/config.js';
import { loadSettings } from '../../src/core/settings.js';

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
 * Mirrors `version-consistency.test.ts` and `mcpb-manifest.test.ts` on purpose —
 * the release gates must all resolve repo files the same way.
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

// --- The two manifests ------------------------------------------------------

/**
 * `.claude-plugin/` sits at the repo root, so the *marketplace root* — the base every
 * `source` path is resolved against — is the repo root itself.
 */
const PLUGIN_DIR = '.claude-plugin';
const PLUGIN_FILE = join(PLUGIN_DIR, 'plugin.json');
const MARKETPLACE_FILE = join(PLUGIN_DIR, 'marketplace.json');

const plugin = readRepoJson(PLUGIN_FILE);
const marketplace = readRepoJson(MARKETPLACE_FILE);

/** One `userConfig` option, as declared in the plugin manifest. */
interface UserConfigOption {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  default?: unknown;
  sensitive?: unknown;
  required?: unknown;
}

/** Narrow a manifest sub-block, naming the file and the dotted path when it is not an object. */
function asRecord(value: unknown, file: string, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${file} ${label} must be a JSON object, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The `plugins` array of the marketplace catalog. */
function marketplaceEntries(): Record<string, unknown>[] {
  const plugins = marketplace.plugins;
  assert.ok(Array.isArray(plugins), `${MARKETPLACE_FILE} "plugins" must be an array`);
  return plugins.map((entry, index) => asRecord(entry, MARKETPLACE_FILE, `plugins[${index}]`));
}

/**
 * The single catalog entry for this repo's plugin. The marketplace is deliberately
 * one-plugin — this repo *is* the plugin — so anything else is a structural change
 * that must be made deliberately rather than absorbed by a lenient lookup.
 */
function soleEntry(): Record<string, unknown> {
  const entries = marketplaceEntries();
  assert.equal(
    entries.length,
    1,
    `${MARKETPLACE_FILE} must list exactly one plugin (this repo is the plugin); got ` +
      `${entries.length}. Listing a second plugin from this repo means the rest of this gate ` +
      'silently stops covering it.',
  );
  const entry = entries[0];
  assert.ok(entry !== undefined, `${MARKETPLACE_FILE} plugins[0] is missing`);
  return entry;
}

/** One `env` mapping in one of the plugin's MCP servers. */
interface EnvMapping {
  server: string;
  key: string;
  expression: string;
}

/** Every `mcpServers.<name>.env` mapping the plugin manifest declares, flattened. */
function envMappings(): EnvMapping[] {
  const servers = asRecord(plugin.mcpServers, PLUGIN_FILE, 'mcpServers');
  const out: EnvMapping[] = [];
  for (const [server, config] of Object.entries(servers)) {
    const block = asRecord(config, PLUGIN_FILE, `mcpServers.${server}`);
    if (block.env === undefined) continue;
    const env = asRecord(block.env, PLUGIN_FILE, `mcpServers.${server}.env`);
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') {
        throw new Error(`${PLUGIN_FILE} mcpServers.${server}.env.${key} must be a string`);
      }
      out.push({ server, key, expression: value });
    }
  }
  return out;
}

/** The distinct variable names the plugin injects into its servers. */
function envKeys(): string[] {
  return [...new Set(envMappings().map((mapping) => mapping.key))].sort();
}

/** `userConfig`: prompted option name -> option declaration. */
function userConfigBlock(): Record<string, UserConfigOption> {
  const block = asRecord(plugin.userConfig, PLUGIN_FILE, 'userConfig');
  const out: Record<string, UserConfigOption> = {};
  for (const [key, value] of Object.entries(block)) {
    out[key] = asRecord(value, PLUGIN_FILE, `userConfig.${key}`);
  }
  return out;
}

// --- Shared rules -----------------------------------------------------------

/**
 * Is this variable's value a credential — something that grants access on its own,
 * or that lets the holder mint something which does?
 *
 * Same rule as `mcpb-manifest.test.ts`, deliberately restated rather than shared:
 * these are two independent channel gates, and a helper imported from the other one
 * would let a single edit relax both at once. `IG_ACCESS_TOKEN` is a bearer token and
 * `IG_APP_SECRET` signs `appsecret_proof`, so both are credentials; `IG_ACCOUNT_ID`
 * and `IG_APP_ID` are public identifiers that authorise nothing on their own.
 *
 * If a future credential does not match this predicate, extend the predicate — the
 * "must not be sensitive" half of the check below will insist on it.
 */
function isCredential(name: string): boolean {
  return /_(TOKEN|SECRET|PASSWORD|KEY)$/.test(name);
}

/** `${user_config.NAME}` and nothing else, capturing NAME. */
const USER_CONFIG_REF = /^\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Option types a Claude Code `userConfig` option may declare. */
const PLUGIN_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'directory', 'file']);

/**
 * Fields a single `userConfig` option may declare. The published schema sets
 * `additionalProperties: false` here, so an unrecognised key is not merely inert —
 * it fails `claude plugin validate`.
 */
const USER_CONFIG_OPTION_FIELDS = new Set([
  'type',
  'title',
  'description',
  'required',
  'default',
  'multiple',
  'sensitive',
  'min',
  'max',
]);

/**
 * Top-level fields a plugin manifest may declare.
 *
 * Claude Code *ignores* unknown top-level fields at load time — it warns, and only
 * `claude plugin validate --strict` turns that into an error. That leniency is the
 * whole reason this set exists: a plausible-looking field that the loader silently
 * drops is indistinguishable, on a read, from a working one. It is precisely how an
 * invented credential-prompt mechanism would have looked correct and done nothing.
 */
const PLUGIN_MANIFEST_FIELDS = new Set([
  '$schema',
  'name',
  'displayName',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'dependencies',
  'commands',
  'agents',
  'skills',
  'hooks',
  'mcpServers',
  'lspServers',
  'monitors',
  'outputStyles',
  'themes',
  'channels',
  'settings',
  'userConfig',
]);

/**
 * Fields a marketplace *entry* may declare. Taken from the published marketplace
 * schema, which sets `additionalProperties: false` on entries — so unlike the plugin
 * manifest above, an unknown key here is a hard validation failure.
 *
 * Note `displayName` is absent: the docs describe it for plugin manifests, but the
 * published marketplace schema does not accept it inside an entry. The entry
 * therefore does not use it, and the plugin manifest carries it instead.
 */
const MARKETPLACE_ENTRY_FIELDS = new Set([
  '$schema',
  'name',
  'source',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'dependencies',
  'commands',
  'agents',
  'skills',
  'hooks',
  'mcpServers',
  'lspServers',
  'monitors',
  'outputStyles',
  'themes',
  'channels',
  'settings',
  'userConfig',
  'category',
  'tags',
  'strict',
]);

/**
 * Top-level fields of the marketplace catalog. The published schema is permissive at
 * this level (no `additionalProperties: false`), so this set is our own hygiene rule:
 * a misspelled `owners` would validate and then leave the marketplace unattributed.
 */
const MARKETPLACE_TOP_LEVEL_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'owner',
  'plugins',
  'metadata',
  'renames',
  'forceRemoveDeletedPlugins',
  'allowCrossMarketplaceDependenciesOn',
]);

/**
 * Marketplace names Anthropic reserves. Registering one of these does not merely
 * fail — it is a name that implies first-party provenance for a community plugin.
 */
const RESERVED_MARKETPLACE_NAMES = new Set([
  'claude-code-marketplace',
  'claude-code-plugins',
  'claude-plugins-official',
  'claude-plugins-community',
  'claude-community',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'anthropic-agent-skills',
  'knowledge-work-plugins',
  'life-sciences',
  'claude-for-legal',
  'claude-for-financial-services',
  'financial-services-plugins',
  'first-party-plugins',
  'healthcare',
]);

// --- Marketplace catalog ----------------------------------------------------

test('the marketplace catalog carries the fields Claude Code needs to register it', () => {
  const name = marketplace.name;
  assert.equal(typeof name, 'string', `${MARKETPLACE_FILE} "name" must be a string`);
  const marketplaceName = name as string;

  // The name is user-visible and typed: `/plugin install <plugin>@<marketplace>`.
  assert.ok(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(marketplaceName),
    `${MARKETPLACE_FILE} "name" must be lowercase kebab-case (it is typed after "@" in ` +
      `\`/plugin install <plugin>@<marketplace>\`); got ${JSON.stringify(marketplaceName)}`,
  );
  assert.ok(
    !RESERVED_MARKETPLACE_NAMES.has(marketplaceName),
    `${MARKETPLACE_FILE} "name" is "${marketplaceName}", which Anthropic reserves. A reserved ` +
      'name claims first-party provenance for a community plugin — pick a name derived from ' +
      'the repo or the owner instead.',
  );

  const owner = asRecord(marketplace.owner, MARKETPLACE_FILE, 'owner');
  assert.ok(
    typeof owner.name === 'string' && owner.name.trim() !== '',
    `${MARKETPLACE_FILE} owner.name must be a non-empty string — it is the attribution a user ` +
      'sees before trusting the marketplace enough to add it',
  );

  assert.ok(
    marketplaceEntries().length > 0,
    `${MARKETPLACE_FILE} "plugins" must not be empty — an empty catalog adds successfully and ` +
      'then offers nothing to install',
  );
});

test('the marketplace serves this repo, from the directory that holds the manifests', () => {
  const entry = soleEntry();
  const source = entry.source;
  assert.equal(typeof source, 'string', `${MARKETPLACE_FILE} plugins[0].source must be a string`);
  const sourcePath = source as string;

  // Relative plugin sources must start with `./` and are resolved against the
  // marketplace root — the directory that contains `.claude-plugin/`, i.e. the repo
  // root. A bare "." or an absolute path is not accepted by the schema.
  assert.ok(
    sourcePath.startsWith('./'),
    `${MARKETPLACE_FILE} plugins[0].source must be a repo-relative path starting with "./" ` +
      `(the plugin lives in this same repo); got ${JSON.stringify(sourcePath)}`,
  );

  const resolved = resolve(repoRoot, sourcePath);
  const inside = relative(repoRoot, resolved);
  assert.ok(
    !inside.startsWith('..'),
    `${MARKETPLACE_FILE} plugins[0].source "${sourcePath}" escapes the marketplace root — ` +
      'a plugin source must stay inside the repository that publishes the catalog',
  );
  assert.ok(
    existsSync(join(resolved, PLUGIN_DIR, 'plugin.json')),
    `${MARKETPLACE_FILE} plugins[0].source "${sourcePath}" resolves to ${resolved}, which has no ` +
      `${PLUGIN_DIR}/plugin.json. The marketplace would add cleanly and then fail to install ` +
      'the plugin it advertises.',
  );
});

test('the marketplace entry and the plugin manifest never disagree on a shared field', () => {
  const entry = soleEntry();

  // The entry name is what `/plugin install <name>@<marketplace>` takes and what
  // `enabledPlugins` is keyed by. When it differs from the plugin manifest's own
  // name, both are valid and every install instruction written against the manifest
  // is wrong.
  assert.equal(
    entry.name,
    plugin.name,
    `${MARKETPLACE_FILE} plugins[0].name (${JSON.stringify(entry.name)}) must equal ` +
      `${PLUGIN_FILE} "name" (${JSON.stringify(plugin.name)}) — the marketplace entry name is ` +
      'what users type and what enabledPlugins records, so a mismatch invalidates every ' +
      'documented install command',
  );

  const shared = Object.keys(entry).filter((key) => Object.hasOwn(plugin, key));
  // Guards the loop below against becoming vacuous if the entry is ever trimmed to
  // just `name` + `source`: the version copy in particular must stay compared.
  for (const required of ['name', 'version']) {
    assert.ok(
      shared.includes(required),
      `${MARKETPLACE_FILE} plugins[0] must declare "${required}" so this gate can compare it ` +
        `against ${PLUGIN_FILE}`,
    );
  }
  for (const key of shared) {
    assert.deepEqual(
      entry[key],
      plugin[key],
      `${MARKETPLACE_FILE} plugins[0].${key} and ${PLUGIN_FILE} ${key} disagree. Both files are ` +
        'read by Claude Code and the catalog is what a user sees *before* installing, so a ' +
        'stale copy here misrepresents the plugin at exactly the moment trust is decided.',
    );
  }
});

test('the marketplace entry does not restate the wiring the plugin manifest owns', () => {
  const entry = soleEntry();

  // `strict` defaults to true: the plugin's own manifest defines its components and
  // the entry may only supplement them. Setting it to false makes the entry the
  // whole definition, and a plugin.json that also declares components — ours
  // declares `mcpServers` and `userConfig` — is then a conflict that fails to load.
  assert.notEqual(
    entry.strict,
    false,
    `${MARKETPLACE_FILE} plugins[0].strict must not be false: ${PLUGIN_FILE} declares its own ` +
      'components, and under strict:false the marketplace entry becomes the entire definition, ' +
      'which makes that a load-time conflict rather than a merge',
  );

  for (const key of ['mcpServers', 'userConfig', 'commands', 'agents', 'skills', 'hooks']) {
    assert.ok(
      !Object.hasOwn(entry, key),
      `${MARKETPLACE_FILE} plugins[0] declares "${key}", which ${PLUGIN_FILE} already owns. ` +
        'Two copies of the server wiring drift silently — and the credential plumbing is the ' +
        'one place where a stale copy hands the server the wrong value rather than no value.',
    );
  }
});

test('neither manifest declares a field the schemas do not recognise', () => {
  for (const key of Object.keys(plugin)) {
    assert.ok(
      PLUGIN_MANIFEST_FIELDS.has(key),
      `${PLUGIN_FILE} declares top-level "${key}", which is not a recognised plugin-manifest ` +
        'field. Claude Code ignores unknown fields at load time (a warning, not an error), so ' +
        'this would look configured and do nothing — the same shape as the IG_FB_ACCESS_TOKEN ' +
        'phantom. If the field is real, add it here with a note; if it was invented, remove it.',
    );
  }
  for (const key of Object.keys(marketplace)) {
    assert.ok(
      MARKETPLACE_TOP_LEVEL_FIELDS.has(key),
      `${MARKETPLACE_FILE} declares top-level "${key}", which is not a recognised marketplace ` +
        'field. The marketplace schema is permissive at the top level, so a misspelling here ' +
        'validates cleanly and silently drops whatever it was meant to configure.',
    );
  }
  for (const key of Object.keys(soleEntry())) {
    assert.ok(
      MARKETPLACE_ENTRY_FIELDS.has(key),
      `${MARKETPLACE_FILE} plugins[0] declares "${key}", which the marketplace schema does not ` +
        'allow on an entry (entries are additionalProperties:false, so this fails ' +
        '`claude plugin validate` outright)',
    );
  }
});

// --- The npm version this channel serves ------------------------------------

/** `<package>@<version>` in an argv entry, capturing the pinned version. */
function findPackageSpec(args: unknown, packageName: string): string | null {
  if (!Array.isArray(args)) return null;
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    if (arg.startsWith(`${packageName}@`)) return arg.slice(packageName.length + 1);
  }
  return null;
}

test('both plugin-channel manifests pin the npm version package.json publishes', () => {
  const pkg = readRepoJson('package.json');
  const version = pkg.version;
  assert.equal(typeof version, 'string', 'package.json "version" must be a string');
  const packageName = pkg.name;
  assert.equal(typeof packageName, 'string', 'package.json "name" must be a string');

  // package.json is the single source of truth for the version; every other copy is
  // derived. version-consistency.test.ts owns the comparison across all four
  // channels — this is the marketplace copy it does not see, checked here so that
  // adding a marketplace did not quietly add an unguarded fifth copy.
  assert.equal(
    plugin.version,
    version,
    `${PLUGIN_FILE} "version" must equal package.json "version" (${String(version)})`,
  );
  assert.equal(
    soleEntry().version,
    version,
    `${MARKETPLACE_FILE} plugins[0].version must equal package.json "version" ` +
      `(${String(version)}). Bumping a release means updating package.json, server.json, ` +
      `manifest.json, ${PLUGIN_FILE} (twice) and this catalog entry — see ` +
      'test/release/version-consistency.test.ts and docs/release-checklist.md step 5.',
  );

  const servers = asRecord(plugin.mcpServers, PLUGIN_FILE, 'mcpServers');
  for (const [server, config] of Object.entries(servers)) {
    const block = asRecord(config, PLUGIN_FILE, `mcpServers.${server}`);
    const pin = findPackageSpec(block.args, packageName as string);
    assert.ok(
      pin !== null,
      `${PLUGIN_FILE} mcpServers.${server}.args must launch a pinned ` +
        `"${String(packageName)}@<version>" — an unpinned npx spec resolves to whatever is ` +
        'latest on npm, so the plugin and the server it starts can be different releases',
    );
    assert.equal(
      pin,
      version,
      `${PLUGIN_FILE} mcpServers.${server}.args pins ${String(packageName)}@${String(pin)} but ` +
        `package.json is at ${String(version)} — the plugin would install and then run an ` +
        'older (or non-existent) release of the server',
    );
  }
});

// --- Phantom-variable guards ------------------------------------------------

/**
 * Variable names declared in `.env.example`, using the same line grammar the README
 * generator uses (`test/helpers/doc-generators.ts` -> `renderEnvCatalog`): only
 * `KEY=value` lines are declarations, so group headers and the commented
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

test('every variable the plugin injects exists in the canonical .env.example catalog', () => {
  const declared = envExampleKeys();
  assert.ok(declared.size > 0, '.env.example parsed to zero variables — the parser is broken');

  for (const key of envKeys()) {
    assert.ok(
      declared.has(key),
      `${PLUGIN_FILE} injects "${key}", which .env.example does not declare. \`.env.example\` ` +
        "is the canonical env catalog (README's Configuration table is generated from it), so " +
        'a variable missing there is either a typo or a phantom: Claude Code would prompt for ' +
        'a value that nothing consumes.',
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
 * that is exactly the shape the `IG_FB_ACCESS_TOKEN` phantom had, and a laxer "does
 * the name appear anywhere" scan would have waved it through.
 */
function readsEnvVar(source: string, name: string): boolean {
  return new RegExp(`(?:\\benv\\.${name}\\b)|(?:['"\`]${name}['"\`])`).test(source);
}

test('every variable the plugin injects is actually read by the server', () => {
  const sources = sourceFiles();
  assert.ok(sources.length > 0, 'no .ts sources found under src/ — the scan is broken');

  for (const key of envKeys()) {
    const readers = sources.filter((file) => readsEnvVar(file.text, key)).map((file) => file.path);
    assert.ok(
      readers.length > 0,
      `${PLUGIN_FILE} injects "${key}" into the server, but no file under src/ reads it. That ` +
        'is a phantom variable: Claude Code renders a titled, described prompt for it, stores ' +
        'what the operator types, and passes it nowhere. Either wire it up or remove it from ' +
        'both the env block and userConfig.',
    );
  }
});

/** Every string *value* in a parsed JSON document, with its dotted path. */
function stringValues(value: unknown, path: string): { path: string; value: string }[] {
  if (typeof value === 'string') return [{ path, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => stringValues(item, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) => stringValues(item, `${path}.${key}`));
  }
  return [];
}

test('no manifest prose names an environment variable the server does not read', () => {
  const sources = sourceFiles();
  const documents: [string, Record<string, unknown>][] = [
    [PLUGIN_FILE, plugin],
    [MARKETPLACE_FILE, marketplace],
  ];

  for (const [file, document] of documents) {
    for (const { path, value } of stringValues(document, '')) {
      for (const match of value.matchAll(/\bIG_[A-Z0-9_]+\b/g)) {
        const name = match[0];
        const readers = sources.filter((source) => readsEnvVar(source.text, name));
        assert.ok(
          readers.length > 0,
          `${file}${path} names "${name}", which no file under src/ reads. Prose that names a ` +
            'variable is an instruction: this is the exact shape of the IG_FB_ACCESS_TOKEN ' +
            'defect, where every setup guide told operators to set a variable the server had ' +
            'never read. There is one token variable, IG_ACCESS_TOKEN, and it serves both auth ' +
            'paths. (Per-profile IG_PROFILE_<NAME>_* variables are built dynamically and must ' +
            'not be named literally here.)',
        );
      }
    }
  }
});

// --- env <-> userConfig coupling --------------------------------------------

test('the env block and the userConfig prompts describe exactly the same variables', () => {
  const formKeys = Object.keys(userConfigBlock()).sort();
  assert.deepEqual(
    envKeys(),
    formKeys,
    `${PLUGIN_FILE} mcpServers[].env and userConfig must name the same variables. A key only in ` +
      'userConfig is a prompt whose answer — a secret, keychain-stored — is never passed to the ' +
      'server; a key only in the env block interpolates a ${user_config.X} that was never ' +
      'declared, so the server receives an unresolved placeholder rather than nothing, which ' +
      'core/config.ts cannot tell apart from a real token.',
  );
});

test('every env mapping interpolates its own userConfig key, not a neighbour', () => {
  for (const { server, key, expression } of envMappings()) {
    const match = USER_CONFIG_REF.exec(expression);
    assert.ok(
      match !== null,
      `${PLUGIN_FILE} mcpServers.${server}.env.${key} must be exactly ` +
        `"\${user_config.${key}}", got ${JSON.stringify(expression)}. A literal value here is a ` +
        'value committed to a public repository; a host ${VAR} reference silently falls back to ' +
        "the operator's ambient shell, which is not what the prompt promised.",
    );
    assert.equal(
      match[1],
      key,
      `${PLUGIN_FILE} mcpServers.${server}.env.${key} is cross-wired: it interpolates ` +
        `\${user_config.${String(match[1])}}, so the server would receive whatever the operator ` +
        `typed into the "${String(match[1])}" prompt under the name "${key}". This reads as ` +
        'correct at a glance, which is precisely why it is asserted.',
    );
  }
});

// --- Prompt hygiene ---------------------------------------------------------

test('every userConfig option is promptable: valid type, non-empty title and description', () => {
  const options = Object.entries(userConfigBlock());
  assert.ok(
    options.length > 0,
    `${PLUGIN_FILE} must declare a userConfig block. Without one, enabling the plugin starts a ` +
      'server with no credential at all, and the operator is left to hand-edit settings.json — ' +
      'which is the gap this block exists to close.',
  );

  for (const [key, option] of options) {
    // Option keys become `${user_config.KEY}` references and are matched as
    // identifiers, so a key with a dot or a dash can never be interpolated.
    assert.ok(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
      `${PLUGIN_FILE} userConfig key ${JSON.stringify(key)} must be a plain identifier — it is ` +
        'referenced as ${user_config.KEY}, and anything else cannot be interpolated',
    );
    assert.ok(
      typeof option.type === 'string' && PLUGIN_FIELD_TYPES.has(option.type),
      `${PLUGIN_FILE} userConfig.${key}.type is ${JSON.stringify(option.type)}; it must be one ` +
        `of ${[...PLUGIN_FIELD_TYPES].join(', ')} — an unknown type is not a prompt Claude Code ` +
        'can render',
    );
    for (const field of ['title', 'description'] as const) {
      const value = option[field];
      assert.ok(
        typeof value === 'string' && value.trim() !== '',
        `${PLUGIN_FILE} userConfig.${key}.${field} must be a non-empty string — the schema ` +
          'requires it, and it is the text the operator reads while deciding what to paste in',
      );
    }
    assert.equal(
      typeof option.required,
      'boolean',
      `${PLUGIN_FILE} userConfig.${key}.required must be declared as a boolean`,
    );
    for (const field of Object.keys(option)) {
      assert.ok(
        USER_CONFIG_OPTION_FIELDS.has(field),
        `${PLUGIN_FILE} userConfig.${key}.${field} is not a field the option schema allows ` +
          `(userConfig options are additionalProperties:false). Allowed: ` +
          `${[...USER_CONFIG_OPTION_FIELDS].join(', ')}.`,
      );
    }
  }
});

test('credential prompts are masked and keychain-stored, and other prompts are not', () => {
  for (const [key, option] of Object.entries(userConfigBlock())) {
    if (isCredential(key)) {
      assert.equal(
        option.sensitive,
        true,
        `${PLUGIN_FILE} userConfig.${key} carries a credential and must set "sensitive": true. ` +
          'That flag does two things: it masks the input, and it routes the value to secure ' +
          'storage (the OS keychain) instead of writing it into settings.json, which is a ' +
          'plain file that operators paste into issues.',
      );
    } else {
      assert.notEqual(
        option.sensitive,
        true,
        `${PLUGIN_FILE} userConfig.${key} is marked sensitive but is not a credential by the ` +
          'rule in isCredential() — masking a public identifier only hides typos from the ' +
          'operator. If this really is a credential, extend isCredential() instead.',
      );
    }
  }
});

/**
 * A plausible value for every profile variable `core/config.ts` reads. Used only to
 * ask the loader which variables it genuinely refuses to start without, so the
 * manifest's `required` flags are derived from the server rather than guessed. Every
 * value is a placeholder; nothing here is dialled and nothing is written.
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

test('a prompt is required exactly when the server refuses to start without it', () => {
  // Settings knobs are defaulted by construction, so an empty env must load.
  assert.doesNotThrow(() => loadSettings({}), 'loadSettings must succeed on an empty environment');

  for (const [key, option] of Object.entries(userConfigBlock())) {
    const optional = startsWithout(key);
    assert.equal(
      option.required,
      !optional,
      `${PLUGIN_FILE} userConfig.${key}.required is ${JSON.stringify(option.required)}, but ` +
        `core/config.ts ${optional ? 'starts fine without it' : 'refuses to start without it'}. ` +
        'Marking a truly optional variable required blocks installs that never needed it ' +
        '(Path A needs no app credentials); marking a required one optional produces an ' +
        'install that completes and then cannot start. `required` is also what guarantees the ' +
        'value is present at substitution time — an unanswered optional prompt has no ' +
        'documented expansion.',
    );
  }
});

// --- Nothing secret may live in a public manifest ----------------------------

/**
 * Does this string look like a real credential rather than a placeholder or a
 * reference?
 *
 * Two rules, both on *shape* — neither needs to know what a valid token is:
 *   - a Meta token prefix (`IGAA…`, `EAA…`) followed by a run of token characters;
 *   - any unbroken run of 32+ token characters. Real Instagram/Facebook access
 *     tokens and app secrets are long opaque blobs; every legitimate string in these
 *     two manifests (URLs, package specs, prose) breaks well before 32 characters
 *     because `.`, `/`, `:`, `@` and spaces all end a run.
 *
 * The point is that pasting a live token into either file fails this gate, without
 * anyone having had to anticipate the paste.
 */
function looksLikeSecret(value: string): boolean {
  if (/^\$\{[^}]+\}$/.test(value)) return false; // a substitution reference, not a value
  if (/\b(?:IGA[A-Za-z0-9]|EA[AB])[A-Za-z0-9_-]{14,}\b/.test(value)) return true;
  return value.split(/[^A-Za-z0-9_-]+/).some((run) => run.length >= 32);
}

test('neither plugin-channel manifest can carry a credential value', () => {
  const documents: [string, Record<string, unknown>][] = [
    [PLUGIN_FILE, plugin],
    [MARKETPLACE_FILE, marketplace],
  ];

  for (const [file, document] of documents) {
    for (const { path, value } of stringValues(document, '')) {
      assert.ok(
        !looksLikeSecret(value),
        `${file}${path} contains a token-shaped string. Both files are committed and public: a ` +
          'credential pasted here is a published credential, and the fix is to revoke it, not ' +
          'to delete the line. Credentials reach the server only as ' +
          '"${user_config.<KEY>}" references, answered at enable time and stored in the ' +
          `keychain. Offending value: ${JSON.stringify(value.slice(0, 24))}…`,
      );
    }
  }
});

test('no credential prompt ships a default, and every default is a plain settings value', () => {
  for (const [key, option] of Object.entries(userConfigBlock())) {
    if (option.default === undefined) continue;
    // A committed default for a credential *is* a committed credential: the plugin
    // manifest is served from a public git repository.
    assert.ok(
      !isCredential(key),
      `${PLUGIN_FILE} userConfig.${key} carries a credential and must never declare a ` +
        '"default" — the manifest is public, so the value would be published verbatim and ' +
        "prefilled into every operator's prompt",
    );
    assert.ok(
      typeof option.default !== 'string' || !looksLikeSecret(option.default),
      `${PLUGIN_FILE} userConfig.${key}.default is token-shaped`,
    );
  }
});
