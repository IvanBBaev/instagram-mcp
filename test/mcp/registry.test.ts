/**
 * Unit tests for the tool registry (src/mcp/registry.ts).
 *
 * `buildManifest` / `selectPackages` are pure and tested directly. Registration
 * is tested through a fake `McpServer` that records `registerTool(name, config,
 * cb)` calls — no real SDK server needed. The snapshot test runs over the real
 * `allTools` surface so any change to the tool set shows up in the diff; the
 * behavioral tests build minimal fake `ToolSpec`s so they never touch the api/
 * layer or the HTTP client.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  buildManifest,
  selectPackages,
  registerTools,
  serverConfirmer,
  PACKAGE_PROFILES,
  READONLY_PROFILES,
  type PackageManifest,
  type RegisterToolsDeps,
} from '../../src/mcp/registry.js';
import {
  CONFIRM_TIMEOUT_MS,
  type ConfirmPrompt,
  type WriteConfirmer,
  type WriteGateContext,
} from '../../src/mcp/write-mode.js';
import type { ToolAnnotationSet, ToolContext, ToolResult, ToolSpec } from '../../src/mcp/define.js';
import { text } from '../../src/mcp/result.js';
import { InstagramError, isInstagramError } from '../../src/core/types.js';
import { REDACTED, registerSecret } from '../../src/core/redact.js';
import type { IgRequestFn, Logger, ResolvedProfile, Settings } from '../../src/core/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { allTools } from '../../src/tools/index.js';
import { testSettings } from '../helpers/settings.js';

// --- Shared fakes ----------------------------------------------------------

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
};

const baseSettings: Settings = testSettings();

const igProfile: ResolvedProfile = { name: 'default', authPath: 'ig-login', accessToken: 'tok' };
const fbProfile: ResolvedProfile = {
  name: 'default',
  authPath: 'fb-login',
  accessToken: 'tok',
  appId: 'app',
  appSecret: 'secret',
};

interface RegisterConfig {
  title?: string;
  description?: string;
  /**
   * A **built** `ZodObject`, not a raw shape: the registry hands the SDK the
   * closed `.strict()` object so the SDK's own pre-callback validation rejects
   * unknown arguments instead of stripping them (CC-CFG-6).
   */
  inputSchema?: z.AnyZodObject;
  outputSchema?: z.ZodRawShape;
  annotations?: ToolAnnotationSet;
}
type RegisterCb = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
interface Recorded {
  name: string;
  config: RegisterConfig;
  cb: RegisterCb;
}

function fakeServer(): { server: McpServer; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const server = {
    registerTool(name: string, config: RegisterConfig, cb: RegisterCb) {
      calls.push({ name, config, cb });
      return {};
    },
  };
  return { server: server as unknown as McpServer, calls };
}

/** A request factory that records the profiles it was asked to build for. */
function makeReqFactory(): {
  makeRequest: (profile: ResolvedProfile) => IgRequestFn;
  seen: ResolvedProfile[];
} {
  const seen: ResolvedProfile[] = [];
  const req: IgRequestFn = async <T>(): Promise<T> => ({}) as T;
  return {
    seen,
    makeRequest: (profile: ResolvedProfile): IgRequestFn => {
      seen.push(profile);
      return req;
    },
  };
}

function makeDeps(over: Partial<RegisterToolsDeps> & Pick<RegisterToolsDeps, 'tools'>): {
  deps: RegisterToolsDeps;
  calls: Recorded[];
  seen: ResolvedProfile[];
} {
  const { server, calls } = fakeServer();
  const { makeRequest, seen } = makeReqFactory();
  const deps: RegisterToolsDeps = {
    server,
    profiles: [igProfile],
    defaultProfileName: 'default',
    settings: baseSettings,
    clock: fakeClock(0),
    log: noopLog,
    makeRequest,
    env: {},
    ...over,
  };
  return { deps, calls, seen };
}

/** A minimal read-only spec whose handler returns a fixed result. */
function spec(over: Partial<ToolSpec> & Pick<ToolSpec, 'name'>): ToolSpec {
  return {
    title: over.name,
    description: 'fake tool',
    package: 'account',
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {},
    handler: () => text('ok'),
    ...over,
  };
}

// --- buildManifest ---------------------------------------------------------

test('buildManifest groups every v1 package and holds the tag invariant', () => {
  const manifest = buildManifest(allTools);
  assert.deepEqual(
    manifest.map((p) => p.name),
    ['account', 'comments', 'discovery', 'insights', 'media', 'publishing'],
  );
  // Invariant: every tool in a package's list actually carries that package tag.
  for (const pkg of manifest) {
    for (const t of pkg.tools) assert.equal(t.package, pkg.name);
  }
});

test('buildManifest snapshot: package -> sorted tool names', () => {
  const manifest = buildManifest(allTools);
  const snapshot: Record<string, string[]> = {};
  for (const pkg of manifest) snapshot[pkg.name] = pkg.tools.map((t) => t.name).sort();

  assert.deepEqual(snapshot, {
    account: ['instagram_get_account', 'instagram_list_linked_accounts', 'instagram_token_status'],
    comments: [
      'instagram_create_comment',
      'instagram_delete_comment',
      'instagram_get_comment',
      'instagram_hide_comment',
      'instagram_list_comments',
      'instagram_list_tagged_media',
      'instagram_reply_to_comment',
      'instagram_unhide_comment',
    ],
    discovery: [
      'instagram_discover_business',
      'instagram_get_hashtag_media',
      'instagram_search_hashtag',
    ],
    insights: [
      'instagram_get_account_insights',
      'instagram_get_audience_demographics',
      'instagram_get_media_insights',
      'instagram_get_online_followers',
    ],
    // `instagram_set_comments_enabled` lives in tools/comments.ts but carries
    // `package: 'media'`, so the registry regroups it under media.
    media: ['instagram_get_media', 'instagram_list_media', 'instagram_set_comments_enabled'],
    publishing: [
      'instagram_create_media_container',
      'instagram_get_container_status',
      'instagram_get_publishing_limit',
      'instagram_post_image',
      'instagram_post_reel',
      'instagram_post_story',
      'instagram_publish_media',
    ],
  });
});

test('buildManifest throws on a spec with an empty package tag', () => {
  assert.throws(
    () => buildManifest([spec({ name: 'instagram_x', package: '  ' })]),
    (err: unknown) => isInstagramError(err) && err.kind === 'validation',
  );
});

