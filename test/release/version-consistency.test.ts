/**
 * Release gate: four-channel version-drift test (workplan T-R7).
 *
 * `package.json` is the single source of truth for the version. Three other
 * distribution manifests each carry their own copy of it that must never drift:
 *
 *   1. `package.json`            — npm (source of truth)
 *   2. `server.json`             — MCP registry (T-R5)
 *   3. `manifest.json`           — MCPB bundle for Claude Desktop (T-R6)
 *   4. `.claude-plugin/plugin.json` — Claude Code plugin (M5)
 *
 * This test reads all four from the repo root and asserts they agree on both
 * version and package/server identity. The Claude Code plugin additionally pins
 * the npm version it launches via `npx`, so that pin is checked too — otherwise a
 * released plugin could silently serve a different version than it declares.
 *
 * A fifth file carries the version without being a channel of its own:
 * `.claude-plugin/marketplace.json` is the catalog `/plugin marketplace add`
 * reads, and its `plugins[]` entry repeats the plugin's version. It is checked
 * here for the same reason as the `npx` pin — it is a copy of the version that a
 * release can leave behind, and the copy is the one users see in the install
 * listing before anything is fetched.
 *
 * The test process runs from the repo root (`npm test` -> `node --test` with
 * cwd = repo root), so the files resolve from `process.cwd()`. If cwd does not
 * hold a `package.json` (e.g. the compiled test is invoked directly from
 * elsewhere), the repo root is instead found by walking up from this file's own
 * location.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The npm package name (`package.json.name`). */
const PACKAGE_NAME = 'instagram-mcp-ai';
/** The MCP-registry server name (`server.json.name`, reverse-DNS). */
const REGISTRY_NAME = 'io.github.IvanBBaev/instagram-mcp-ai';

/** True for a plain JSON object (not `null`, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Locate the repo root: the nearest directory containing a `package.json`. Prefer
 * `process.cwd()` (the test runner's working directory); otherwise walk up from
 * this compiled test's own directory to the filesystem root.
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

/** The Claude Code plugin manifest, relative to the repo root. */
const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json');
/** The Claude Code marketplace catalog, relative to the repo root. */
const MARKETPLACE_MANIFEST = join('.claude-plugin', 'marketplace.json');
/**
 * The marketplace's own name — deliberately NOT the plugin name. Installing takes
 * both: `/plugin marketplace add IvanBBaev/instagram-mcp` registers the catalog
 * under this name, then `/plugin install instagram-mcp-ai@instagram-mcp` names
 * the plugin inside it. Collapsing the two strings into one would make the second
 * command read `instagram-mcp-ai@instagram-mcp-ai`, which is why they differ.
 */
const MARKETPLACE_NAME = 'instagram-mcp';

