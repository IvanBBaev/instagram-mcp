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
  type PackageManifest,
  type RegisterToolsDeps,
} from '../../src/mcp/registry.js';
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

test('buildManifest groups the three v1 packages and holds the tag invariant', () => {
  const manifest = buildManifest(allTools);
  assert.deepEqual(
    manifest.map((p) => p.name),
    ['account', 'insights', 'media'],
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
    insights: [
      'instagram_get_account_insights',
      'instagram_get_audience_demographics',
      'instagram_get_media_insights',
      'instagram_get_online_followers',
    ],
    media: ['instagram_get_media', 'instagram_list_media'],
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

test('selectPackages: core (default) selects all three v1 packages', () => {
  const { active, readonly } = selectPackages(v1Manifest, {});
  assert.deepEqual([...active].sort(), ['account', 'insights', 'media']);
  assert.equal(readonly.size, 0);
});

test('selectPackages: explicit comma list selects exactly those packages', () => {
  const { active } = selectPackages(v1Manifest, { IG_TOOL_PACKAGES: 'media,insights' });
  assert.deepEqual([...active].sort(), ['insights', 'media']);
});

test('selectPackages: all selects every package in the manifest', () => {
  const { active } = selectPackages(v1Manifest, { IG_TOOL_PACKAGES: 'all' });
  assert.deepEqual([...active].sort(), ['account', 'insights', 'media']);
});

test('selectPackages: IG_PACKAGES_DENY removes a package after profile resolution', () => {
  const { active } = selectPackages(v1Manifest, {
    IG_TOOL_PACKAGES: 'all',
    IG_PACKAGES_DENY: 'insights',
  });
  assert.deepEqual([...active].sort(), ['account', 'media']);
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