test('buildManifest throws on a spec whose package tag is not a string at all', () => {
  // `package` is typed as a string, but the registry also runs for embedders
  // compiling from JS and for specs assembled at runtime. An untagged spec that
  // slipped through would land under a `""` package that no profile can select
  // and no deny list can name — silently unreachable rather than loudly wrong.
  for (const bad of [undefined, null, 42, {}]) {
    assert.throws(
      () => buildManifest([spec({ name: 'instagram_x', package: bad as string })]),
      (err: unknown) =>
        isInstagramError(err) && err.kind === 'validation' && /empty package tag/.test(err.message),
      `package=${JSON.stringify(bad)} must be rejected`,
    );
  }
});

// --- selectPackages --------------------------------------------------------

const v1Manifest: PackageManifest[] = buildManifest(allTools);

test('selectPackages: core (default) selects the core-profile packages (discovery ships dark)', () => {
  const { active, readonly } = selectPackages(v1Manifest, {});
  assert.deepEqual([...active].sort(), ['account', 'comments', 'insights', 'media', 'publishing']);
  assert.equal(readonly.size, 0);
});

test('selectPackages: explicit comma list selects exactly those packages', () => {
  const { active } = selectPackages(v1Manifest, { IG_TOOL_PACKAGES: 'media,insights' });
  assert.deepEqual([...active].sort(), ['insights', 'media']);
});

test('selectPackages: all selects every package in the manifest', () => {
  const { active } = selectPackages(v1Manifest, { IG_TOOL_PACKAGES: 'all' });
  assert.deepEqual([...active].sort(), [
    'account',
    'comments',
    'discovery',
    'insights',
    'media',
    'publishing',
  ]);
});

test('selectPackages: IG_PACKAGES_DENY removes a package after profile resolution', () => {
  const { active } = selectPackages(v1Manifest, {
    IG_TOOL_PACKAGES: 'all',
    IG_PACKAGES_DENY: 'insights',
  });
  assert.deepEqual([...active].sort(), ['account', 'comments', 'discovery', 'media', 'publishing']);
});

test('selectPackages: IG_PACKAGES_READONLY is surfaced as the readonly set', () => {
  const { readonly } = selectPackages(v1Manifest, { IG_PACKAGES_READONLY: 'media' });
  assert.ok(readonly.has('media'));
});

test('selectPackages: an unknown explicit package name throws a clear validation error', () => {
  assert.throws(
    () => selectPackages(v1Manifest, { IG_TOOL_PACKAGES: 'account,bogus' }),
    (err: unknown) =>
      isInstagramError(err) && err.kind === 'validation' && /bogus/.test(err.message),
  );
});

test('selectPackages: a name that is merely a PREFIX of a real package is still unknown', () => {
  // Validating by prefix would accept `med`, then activate a package by that
  // name that the manifest has nothing under — a silently empty tool surface
  // instead of the clear startup error the operator needs.
  assert.throws(
    () => selectPackages(v1Manifest, { IG_TOOL_PACKAGES: 'med' }),
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'validation' &&
      /unknown package 'med'/.test(err.message),
  );
});

test('selectPackages: every env list is matched case-insensitively', () => {
  const explicit = selectPackages(v1Manifest, { IG_TOOL_PACKAGES: 'Account, MEDIA' });
  assert.deepEqual([...explicit.active].sort(), ['account', 'media']);

  const { active, readonly } = selectPackages(v1Manifest, {
    IG_TOOL_PACKAGES: 'core',
    IG_PACKAGES_DENY: 'Publishing',
    IG_PACKAGES_READONLY: 'COMMENTS',
  });
  assert.equal(active.has('publishing'), false, 'IG_PACKAGES_DENY must still deny');
  assert.ok(readonly.has('comments'), 'IG_PACKAGES_READONLY must still mask');
});

test('selectPackages: an Object.prototype key is not a profile and fails validation', () => {
  // `Object.freeze` keeps the prototype, so a bare `key in PACKAGE_PROFILES`
  // check would accept these and hand the profile branch a function.
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.throws(
      () => selectPackages(v1Manifest, { IG_TOOL_PACKAGES: key }),
      (err: unknown) =>
        isInstagramError(err) &&
        err.kind === 'validation' &&
        err.message.includes('unknown package'),
      `IG_TOOL_PACKAGES=${key} must be rejected as an unknown package`,
    );
  }
});

// --- read-only profiles (the `reader` profile is a boundary, not a hint) ----

test('selectPackages: the reader profile forces every package it selects read-only', () => {
  const { active, readonly } = selectPackages(v1Manifest, { IG_TOOL_PACKAGES: 'reader' });
  assert.deepEqual([...active].sort(), ['account', 'comments', 'discovery', 'insights', 'media']);
  for (const pkg of active) {
    assert.ok(readonly.has(pkg), `reader must force '${pkg}' read-only`);
  }
});

test('selectPackages: a read-only profile still honours IG_PACKAGES_DENY', () => {
  const { active, readonly } = selectPackages(v1Manifest, {
    IG_TOOL_PACKAGES: 'reader',
    IG_PACKAGES_DENY: 'discovery',
  });
  assert.equal(active.has('discovery'), false);
  assert.deepEqual([...active].sort(), ['account', 'comments', 'insights', 'media']);
  for (const pkg of active) assert.ok(readonly.has(pkg));
});

test('selectPackages: a writable profile is NOT forced read-only', () => {
  for (const profile of ['core', 'publisher', 'all']) {
    const { readonly } = selectPackages(v1Manifest, { IG_TOOL_PACKAGES: profile });
    assert.equal(readonly.size, 0, `${profile} must not be forced read-only`);
  }
});

test('selectPackages: an explicit list matching the reader packages is NOT forced read-only', () => {
  // Only the named profile carries the guarantee; an explicit list is the
  // operator spelling out packages and keeps its write tools.
  const { readonly } = selectPackages(v1Manifest, {
    IG_TOOL_PACKAGES: (PACKAGE_PROFILES.reader ?? []).join(','),
  });
  assert.equal(readonly.size, 0);
});

test('selectPackages: a profile only activates packages the manifest actually has', () => {
  // A profile lists a curated *universe*, deliberately including packages that
  // may not have shipped yet (that is why `reader` can name `discovery`). The
  // intersection with the manifest is what keeps that forward-compatible: drop
  // it and a package name with no tools behind it lands in `active`, so the
  // deny/read-only sets and the "available packages: …" error text describe a
  // surface that does not exist. An embedder registering a subset — the whole
  // point of the injected `tools` dep — is the case that hits this first.
  const tiny: PackageManifest[] = [{ name: 'account', tools: [] }];
  const { active, readonly } = selectPackages(tiny, { IG_TOOL_PACKAGES: 'reader' });
  assert.deepEqual([...active], ['account']);
  // ...and the read-only forcing follows the intersected set, not the universe.
  assert.deepEqual([...readonly], ['account']);
});