/** Read + parse a JSON file from the repo root; fail clearly if it is absent. */
function readRepoJson(file: string): Record<string, unknown> {
  const path = join(repoRoot, file);
  if (!existsSync(path)) {
    throw new Error(
      `${file} not found at ${path} — it is one of the four release channels ` +
        `(package.json, server.json, manifest.json, .claude-plugin/plugin.json) ` +
        `and MUST exist for the release lane to be complete.`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${file} did not parse to a JSON object`);
  }
  return parsed;
}

/** An npm package specifier from the plugin's `npx` args, split into its parts. */
interface PackageSpec {
  /** The raw argument, e.g. `instagram-mcp-ai@1.2.3`. */
  raw: string;
  /** The pin after `@`, or `null` when the arg carries no pin at all. */
  pin: string | null;
}

/**
 * Find the arg that names the npm package and split off its pin.
 *
 * Matching is structural (`<name>` or `<name>@<pin>`) rather than a compare
 * against a pre-built `name@version` string: an exact compare collapses every
 * failure into "not found", which cannot tell a stale pin apart from a missing
 * one or from a floating dist-tag. Parsing lets the assertions name the drift.
 *
 * Returns `null` when no argument names the package.
 */
function findPackageSpec(args: readonly unknown[]): PackageSpec | null {
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    if (arg === PACKAGE_NAME) return { raw: arg, pin: null };
    if (arg.startsWith(`${PACKAGE_NAME}@`)) {
      return { raw: arg, pin: arg.slice(PACKAGE_NAME.length + 1) };
    }
  }
  return null;
}

test('package.json is the single source of truth for name and version', () => {
  const pkg = readRepoJson('package.json');
  assert.equal(pkg.name, PACKAGE_NAME, 'package.json.name must be the npm package name');
  assert.equal(typeof pkg.version, 'string', 'package.json.version must be a string');
  assert.ok((pkg.version as string).length > 0, 'package.json.version must be non-empty');
});

test('server.json carries the registry name and matches the source-of-truth version', () => {
  const pkg = readRepoJson('package.json');
  const server = readRepoJson('server.json');

  assert.equal(server.name, REGISTRY_NAME, 'server.json.name must be the MCP-registry name');
  assert.equal(server.version, pkg.version, 'server.json.version must equal package.json.version');

  // The registry schema repeats the version inside packages[]; keep it in lockstep.
  const packages = server.packages;
  if (Array.isArray(packages)) {
    for (const entry of packages) {
      if (isRecord(entry) && 'version' in entry) {
        assert.equal(
          entry.version,
          pkg.version,
          'server.json packages[].version must equal package.json.version',
        );
      }
    }
  }
});

test('manifest.json (MCPB) matches the source-of-truth version and a consistent name', () => {
  const pkg = readRepoJson('package.json');
  const manifest = readRepoJson('manifest.json');

  assert.equal(
    manifest.version,
    pkg.version,
    'manifest.json.version must equal package.json.version',
  );

  // The MCPB manifest name must be consistent with the package identity — either
  // the npm package name or the reverse-DNS registry name, never anything else.
  assert.ok(
    manifest.name === PACKAGE_NAME || manifest.name === REGISTRY_NAME,
    `manifest.json.name (${String(manifest.name)}) must be "${PACKAGE_NAME}" or "${REGISTRY_NAME}"`,
  );
});

test('plugin.json (Claude Code) matches the source-of-truth version and identity', () => {
  const pkg = readRepoJson('package.json');
  const plugin = readRepoJson(PLUGIN_MANIFEST);

  assert.equal(
    plugin.version,
    pkg.version,
    `${PLUGIN_MANIFEST} drift site 1 of 2 — the "version" field is ` +
      `${JSON.stringify(plugin.version)} but package.json.version is ` +
      `${JSON.stringify(pkg.version)}; bump the field to match`,
  );
  assert.equal(
    plugin.name,
    PACKAGE_NAME,
    `${PLUGIN_MANIFEST}.name must be the npm package name (Claude Code plugin names are kebab-case)`,
  );
  assert.equal(plugin.license, pkg.license, `${PLUGIN_MANIFEST}.license must equal package.json`);
  assert.equal(
    plugin.description,
    pkg.description,
    `${PLUGIN_MANIFEST}.description must equal package.json`,
  );
  assert.equal(
    plugin.homepage,
    pkg.homepage,
    `${PLUGIN_MANIFEST}.homepage must equal package.json`,
  );
});

test('plugin.json pins the same npm version it declares', () => {
  const pkg = readRepoJson('package.json');
  const plugin = readRepoJson(PLUGIN_MANIFEST);

  // The plugin is installed from git, so it launches the server through `npx`
  // against the published npm package. That pin is a fifth copy of the version in
  // all but name: if it drifts, users get a build the manifest never described.
  const servers = plugin.mcpServers;
  assert.ok(isRecord(servers), `${PLUGIN_MANIFEST}.mcpServers must be an inline server map`);

  const entries = Object.values(servers);
  assert.equal(entries.length, 1, `${PLUGIN_MANIFEST} should declare exactly one MCP server`);

  const server = entries[0];
  assert.ok(isRecord(server), 'the declared MCP server must be an object');
  assert.equal(server.type, 'stdio', 'the MCP server must use the stdio transport');
  assert.equal(server.command, 'npx', 'the MCP server must launch through npx');

  const args = server.args;
  assert.ok(Array.isArray(args), 'the MCP server must pass args to npx');

  const spec = findPackageSpec(args);
  assert.ok(
    spec !== null,
    `${PLUGIN_MANIFEST} drift site 2 of 2 — no npx arg names "${PACKAGE_NAME}", ` +
      `so the plugin launches something else entirely; got ${JSON.stringify(args)}`,
  );
  assert.ok(
    spec.pin !== null,
    `${PLUGIN_MANIFEST} drift site 2 of 2 — the npx arg "${spec.raw}" carries no pin; ` +
      `it must be "${PACKAGE_NAME}@${String(pkg.version)}" so the plugin cannot install ` +
      `whatever npm happens to serve that day`,
  );
  // A dist-tag (`@latest`, `@next`) is not a version either; it fails here too,
  // which is the point — the pin has to be the exact released version.
  assert.equal(
    spec.pin,
    pkg.version,
    `${PLUGIN_MANIFEST} drift site 2 of 2 — the npx arg pins ` +
      `"${PACKAGE_NAME}@${String(spec.pin)}" but package.json.version is ` +
      `${JSON.stringify(pkg.version)}; bump mcpServers[].args, not just the "version" field`,
  );
});

test('marketplace.json lists this plugin at the source-of-truth version', () => {
  const pkg = readRepoJson('package.json');
  const marketplace = readRepoJson(MARKETPLACE_MANIFEST);

  assert.equal(
    marketplace.name,
    MARKETPLACE_NAME,
    `${MARKETPLACE_MANIFEST}.name is the catalog name used in ` +
      `\`/plugin install <plugin>@<marketplace>\` — changing it breaks the install ` +
      `command documented in docs/plugin-install.md`,
  );

  const plugins = marketplace.plugins;
  assert.ok(Array.isArray(plugins), `${MARKETPLACE_MANIFEST}.plugins must be an array`);
  assert.equal(
    plugins.length,
    1,
    `${MARKETPLACE_MANIFEST} should list exactly this repo's single plugin`,
  );

  const entry = plugins[0];
  assert.ok(isRecord(entry), `${MARKETPLACE_MANIFEST}.plugins[0] must be an object`);
  assert.equal(
    entry.name,
    PACKAGE_NAME,
    `${MARKETPLACE_MANIFEST}.plugins[0].name must match plugin.json.name — it is the ` +
      `left half of the install specifier`,
  );
  assert.equal(
    entry.source,
    './',
    `${MARKETPLACE_MANIFEST}.plugins[0].source must be "./" — the marketplace root is ` +
      `the directory holding .claude-plugin/, i.e. the repo root`,
  );
  assert.equal(
    entry.version,
    pkg.version,
    `${MARKETPLACE_MANIFEST} drift site — plugins[0].version is ` +
      `${JSON.stringify(entry.version)} but package.json.version is ` +
      `${JSON.stringify(pkg.version)}; this is the version shown in the install ` +
      `listing, so a stale copy misinforms users before anything is fetched`,
  );
});

