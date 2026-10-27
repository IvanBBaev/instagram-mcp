/**
 * MCP 2026-07-28 conformance: the list surface is deterministic. A client that
 * caches `tools/list` / `prompts/list` / `resources/list` (the 2026 revision
 * adds `ttlMs` / `cacheScope` for exactly that) and diffs the answer between
 * connections must see the same order every time, so the order is pinned here
 * against its source of truth: the sorted package manifest for tools, and the
 * static `PROMPTS` / `RESOURCES` arrays for the rest. No network: the request
 * factory never answers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { buildManifest, registerTools } from '../../src/mcp/registry.js';
import { PROMPTS, registerPrompts } from '../../src/mcp/prompts.js';
import { RESOURCES, registerResources } from '../../src/mcp/resources.js';
import { allTools } from '../../src/tools/index.js';
import type { IgRequestFn, Logger, ResolvedProfile } from '../../src/core/types.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { testSettings } from '../helpers/settings.js';

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
};

const profiles: ResolvedProfile[] = [
  { name: 'default', authPath: 'ig-login', accessToken: 'tok' },
  { name: 'fb', authPath: 'fb-login', accessToken: 'tok', appId: 'app', appSecret: 'secret' },
];

const neverAnswers: IgRequestFn = async () => {
  throw new Error('no network in the conformance test');
};

interface Surface {
  registered: string[];
  tools: string[];
  prompts: string[];
  resources: string[];
}

async function surface(tools = allTools): Promise<Surface> {
  const server = new McpServer({ name: 'instagram-mcp-ai-test', version: '0.0.0' });
  const { registered, callers } = registerTools({
    server,
    tools,
    profiles,
    defaultProfileName: 'default',
    settings: testSettings(),
    clock: fakeClock(Date.UTC(2026, 9, 28)),
    log: noopLog,
    makeRequest: () => neverAnswers,
    env: { IG_TOOL_PACKAGES: 'all' },
  });
  registerPrompts(server, registered);
  registerResources(server, callers);
  const client = new Client({ name: 'conformance-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return {
      registered,
      tools: (await client.listTools()).tools.map((t) => t.name),
      prompts: (await client.listPrompts()).prompts.map((p) => p.name),
      resources: (await client.listResources()).resources.map((r) => r.name),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

test('tools/list follows the sorted package manifest, then source order inside a package', async () => {
  const s = await surface();
  const expected = buildManifest(allTools)
    .flatMap((pkg) => pkg.tools.map((t) => t.name))
    .filter((name) => s.registered.includes(name));
  assert.ok(s.tools.length > 0);
  assert.deepEqual(s.tools, expected);
  assert.deepEqual(s.tools, s.registered);
});

test('tools/list order does not depend on the order the tool specs are supplied in', async () => {
  // The manifest sorts packages by name, so a reshuffled `allTools` (a module
  // import order change, a new package appended) must not reorder the list a
  // caching client already holds. Inside one package the source order stands,
  // which reversing the whole array would break — so only whole packages move.
  const byPackage = new Map<string, typeof allTools>();
  for (const spec of allTools)
    byPackage.set(spec.package, [...(byPackage.get(spec.package) ?? []), spec]);
  const reshuffled = [...byPackage.values()].reverse().flat();
  assert.notDeepEqual(
    reshuffled.map((t) => t.name),
    allTools.map((t) => t.name),
  );
  assert.deepEqual((await surface(reshuffled)).tools, (await surface()).tools);
});

test('prompts/list and resources/list follow the static PROMPTS and RESOURCES order', async () => {
  const s = await surface();
  assert.deepEqual(
    s.prompts,
    PROMPTS.map((p) => p.name),
  );
  assert.deepEqual(
    s.resources,
    RESOURCES.map((r) => r.name),
  );
});

test('two independent builds list tools, prompts and resources identically', async () => {
  const [a, b] = [await surface(), await surface()];
  assert.deepEqual(a, b);
});