test('selectPackages: the read-only profile check is case-insensitive (IG_TOOL_PACKAGES=Reader)', () => {
  // Package selection lowercases before matching the profile name, so `Reader`
  // already resolves to the reader package list. If the READONLY_PROFILES check
  // does not lowercase too, the two halves disagree: the operator gets exactly
  // the reader packages and NONE of them forced read-only — the comment and
  // media write tools ship under a profile whose name promises they will not.
  // Env vars are hand-typed, so the capitalised spelling is a real deployment.
  const { active, readonly } = selectPackages(v1Manifest, { IG_TOOL_PACKAGES: 'Reader' });
  assert.deepEqual([...active].sort(), ['account', 'comments', 'discovery', 'insights', 'media']);
  assert.equal(readonly.size, active.size, 'every selected package is forced read-only');
  for (const pkg of active) assert.ok(readonly.has(pkg), `'Reader' must force '${pkg}' read-only`);
});

test("IG_TOOL_PACKAGES=Reader registers the same write-free surface as 'reader'", () => {
  // The end-to-end half of the case above: the capitalised spelling must reach
  // the same 15-tool read-only surface, not a 21-tool one with write tools.
  const { deps } = makeDeps({
    tools: allTools,
    profiles: [fbProfile],
    env: { IG_TOOL_PACKAGES: 'Reader' },
  });
  const { registered } = registerTools(deps);
  const byName = new Map(allTools.map((t) => [t.name, t]));

  assert.equal(registered.length, 15, 'reader exposes 15 read-only tools (README table)');
  for (const name of registered) {
    assert.equal(byName.get(name)?.annotations.readOnlyHint, true, `'${name}' is not read-only`);
  }
});

test('READONLY_PROFILES names only profiles that exist in PACKAGE_PROFILES', () => {
  for (const name of READONLY_PROFILES) {
    assert.ok(Object.hasOwn(PACKAGE_PROFILES, name), `${name} must be a real profile`);
  }
});

test('IG_TOOL_PACKAGES=reader registers a write-free surface (no write/destructive tool)', () => {
  // fb-login so the Path-B-only discovery tools survive D1 filtering too.
  const { deps } = makeDeps({
    tools: allTools,
    profiles: [fbProfile],
    env: { IG_TOOL_PACKAGES: 'reader' },
  });
  const { registered } = registerTools(deps);
  const byName = new Map(allTools.map((t) => [t.name, t]));

  for (const name of registered) {
    const found = byName.get(name);
    assert.ok(found, `${name} must be a known tool`);
    assert.equal(
      found.annotations.readOnlyHint,
      true,
      `'${name}' is registered under the reader profile but is not read-only`,
    );
    assert.notEqual(
      found.annotations.destructiveHint,
      true,
      `'${name}' is destructive and must never be registered under the reader profile`,
    );
  }

  // The comment/media write tools are the concrete regression: they live in
  // packages the reader profile selects for their READ tools.
  for (const name of [
    'instagram_create_comment',
    'instagram_reply_to_comment',
    'instagram_hide_comment',
    'instagram_unhide_comment',
    'instagram_delete_comment',
    'instagram_set_comments_enabled',
  ]) {
    assert.equal(registered.includes(name), false, `reader must not expose '${name}'`);
  }

  // ...while the read tools of those same packages are still there (the fix
  // filters tools, it does not drop whole packages).
  for (const name of [
    'instagram_list_comments',
    'instagram_get_comment',
    'instagram_list_tagged_media',
    'instagram_list_media',
    'instagram_get_media',
    'instagram_discover_business',
  ]) {
    assert.ok(registered.includes(name), `reader must still expose '${name}'`);
  }

  assert.equal(registered.length, 15, 'reader exposes 15 read-only tools (README table)');
});

// --- D1 capability filtering ----------------------------------------------

test('D1: a fb-login-only tool IS registered when the active profile is fb-login', () => {
  const linked = spec({ name: 'instagram_list_linked_accounts', paths: ['fb-login'] });
  const { deps, calls } = makeDeps({ tools: [linked], profiles: [fbProfile] });
  const { registered } = registerTools(deps);
  assert.deepEqual(registered, ['instagram_list_linked_accounts']);
  assert.equal(calls.length, 1);
});

test('D1: a fb-login-only tool is NOT registered when the active profile is ig-login', () => {
  const linked = spec({ name: 'instagram_list_linked_accounts', paths: ['fb-login'] });
  const both = spec({ name: 'instagram_get_account' }); // paths undefined -> both paths
  const { deps, calls } = makeDeps({ tools: [linked, both], profiles: [igProfile] });
  const { registered } = registerTools(deps);
  assert.deepEqual(registered, ['instagram_get_account']);
  assert.deepEqual(
    calls.map((c) => c.name),
    ['instagram_get_account'],
  );
});

test('D1: a fb-login-only tool IS registered when a NON-default profile is on fb-login', async () => {
  // Default profile on Path A, a second profile on Path B. Filtering by the
  // default profile alone would hide the tool even though 'brand' can run it.
  const brand: ResolvedProfile = {
    name: 'brand',
    authPath: 'fb-login',
    accessToken: 'tok2',
    appId: 'app',
    appSecret: 'secret',
  };
  const discover = spec({
    name: 'instagram_discover_business',
    package: 'discovery',
    paths: ['fb-login'],
  });
  const { deps, calls } = makeDeps({
    tools: [discover],
    profiles: [igProfile, brand],
    env: { IG_TOOL_PACKAGES: 'all' },
  });

  const { registered } = registerTools(deps);
  assert.deepEqual(registered, ['instagram_discover_business']);

  // It runs for the profile that can reach Path B...
  const ok = await calls[0]!.cb({ account: 'brand' });
  assert.equal(ok.isError, undefined);

  // ...and the call-time guard still rejects the Path A default profile.
  const bad = await calls[0]!.cb({});
  assert.equal(bad.isError, true);
  assert.ok(String(bad.content[0]?.text).includes('ig-login'), 'names the wrong auth path');
});

test('D1: a fb-login-only tool stays hidden when NO configured profile is on fb-login', () => {
  const other: ResolvedProfile = { name: 'brand', authPath: 'ig-login', accessToken: 'tok2' };
  const discover = spec({
    name: 'instagram_discover_business',
    package: 'discovery',
    paths: ['fb-login'],
  });
  const { deps } = makeDeps({
    tools: [discover],
    profiles: [igProfile, other],
    env: { IG_TOOL_PACKAGES: 'all' },
  });
  assert.deepEqual(registerTools(deps).registered, []);
});

