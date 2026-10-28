/**
 * Workflow skills (src/mcp/skills.ts, skills/<name>/SKILL.md): the bundle stays
 * in step with the tool surface and the prompts, and the Skills extension
 * serves it through a real `McpServer` and `SkillsClient` over
 * `InMemoryTransport`, gated like the prompts. No network: the request factory
 * is inert and no skill call reaches a tool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import {
  SKILLS_ROOT,
  attachSkills,
  bundledSkills,
  gatedSkillSource,
  loadBundledSkills,
} from '../../src/mcp/skills.js';
import { PROMPTS } from '../../src/mcp/prompts.js';
import { registerTools } from '../../src/mcp/registry.js';
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

const igProfile: ResolvedProfile = { name: 'default', authPath: 'ig-login', accessToken: 'tok' };
const fbProfile: ResolvedProfile = {
  name: 'default',
  authPath: 'fb-login',
  accessToken: 'tok',
  appId: 'app',
  appSecret: 'secret',
};

const inertRequest: IgRequestFn = async <T>(): Promise<T> => {
  throw new Error('skills must never reach the network');
};

const WEEKLY = 'skill://instagram-weekly-report/SKILL.md';
const CAPTION = 'skill://instagram-caption-to-publish/SKILL.md';
const TRIAGE = 'skill://instagram-comment-triage/SKILL.md';
const DISCOVERY = 'skill://instagram-discovery-research/SKILL.md';
const ALL = [CAPTION, TRIAGE, DISCOVERY, WEEKLY];

interface Live {
  client: Client;
  skills: SkillsClient;
  close: () => Promise<void>;
}

/** Register the real tool surface under `env`/`profile`; the skills attach with it. */
async function live(
  env: Record<string, string>,
  profile: ResolvedProfile = fbProfile,
): Promise<Live> {
  const server = new McpServer({ name: 'instagram-mcp-ai-test', version: '0.0.0' });
  registerTools({
    server,
    tools: allTools,
    profiles: [profile],
    defaultProfileName: 'default',
    settings: testSettings(),
    clock: fakeClock(0),
    log: noopLog,
    makeRequest: () => inertRequest,
    env,
  });
  const client = new Client({ name: 'skills-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    skills: new SkillsClient(client),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test('the bundle holds the four workflow skills, Markdown only, under the package root', async () => {
  const bundle = await bundledSkills();
  assert.deepEqual(
    bundle.map((entry) => entry.skill.uri),
    ALL,
  );
  for (const entry of bundle) {
    for (const uri of entry.files.keys()) assert.match(uri, /\.md$/, uri);
    assert.equal(entry.skill.uri.split('/')[2], entry.skill.frontmatter.name);
  }
  assert.match(SKILLS_ROOT, /skills$/);
});

test('every tool a skill names is a real tool (drift guard)', async () => {
  const real = new Set(allTools.map((spec) => spec.name));
  for (const entry of await bundledSkills()) {
    assert.ok(entry.tools.length > 0, `${entry.skill.uri} names no tool`);
    for (const tool of entry.tools) {
      assert.ok(real.has(tool), `${entry.skill.uri} names unknown tool ${tool}`);
    }
  }
});

test('each skill is the same workflow as its prompt and names exactly its tools', async () => {
  const bundle = await bundledSkills();
  assert.equal(bundle.length, PROMPTS.length);
  for (const prompt of PROMPTS) {
    const name = prompt.name.replaceAll('_', '-');
    const entry = bundle.find((e) => e.skill.frontmatter.name === name);
    assert.ok(entry, `prompt ${prompt.name} has no skill ${name}`);
    assert.deepEqual(entry.tools, [...prompt.tools].sort(), name);
  }
});

test('skills/list, skills/get and a verified read over a live server', async () => {
  const l = await live({ IG_TOOL_PACKAGES: 'all' });
  try {
    assert.equal(l.skills.supported, true);
    const listing = await l.skills.list();
    assert.deepEqual(
      listing.skills.map((s) => s.uri),
      ALL,
    );
    const { skill } = await l.skills.get(CAPTION);
    assert.equal(skill.frontmatter.name, 'instagram-caption-to-publish');
    // `read` checks size, digest and frontmatter against the entry.
    const file = await l.skills.read(skill);
    assert.equal(file.verified, true);
    assert.equal(file.mimeType, 'text/markdown');
    assert.match(file.text ?? '', /`instagram_post_image`/);
    assert.match(file.text ?? '', /apply: false/);
  } finally {
    await l.close();
  }
});

test('gating: a skill is served only when every tool it names is exposed', async () => {
  const cases: { env: Record<string, string>; profile?: ResolvedProfile; want: string[] }[] = [
    // Default `core` keeps discovery dark.
    { env: {}, want: [CAPTION, TRIAGE, WEEKLY] },
    // Discovery tools are fb-login only.
    { env: { IG_TOOL_PACKAGES: 'all' }, profile: igProfile, want: [CAPTION, TRIAGE, WEEKLY] },
    // `reader` is forced read-only: caption (publish) and triage (reply/hide) go.
    { env: { IG_TOOL_PACKAGES: 'reader' }, want: [DISCOVERY, WEEKLY] },
    { env: { IG_TOOL_PACKAGES: 'account' }, want: [] },
  ];
  for (const { env, profile, want } of cases) {
    const l = await live(env, profile);
    try {
      const listing = await l.skills.list();
      assert.deepEqual(
        listing.skills.map((s) => s.uri),
        want,
        JSON.stringify(env),
      );
      const hidden = ALL.find((uri) => !want.includes(uri)) as string;
      await assert.rejects(l.skills.get(hidden), /No skill is served/, `${hidden} get`);
      await assert.rejects(l.client.readResource({ uri: hidden }), /not found/i, `${hidden} read`);
    } finally {
      await l.close();
    }
  }
});

test('gatedSkillSource answers unknown URIs with undefined', async () => {
  const source = gatedSkillSource(
    allTools.map((spec) => spec.name),
    bundledSkills,
  );
  const ctx = {} as Parameters<typeof source.get>[1];
  assert.equal(await source.get('skill://nope/SKILL.md', ctx), undefined);
  assert.equal(await source.read('skill://nope/SKILL.md', ctx), undefined);
  assert.equal((await source.read(WEEKLY, ctx))?.mimeType, 'text/markdown');
});

test('attachSkills is a no-op on a server stub and refuses a second attach', () => {
  const stub = { registerTool() {} } as unknown as McpServer;
  assert.doesNotThrow(() => attachSkills(stub, []));
  const server = new McpServer({ name: 'instagram-mcp-ai-test', version: '0.0.0' });
  attachSkills(server, []);
  assert.throws(() => attachSkills(server, []));
});

test('loadBundledSkills reads nested files and rejects an invalid skill strictly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ig-skills-'));
  try {
    await mkdir(join(root, 'demo', 'references'), { recursive: true });
    await writeFile(
      join(root, 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: A demo skill.\n---\n\nCall `instagram_get_account`.\n',
    );
    await writeFile(join(root, 'demo', 'references', 'MORE.md'), 'Then `instagram_list_media`.\n');
    const [demo] = await loadBundledSkills(root);
    assert.deepEqual(demo?.tools, ['instagram_get_account', 'instagram_list_media']);
    assert.equal(
      demo?.files.get('skill://demo/references/MORE.md'),
      'Then `instagram_list_media`.\n',
    );

    // The folder name must equal the frontmatter name; strict makes it an error.
    await mkdir(join(root, 'other'));
    await writeFile(
      join(root, 'other', 'SKILL.md'),
      '---\nname: not-other\ndescription: Mismatched.\n---\n',
    );
    await assert.rejects(loadBundledSkills(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