test('marketplace.json and plugin.json describe the same plugin', () => {
  const plugin = readRepoJson(PLUGIN_MANIFEST);
  const marketplace = readRepoJson(MARKETPLACE_MANIFEST);
  const plugins = marketplace.plugins;
  assert.ok(Array.isArray(plugins) && isRecord(plugins[0]), 'marketplace must list a plugin');
  const entry = plugins[0];

  // The catalog entry is what users read when choosing; the plugin manifest is what
  // they get. Divergence here is a listing that advertises something else.
  for (const field of ['description', 'homepage', 'repository', 'license'] as const) {
    assert.equal(
      entry[field],
      plugin[field],
      `${MARKETPLACE_MANIFEST}.plugins[0].${field} must equal ${PLUGIN_MANIFEST}.${field}`,
    );
  }
});

test('all four channels agree on a single version (single source of truth)', () => {
  const pkgVersion = readRepoJson('package.json').version;
  const serverVersion = readRepoJson('server.json').version;
  const manifestVersion = readRepoJson('manifest.json').version;
  const pluginVersion = readRepoJson(PLUGIN_MANIFEST).version;

  assert.equal(serverVersion, pkgVersion, 'server.json version must equal package.json version');
  assert.equal(
    manifestVersion,
    pkgVersion,
    'manifest.json version must equal package.json version',
  );
  assert.equal(
    pluginVersion,
    pkgVersion,
    `${PLUGIN_MANIFEST} version must equal package.json version`,
  );
});