test('D1: a tool that declares BOTH paths registers when only one of them is configured', () => {
  // `paths: ['ig-login', 'fb-login']` is an explicit "either path runs this",
  // which is not the same as omitting `paths` — a spec may spell out both to
  // document the fact. The filter must therefore keep a tool when ANY configured
  // profile can reach one of its paths; requiring all of them would hide such a
  // tool from every single-path deployment, which is the overwhelmingly common
  // one, and the tool would simply not appear in tools/list with no diagnostic.
  const both = spec({ name: 'instagram_get_account', paths: ['ig-login', 'fb-login'] });
  const { deps, calls } = makeDeps({ tools: [both], profiles: [igProfile] });
  assert.deepEqual(registerTools(deps).registered, ['instagram_get_account']);
  assert.equal(calls.length, 1);
});

test('registerTools fails fast when the default profile does not exist', () => {
  // `IG_ACTIVE_PROFILE=brnad` (a typo) otherwise produces a server that starts
  // clean, advertises all 28 tools, and fails EVERY call — the misconfiguration
  // surfaces once per tool call as a validation error instead of once at boot.
  // The check belongs at registration because that is where it is still cheap
  // to abort; the message has to name the bad value and the real ones.
  const { deps } = makeDeps({
    tools: [spec({ name: 'instagram_get_account' })],
    profiles: [igProfile],
    defaultProfileName: 'brnad',
  });
  assert.throws(
    () => registerTools(deps),
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'validation' &&
      /Unknown account profile 'brnad'/.test(err.message) &&
      /configured profiles: default/.test(err.message),
  );
});

