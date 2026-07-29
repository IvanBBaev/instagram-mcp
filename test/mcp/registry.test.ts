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
import type { IgRequestFn, Logger, ResolvedProfile, Settings } from '../../src/core/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { allTools } from '../../src/tools/index.js';

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

const baseSettings: Settings = {
  maxConcurrent: 4,
  maxItems: 200,
  refreshAfterDays: 45,
  timeoutMs: 30_000,
  logLevel: 'info',
  prettyJson: false,
  writeMode: 'preview',
  allowDestructive: false,
  transport: 'stdio',
  httpHost: '127.0.0.1',
  httpPort: 3000,
};

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
  inputSchema?: z.ZodRawShape;
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

// --- account auto-injection & strict re-validation -------------------------

test('account selector is injected and the strict schema accepts { account }', () => {
  const t = spec({ name: 'instagram_get_account', input: {} });
  const { deps, calls } = makeDeps({ tools: [t] });
  registerTools(deps);

  const cfg = calls[0]?.config;
  assert.ok(cfg?.inputSchema, 'inputSchema present');
  assert.ok('account' in cfg.inputSchema, 'account field injected');

  const strict = z.object(cfg.inputSchema).strict();
  assert.equal(strict.safeParse({ account: 'brand' }).success, true);
  assert.equal(strict.safeParse({}).success, true);
});

test('strict re-validation rejects an unknown argument at call time (CC-CFG-6)', async () => {
  const t = spec({ name: 'instagram_get_account', input: {} });
  const { deps, calls } = makeDeps({ tools: [t] });
  registerTools(deps);

  const res = await calls[0]!.cb({ bogus: 1 });
  assert.equal(res.isError, true);
  assert.ok(res.content[0]?.text.includes('bogus'), 'names the unknown key');
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