test('registerTools hands the SDK each spec description and annotation set verbatim', () => {
  // Both are the tool's entire contract for a model that has never seen this
  // server: the description is how it picks the tool, the annotations are how a
  // client decides whether the call needs a human. Dropping either registers a
  // tool that still works and is no longer safely usable.
  const reader = spec({ name: 'instagram_ro', description: 'read side' });
  const writer = spec({
    name: 'instagram_rw',
    description: 'write side',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  });
  const { deps, calls } = makeDeps({ tools: [reader, writer] });
  registerTools(deps);

  const byName = new Map(calls.map((c) => [c.name, c.config]));
  assert.equal(byName.get('instagram_ro')?.description, 'read side');
  assert.equal(byName.get('instagram_rw')?.description, 'write side');
  assert.deepEqual(byName.get('instagram_ro')?.annotations, {
    readOnlyHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(byName.get('instagram_rw')?.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });
});

// --- account auto-injection & strict re-validation -------------------------

test('account selector is injected and the registered schema is CLOSED, not a raw shape', () => {
  const t = spec({ name: 'instagram_get_account', input: { fields: z.string().optional() } });
  const { deps, calls } = makeDeps({ tools: [t] });
  registerTools(deps);

  const schema = calls[0]?.config.inputSchema;
  assert.ok(schema, 'inputSchema present');
  assert.ok('account' in schema.shape, 'account field injected');

  // Asserted on the very object the SDK receives. Before the CC-CFG-6 fix this
  // was a raw `z.ZodRawShape`, which the SDK re-wrapped as a NON-strict
  // `z.object(shape)` and used to strip unknown keys before our callback ran —
  // so the wrapper's own `.strict()` re-parse could never fire.
  assert.equal(schema.safeParse({ account: 'brand' }).success, true);
  assert.equal(schema.safeParse({}).success, true);
  assert.equal(schema.safeParse({ bogus: 1 }).success, false, 'the schema itself is strict');

  // The curated message rides on the schema's error map, so it survives being
  // raised inside the SDK rather than inside our wrapper.
  const failure = schema.safeParse({ bogus: 1, alsoBogus: 2 });
  assert.equal(failure.success, false);
  const message = failure.success ? '' : (failure.error.issues[0]?.message ?? '');
  assert.ok(message.includes('bogus'), 'names the unknown keys');
  assert.ok(message.includes('alsoBogus'), 'names every unknown key');
  assert.ok(message.includes('fields'), 'lists the valid keys');
  assert.ok(message.includes('account'), 'lists the injected account selector');
});

test('strict re-validation rejects an unknown argument at call time (CC-CFG-6)', async () => {
  const t = spec({ name: 'instagram_get_account', input: {} });
  const { deps, calls } = makeDeps({ tools: [t] });
  registerTools(deps);

  const res = await calls[0]!.cb({ bogus: 1 });
  assert.equal(res.isError, true);
  assert.ok(res.content[0]?.text.includes('bogus'), 'names the unknown key');
});

// --- CC-CFG-6 end to end, against a REAL McpServer -------------------------

/**
 * Everything above registers against a *fake* registrar, which is exactly why
 * CC-CFG-6 could be false for so long: the fake hands `cb` the raw arguments,
 * so the wrapper's `.strict()` re-parse always saw the unknown key. A real
 * `McpServer` does not. It validates `request.params.arguments` itself in
 * `validateToolInput()` and passes the *parsed* value to the callback — and
 * when it is handed a raw `ZodRawShape` it rebuilds it as a non-strict
 * `z.object(shape)` (`server/zod-compat.js` `normalizeObjectSchema` ->
 * `objectFromShape`), which silently strips unknown keys. The tests below are
 * the ones that can actually observe that, so they drive a real server through
 * a real `Client` over `InMemoryTransport`.
 */
async function liveServer(
  tools: ToolSpec[],
  over: Partial<RegisterToolsDeps> = {},
): Promise<{ client: Client; registered: string[]; close: () => Promise<void> }> {
  const server = new McpServer({ name: 'instagram-mcp-ai-test', version: '0.0.0' });
  const { makeRequest } = makeReqFactory();
  const { registered } = registerTools({
    server,
    tools,
    profiles: [igProfile],
    defaultProfileName: 'default',
    settings: baseSettings,
    clock: fakeClock(0),
    log: noopLog,
    makeRequest,
    env: {},
    ...over,
  });

  const client = new Client({ name: 'registry-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    registered,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * Flatten a `tools/call` result's text content. Typed `unknown` because the
 * SDK client returns a union with the legacy `{ toolResult }` shape.
 */
function resultText(res: unknown): string {
  const raw = (res as { content?: unknown }).content;
  const content = Array.isArray(raw) ? (raw as { text?: unknown }[]) : [];
  return content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
}

test('real McpServer: an unknown argument is REJECTED, never dropped (CC-CFG-6)', async () => {
  const t = spec({
    name: 'instagram_get_account',
    input: { fields: z.string().optional() },
    handler: () => text('HANDLER-RAN'),
  });
  const live = await liveServer([t]);
  try {
    const res = await live.client.callTool({
      name: 'instagram_get_account',
      arguments: { bogus: 42 },
    });

    assert.equal(res.isError, true, 'unknown args must be rejected, not silently dropped');
    const body = resultText(res);
    assert.equal(body.includes('HANDLER-RAN'), false, 'the handler must never have run');
    // The curated message survives the SDK raising the error instead of us.
    assert.ok(body.includes('bogus'), `names the unknown key: ${body}`);
    assert.ok(body.includes('fields'), `lists the valid keys: ${body}`);
    assert.ok(body.includes('account'), `lists the injected selector: ${body}`);
    assert.ok(body.includes('instagram_get_account'), `names the tool: ${body}`);
  } finally {
    await live.close();
  }
});

test('real McpServer: valid arguments still reach the handler untouched', async () => {
  const brand: ResolvedProfile = { name: 'brand', authPath: 'ig-login', accessToken: 'tok2' };
  let seen: Record<string, unknown> | undefined;
  const t = spec({
    name: 'instagram_get_account',
    input: { fields: z.string().optional() },
    handler: (args) => {
      seen = args;
      return text('ok');
    },
  });
  const live = await liveServer([t], { profiles: [igProfile, brand] });
  try {
    const res = await live.client.callTool({
      name: 'instagram_get_account',
      arguments: { fields: 'id,username', account: 'brand' },
    });
    assert.equal(res.isError, undefined);
    assert.equal(resultText(res), 'ok');
    assert.deepEqual(seen, { fields: 'id,username', account: 'brand' });
  } finally {
    await live.close();
  }
});

test('real McpServer: tools/list publishes a closed schema with the account selector', async () => {
  const t = spec({
    name: 'instagram_get_media',
    input: { mediaId: z.string().describe('The media id.') },
    output: { id: z.string() },
  });
  const live = await liveServer([t]);
  try {
    const { tools } = await live.client.listTools();
    assert.equal(tools.length, 1);
    const listed = tools[0]!;
    assert.deepEqual(listed.inputSchema, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        mediaId: { type: 'string', description: 'The media id.' },
        account: {
          type: 'string',
          minLength: 1,
          description:
            'Name of the configured account profile to operate as (multi-account). Omit to use ' +
            'the default profile (IG_ACTIVE_PROFILE).',
        },
      },
      required: ['mediaId'],
      // The published contract has always said this; before the fix the runtime
      // did not honour it. Now the schema and the behaviour agree.
      additionalProperties: false,
    });
    // outputSchema still goes over as a raw shape and is unaffected.
    assert.deepEqual(listed.outputSchema, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  } finally {
    await live.close();
  }
});

test('real McpServer: outputSchema handling is unaffected by the strict input schema', async () => {
  const good = spec({
    name: 'instagram_get_account',
    output: { id: z.string() },
    handler: () => ({
      content: [{ type: 'text' as const, text: '{"id":"1"}' }],
      structuredContent: { id: '1' },
    }),
  });
  const bad = spec({
    name: 'instagram_get_media',
    output: { id: z.string() },
    // Violates its own declared output schema: the SDK must still catch it.
    handler: () => ({
      content: [{ type: 'text' as const, text: '{}' }],
      structuredContent: { id: 7 },
    }),
  });
  const live = await liveServer([good, bad]);
  try {
    const ok = await live.client.callTool({ name: 'instagram_get_account', arguments: {} });
    assert.equal(ok.isError, undefined);
    assert.deepEqual(ok.structuredContent, { id: '1' });

    const nope = await live.client.callTool({ name: 'instagram_get_media', arguments: {} });
    assert.equal(nope.isError, true);
    assert.ok(resultText(nope).includes('Output validation error'));
  } finally {
    await live.close();
  }
});

test('real McpServer: a type error on a declared field still reports the field path', async () => {
  const t = spec({ name: 'instagram_get_media', input: { mediaId: z.string() } });
  const live = await liveServer([t]);
  try {
    const res = await live.client.callTool({
      name: 'instagram_get_media',
      arguments: { mediaId: 42 },
    });
    assert.equal(res.isError, true);
    const body = resultText(res);
    assert.ok(body.includes('mediaId'), `names the offending field: ${body}`);
    assert.ok(body.includes('Expected string'), `keeps zod's own wording: ${body}`);
  } finally {
    await live.close();
  }
});

test('real McpServer: omitting arguments entirely keeps zod default wording', async () => {
  // The schema-bound error map only rewrites `unrecognized_keys`; every other
  // root-level issue falls through to zod's default text, so a client that
  // sends no `arguments` at all reads exactly what it did before the fix.
  const t = spec({ name: 'instagram_get_media', input: { mediaId: z.string() } });
  const live = await liveServer([t]);
  try {
    const res = await live.client.callTool({ name: 'instagram_get_media' });
    assert.equal(res.isError, true);
    const body = resultText(res);
    assert.ok(body.includes('Required'), `zod's default wording is preserved: ${body}`);
    assert.equal(body.includes('unknown argument'), false, 'not reported as an unknown key');
  } finally {
    await live.close();
  }
});

test('the wrapper fallback renders a non-unknown-key validation failure with its path', async () => {
  // Reachable through the `ToolRegistrar` seam (a stub registrar or a direct
  // callback caller), where the SDK's own validation never ran.
  const t = spec({ name: 'instagram_get_media', input: { mediaId: z.string() } });
  const { deps, calls } = makeDeps({ tools: [t] });
  registerTools(deps);

  const res = await calls[0]!.cb({ mediaId: 42 });
  assert.equal(res.isError, true);
  const body = res.content[0]?.text ?? '';
  assert.ok(body.includes('instagram_get_media'), `names the tool: ${body}`);
  assert.ok(body.includes('mediaId'), `names the field path: ${body}`);
  assert.equal(res.structuredContent?.error !== undefined, true, 'keeps the error envelope');
});

test('the wrapper fallback labels a root-level failure `(root)` rather than an empty path', async () => {
  // Same `ToolRegistrar` seam: an embedder that hands the callback a scalar
  // instead of an arguments object produces a zod issue whose `path` is empty.
  // Joining it yields "", so the message would read ": Expected object,
  // received number" — a stray colon that names nothing. `(root)` says where.
  const t = spec({ name: 'instagram_get_account', input: { note: z.string() } });
  const { deps, calls } = makeDeps({ tools: [t] });
  registerTools(deps);

  const res = await calls[0]!.cb(42 as unknown as Record<string, unknown>);

  assert.equal(res.isError, true);
  const body = res.content[0]?.text ?? '';
  assert.ok(body.includes('(root)'), `labels the root issue: ${body}`);
  assert.equal(body.includes(': : '), false, 'and never renders an empty path');
  assert.ok(body.includes('instagram_get_account'), 'still names the tool');
});

test('real McpServer: the whole v1 surface registers, lists and stays closed', async () => {
  // `all` + a Path-B profile keeps every tool past D1 filtering, so this is the
  // full 28-tool surface end to end on a real server.
  const live = await liveServer(allTools, {
    profiles: [fbProfile],
    env: { IG_TOOL_PACKAGES: 'all' },
  });
  try {
    assert.equal(live.registered.length, allTools.length, 'every v1 tool registers');
    assert.equal(allTools.length, 28, 'the v1 surface is 28 tools');

    const { tools } = await live.client.listTools();
    assert.deepEqual([...tools.map((t) => t.name)].sort(), [...live.registered].sort());

    for (const listed of tools) {
      const schema = listed.inputSchema as {
        additionalProperties?: unknown;
        properties?: Record<string, unknown>;
      };
      assert.equal(
        schema.additionalProperties,
        false,
        `${listed.name} must publish a closed input schema`,
      );
      assert.ok(schema.properties?.account, `${listed.name} must expose the account selector`);
    }

    // And the enforcement is real for a tool picked out of the live surface.
    const res = await live.client.callTool({
      name: 'instagram_get_account',
      arguments: { bogus: 1 },
    });
    assert.equal(res.isError, true);
    assert.ok(resultText(res).includes('bogus'));
  } finally {
    await live.close();
  }
});

// --- handler wrapper -------------------------------------------------------

test('handler wrapper: a thrown InstagramError is rendered as an isError result', async () => {
  const boom = spec({
    name: 'instagram_boom',
    handler: () => {
      throw new InstagramError('kaboom', { kind: 'upstream' });
    },
  });
  const { deps, calls, seen } = makeDeps({ tools: [boom] });
  registerTools(deps);

  const res = await calls[0]!.cb({});
  assert.equal(res.isError, true);
  const body = res.content[0]?.text ?? '';
  assert.ok(body.includes('upstream'), 'error kind rendered');
  assert.ok(body.includes('kaboom'), 'error message rendered');

  // The makeRequest seam was invoked with the resolved default profile.
  assert.equal(seen.length, 1);
  assert.equal(seen[0], igProfile);
});

test('handler wrapper: makeRequest is called with the profile named by the account arg', async () => {
  const brand: ResolvedProfile = { name: 'brand', authPath: 'ig-login', accessToken: 'tok2' };
  let received: ToolContext | undefined;
  const t = spec({
    name: 'instagram_get_account',
    handler: (_args, ctx) => {
      received = ctx;
      return text('ok');
    },
  });
  const { deps, calls, seen } = makeDeps({ tools: [t], profiles: [igProfile, brand] });
  registerTools(deps);

  const res = await calls[0]!.cb({ account: 'brand' });
  assert.equal(res.isError, undefined);
  assert.equal(seen[0], brand);
  assert.equal(received?.profile, brand);
});

test('handler wrapper: an unknown account arg yields an isError validation result', async () => {
  const t = spec({ name: 'instagram_get_account' });
  const { deps, calls } = makeDeps({ tools: [t] });
  registerTools(deps);

  const res = await calls[0]!.cb({ account: 'does-not-exist' });
  assert.equal(res.isError, true);
});

// --- forced read-only ------------------------------------------------------

test('IG_PACKAGES_READONLY drops a non-read-only tool but keeps read-only ones', () => {
  const read = spec({ name: 'instagram_get_account' });
  const write = spec({
    name: 'instagram_set_comments_enabled',
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  });
  const { deps } = makeDeps({
    tools: [read, write],
    env: { IG_PACKAGES_READONLY: 'account' },
  });
  const { registered } = registerTools(deps);
  assert.deepEqual(registered, ['instagram_get_account']);
});

// --- human confirmation seam (D3 option (a)) -------------------------------

interface ElicitCall {
  params: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

/**
 * An `McpServer` stub with an inner `Server` exposing only the two members
 * {@link serverConfirmer} touches.
 */
function serverWithCapabilities(
  caps: unknown,
  reply: unknown = { action: 'accept', content: { confirm: true } },
): { server: McpServer; elicits: ElicitCall[] } {
  const elicits: ElicitCall[] = [];
  const server = {
    registerTool() {
      return {};
    },
    server: {
      getClientCapabilities: () => caps,
      elicitInput: (params: Record<string, unknown>, options?: Record<string, unknown>) => {
        elicits.push({ params, options });
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve(reply);
      },
    },
  };
  return { server: server as unknown as McpServer, elicits };
}

const samplePrompt: ConfirmPrompt = {
  message: 'confirm?',
  requestedSchema: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', title: 'Perform this write', description: 'check to perform' },
    },
    required: ['confirm'],
  },
};

test('serverConfirmer: form elicitation advertised -> supported', () => {
  const { server } = serverWithCapabilities({ elicitation: { form: {} } });
  assert.equal(serverConfirmer(server).isSupported(), true);
});

test('serverConfirmer: no elicitation capability -> unsupported (env-flag fallback)', () => {
  for (const caps of [undefined, {}, { roots: {} }, { elicitation: {} }]) {
    const { server } = serverWithCapabilities(caps);
    assert.equal(
      serverConfirmer(server).isSupported(),
      false,
      `${JSON.stringify(caps)} must not count as form elicitation`,
    );
  }
});

test('serverConfirmer: a url-only elicitation client cannot answer a form and is unsupported', () => {
  // The SDK normalizes legacy `elicitation: {}` to `{ form: {} }`; a client that
  // deliberately advertises only `url` cannot render this boolean form, so the
  // gate falls back to env flags instead of refusing every write.
  const { server } = serverWithCapabilities({ elicitation: { url: {} } });
  assert.equal(serverConfirmer(server).isSupported(), false);
});

test('serverConfirmer: a server stub with no inner Server is unsupported, never a crash', () => {
  const { server } = fakeServer();
  assert.equal(serverConfirmer(server).isSupported(), false);
});

test('serverConfirmer: ask() sends a bounded form elicitation and returns the answer', async () => {
  const { server, elicits } = serverWithCapabilities({ elicitation: { form: {} } });
  const answer = await serverConfirmer(server).ask(samplePrompt);

  assert.deepEqual(answer, { action: 'accept', content: { confirm: true } });
  assert.equal(elicits.length, 1);
  assert.equal(elicits[0]!.params.mode, 'form');
  assert.equal(elicits[0]!.params.message, 'confirm?');
  assert.deepEqual(elicits[0]!.params.requestedSchema, samplePrompt.requestedSchema);
  // Both budgets are bounded: `timeout` alone can be extended forever by a
  // client that keeps emitting progress notifications.
  assert.equal(elicits[0]!.options?.timeout, CONFIRM_TIMEOUT_MS);
  assert.equal(elicits[0]!.options?.maxTotalTimeout, CONFIRM_TIMEOUT_MS);
});

test('serverConfirmer: ask() on a server that cannot elicit rejects (never a silent accept)', async () => {
  const { server } = fakeServer();
  await assert.rejects(
    () => serverConfirmer(server).ask(samplePrompt),
    (err: unknown) => isInstagramError(err) && err.kind === 'permission',
  );
});

test('registry: the confirmation seam is threaded onto every tool context', async () => {
  const confirm: WriteConfirmer = {
    isSupported: () => true,
    ask: () => Promise.resolve({ action: 'decline' as const }),
  };
  let received: WriteGateContext | undefined;
  const t = spec({
    name: 'instagram_get_account',
    handler: (_args, ctx) => {
      received = ctx;
      return text('ok');
    },
  });
  const { deps, calls } = makeDeps({ tools: [t], confirm });
  registerTools(deps);
  await calls[0]!.cb({});

  assert.equal(received?.confirm, confirm);
});

test('registry: without an injected seam the default is built from the server', async () => {
  let received: WriteGateContext | undefined;
  const t = spec({
    name: 'instagram_get_account',
    handler: (_args, ctx) => {
      received = ctx;
      return text('ok');
    },
  });
  const { deps, calls } = makeDeps({ tools: [t] });
  registerTools(deps);
  await calls[0]!.cb({});

  const seam = received?.confirm;
  assert.ok(seam, 'a seam is always present');
  // The fake server advertises nothing, so it reports unsupported and the write
  // gate keeps its pre-elicitation, env-flag-only behaviour.
  assert.equal(seam.isSupported(), false);
});

// --- per-call logFields wiring (QA F6) -------------------------------------

/**
 * A logger that records every emitted record, including the child bindings the
 * registry attaches, so the tests can assert on the exact line that reaches the
 * sink. Bindings are merged the way `core/log.ts` merges them.
 */
interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields: Record<string, unknown>;
}
function recordingLog(bindings: Record<string, unknown> = {}): {
  log: Logger;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const make = (bound: Record<string, unknown>): Logger => ({
    debug: (msg, fields) => records.push({ level: 'debug', msg, fields: { ...fields, ...bound } }),
    info: (msg, fields) => records.push({ level: 'info', msg, fields: { ...fields, ...bound } }),
    warn: (msg, fields) => records.push({ level: 'warn', msg, fields: { ...fields, ...bound } }),
    error: (msg, fields) => records.push({ level: 'error', msg, fields: { ...fields, ...bound } }),
    child: (extra) => make({ ...bound, ...extra }),
  });
  return { log: make(bindings), records };
}

test('selectPackages: an unknown package against an empty manifest still names the profiles', () => {
  // A manifest can legitimately be empty — every tool filtered out by the D1
  // auth-path guard, or an embedder registering a subset. The "available: X"
  // half of the message then has nothing to list, and an empty tail would read
  // as a truncated error. `(none)` plus the profile hint keeps it actionable.
  assert.throws(
    () => selectPackages([], { IG_TOOL_PACKAGES: 'bogus' }),
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'validation' &&
      /available packages: \(none\)/.test(err.message) &&
      /core \| reader \| publisher \| all/.test(err.message),
  );
});

const invoked = (records: LogRecord[]): LogRecord[] =>
  records.filter((r) => r.msg === 'tool invoked');

test('logFields: the declared payload is emitted as one debug line per invocation', async () => {
  const t = spec({
    name: 'instagram_get_media',
    input: { mediaId: z.string(), caption: z.string().optional() },
    logFields: (args) => ({ mediaId: args.mediaId as string }),
  });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], log });
  registerTools(deps);

  const res = await calls[0]!.cb({ mediaId: 'M1', caption: 'never log me' });
  assert.equal(res.isError, undefined);

  const lines = invoked(records);
  assert.equal(lines.length, 1, 'exactly one invocation line');
  assert.equal(lines[0]!.level, 'debug', 'per-call detail is debug, like core/http.ts');
  // The spec's payload plus the child bindings the registry always attaches.
  assert.deepEqual(lines[0]!.fields, {
    mediaId: 'M1',
    tool: 'instagram_get_media',
    account: 'default',
  });
  // Only what the spec declared: the caption it did not declare never leaks.
  assert.equal(JSON.stringify(lines[0]!.fields).includes('never log me'), false);
});

test('logFields: it receives the VALIDATED args, including the injected account selector', async () => {
  const brand: ResolvedProfile = { name: 'brand', authPath: 'ig-login', accessToken: 'tok2' };
  let seenArgs: Record<string, unknown> | undefined;
  const t = spec({
    name: 'instagram_get_account',
    input: { limit: z.coerce.number().optional() },
    logFields: (args) => {
      seenArgs = args;
      return { limit: (args as { limit?: number }).limit, account: args.account };
    },
  });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], profiles: [igProfile, brand], log });
  registerTools(deps);

  await calls[0]!.cb({ account: 'brand', limit: '7' });
  // Coerced by the schema before logFields saw it — not the raw wire value.
  assert.equal(seenArgs?.limit, 7);
  assert.equal(invoked(records)[0]!.fields.limit, 7);
  assert.equal(invoked(records)[0]!.fields.account, 'brand');
});

test('logFields: a rejected call logs nothing — invalid args are never echoed', async () => {
  const t = spec({
    name: 'instagram_get_account',
    logFields: () => ({ reached: true }),
  });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], log });
  registerTools(deps);

  const res = await calls[0]!.cb({ bogus: 'CANARY-UNKNOWN-ARG' });
  assert.equal(res.isError, true);
  assert.equal(invoked(records).length, 0, 'strict-parse rejections never reach the log path');
});

test('logFields: the invocation is logged even when the call is later refused', async () => {
  // Profile resolution fails after the line is emitted; the attempt is still
  // recorded, which is the point of an invocation trace.
  const t = spec({ name: 'instagram_get_account', logFields: () => ({ ok: true }) });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], log });
  registerTools(deps);

  const res = await calls[0]!.cb({ account: 'does-not-exist' });
  assert.equal(res.isError, true);
  assert.equal(invoked(records).length, 1);
  assert.equal(invoked(records)[0]!.fields.account, 'does-not-exist');
});

test('logFields: the line is emitted BEFORE the handler runs', async () => {
  const t = spec({
    name: 'instagram_get_account',
    logFields: () => ({ ok: true }),
    handler: (_args, ctx) => {
      ctx.log.info('handler reached');
      return text('ok');
    },
  });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], log });
  registerTools(deps);
  await calls[0]!.cb({});

  assert.deepEqual(
    records.map((r) => r.msg),
    ['tool invoked', 'handler reached'],
  );
});

test('logFields: a tool that declares none still logs the invocation, with no extra fields', async () => {
  const t = spec({ name: 'instagram_get_publishing_limit' });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], log });
  registerTools(deps);
  await calls[0]!.cb({});

  const lines = invoked(records);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0]!.fields, {
    tool: 'instagram_get_publishing_limit',
    account: 'default',
  });
});

test('logFields: a non-record return value is ignored, the invocation line survives', async () => {
  const t = spec({
    name: 'instagram_get_account',
    // A misbehaving spec: the contract says Record, this returns a string.
    logFields: () => 'not-a-record' as unknown as Record<string, unknown>,
  });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], log });
  registerTools(deps);

  const res = await calls[0]!.cb({});
  assert.equal(res.isError, undefined);
  assert.deepEqual(invoked(records)[0]!.fields, {
    tool: 'instagram_get_account',
    account: 'default',
  });
});

// --- throw safety: logging can never fail a tool call ----------------------

test('logFields: a throwing logFields does NOT fail the tool call; it degrades to a warning', async () => {
  const t = spec({
    name: 'instagram_get_account',
    logFields: () => {
      throw new Error('logFields exploded');
    },
    handler: () => text('handler still ran'),
  });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], log });
  registerTools(deps);

  const res = await calls[0]!.cb({});
  assert.equal(res.isError, undefined, 'a logging failure never fails the request');
  assert.equal(res.content[0]?.text, 'handler still ran');

  assert.equal(invoked(records).length, 0);
  const warns = records.filter((r) => r.level === 'warn');
  assert.equal(warns.length, 1);
  assert.ok(warns[0]!.msg.includes('log fields could not be built'));
  assert.ok(String(warns[0]!.fields.error).includes('logFields exploded'));
  assert.equal(warns[0]!.fields.tool, 'instagram_get_account');
});

test('logFields: a getter that throws during redaction is contained the same way', async () => {
  const t = spec({
    name: 'instagram_get_account',
    logFields: () =>
      Object.defineProperty({}, 'boom', {
        enumerable: true,
        get() {
          throw new Error('getter exploded');
        },
      }),
  });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], log });
  registerTools(deps);

  const res = await calls[0]!.cb({});
  assert.equal(res.isError, undefined);
  assert.equal(records.filter((r) => r.level === 'warn').length, 1);
});

test('logFields: a log sink that throws does NOT fail the tool call either', async () => {
  const brokenLog: Logger = {
    debug() {
      throw new Error('stream closed');
    },
    info() {},
    warn() {
      throw new Error('stream closed');
    },
    error() {},
    child() {
      return brokenLog;
    },
  };
  const t = spec({
    name: 'instagram_get_account',
    logFields: () => ({ ok: true }),
    handler: () => text('handler still ran'),
  });
  const { deps, calls } = makeDeps({ tools: [t], log: brokenLog });
  registerTools(deps);

  const res = await calls[0]!.cb({});
  assert.equal(res.isError, undefined, 'a broken sink never fails the request');
  assert.equal(res.content[0]?.text, 'handler still ran');
});

// --- redaction of the log payload (F6) -------------------------------------

test('logFields: the payload goes through the redactor by DEFAULT, with no dep injected', async () => {
  // No `redact` dep: this proves the registry defaults to a real redactor
  // rather than trusting the injected logger to scrub. F6: "documented to never
  // carry secrets" is a convention; this is the control.
  const secret = 'REGISTRY-F6-SECRET-VALUE-0123456789';
  registerSecret(secret);
  const t = spec({
    name: 'instagram_get_account',
    input: { note: z.string() },
    logFields: (args) => ({ note: args.note as string, access_token: 'EAAtoken' }),
  });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], log });
  registerTools(deps);

  await calls[0]!.cb({ note: `leaked ${secret} here` });
  const fields = invoked(records)[0]!.fields;
  assert.equal(JSON.stringify(fields).includes(secret), false, 'the registered secret is masked');
  assert.equal(fields.note, `leaked ${REDACTED} here`);
  // A secret-named key is masked wholesale regardless of its content.
  assert.equal(fields.access_token, REDACTED);
});

test('logFields: an injected redactor is used and the sink only ever sees its output', async () => {
  const seen: unknown[] = [];
  const t = spec({
    name: 'instagram_get_account',
    logFields: () => ({ raw: 'original' }),
  });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({
    tools: [t],
    log,
    redact: (value) => {
      seen.push(value);
      return { raw: 'scrubbed' };
    },
  });
  registerTools(deps);
  await calls[0]!.cb({});

  assert.deepEqual(seen, [{ raw: 'original' }], 'the raw payload reaches the redactor');
  assert.equal(invoked(records)[0]!.fields.raw, 'scrubbed', 'the sink sees only the output');
});

test('logFields: a redactor that returns a non-record is dropped, not spread into the line', async () => {
  // `redact` is an injected seam and its return type is `unknown`. A redactor
  // that collapses its input to a scalar (a stringifying scrubber, say) must
  // not have that scalar spread into the log fields — `{...'scrubbed'}` would
  // emit `{0:'s',1:'c',…}` and bury the tool/account bindings in noise. The
  // invocation line itself is never dropped: it is the audit record.
  const t = spec({ name: 'instagram_get_account', logFields: () => ({ raw: 'original' }) });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], log, redact: () => 'scrubbed' });
  registerTools(deps);

  const res = await calls[0]!.cb({});

  assert.equal(res.isError, undefined);
  const lines = invoked(records);
  assert.equal(lines.length, 1, 'the invocation is still recorded');
  assert.deepEqual(lines[0]!.fields, { tool: 'instagram_get_account', account: 'default' });
});

test('logFields: a logFields that throws a bare string names the value it threw', async () => {
  // `logFields` is spec-supplied code; nothing forces it to throw an `Error`.
  // `err.message` on a string is `undefined`, so an unguarded warning would
  // report `error: undefined` — an audit failure that hides what failed.
  const t = spec({
    name: 'instagram_get_account',
    logFields: () => {
      throw 'logFields threw a string' as unknown as Error;
    },
    handler: () => text('handler still ran'),
  });
  const { log, records } = recordingLog();
  const { deps, calls } = makeDeps({ tools: [t], log });
  registerTools(deps);

  const res = await calls[0]!.cb({});

  assert.equal(res.isError, undefined, 'a logging failure never fails the request');
  assert.equal(res.content[0]?.text, 'handler still ran');
  const warns = records.filter((r) => r.level === 'warn');
  assert.equal(warns.length, 1);
  assert.equal(warns[0]!.fields.error, 'logFields threw a string');
});
