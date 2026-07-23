/**
 * Unit tests for the publishing tool specs (src/tools/publishing.ts). A minimal
 * fake {@link ToolContext} drives each handler; assertions cover the write gate
 * (preview issues NO network call — no container create, no media_publish),
 * apply behavior, the composite create→poll→publish flow, its in-progress /
 * resume outcomes, and client-side validation.
 *
 * Applied writes journal via mcp/write-mode; IG_WRITE_JOURNAL is pointed at a
 * temp file so the tests never touch the real audit log.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstagramError } from '../../src/core/types.js';
import type {
  IgRequestFn,
  IgRequestOptions,
  Logger,
  ResolvedProfile,
  Settings,
} from '../../src/core/types.js';
import type { ToolContext, ToolSpec } from '../../src/mcp/define.js';
import { fakeClock } from '../helpers/fake-clock.js';
import {
  publishingTools,
  runPostImage,
  runPostReel,
  runPostStory,
} from '../../src/tools/publishing.js';

// Isolate the best-effort write journal to a temp dir for the whole file.
const journalDir = mkdtempSync(join(tmpdir(), 'ig-pub-journal-'));
process.env.IG_WRITE_JOURNAL = join(journalDir, 'writes.jsonl');
after(() => rmSync(journalDir, { recursive: true, force: true }));

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
};

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    maxConcurrent: 4,
    maxItems: 200,
    refreshAfterDays: 45,
    timeoutMs: 30000,
    logLevel: 'info',
    prettyJson: false,
    writeMode: 'preview',
    allowDestructive: false,
    transport: 'stdio',
    httpHost: '127.0.0.1',
    httpPort: 3000,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: 'default',
    authPath: 'ig-login',
    accessToken: 'TOKEN',
    accountId: '999',
    ...overrides,
  };
}

function makeCtx(
  req: IgRequestFn,
  overrides: { settings?: Partial<Settings>; profile?: Partial<ResolvedProfile> } = {},
): ToolContext {
  return {
    req,
    settings: makeSettings(overrides.settings),
    profile: makeProfile(overrides.profile),
    clock: fakeClock(0),
    log: noopLog,
  };
}

function fakeReq(responder: (opts: IgRequestOptions) => unknown): {
  req: IgRequestFn;
  calls: IgRequestOptions[];
} {
  const calls: IgRequestOptions[] = [];
  const req: IgRequestFn = async <T>(opts: IgRequestOptions): Promise<T> => {
    calls.push(opts);
    return responder(opts) as T;
  };
  return { req, calls };
}

function tool(name: string): ToolSpec {
  const found = publishingTools.find((s) => s.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

// --- surface ----------------------------------------------------------------

test('publishingTools exposes the seven publishing specs with correct read/write hints', () => {
  assert.deepEqual(publishingTools.map((t) => t.name).sort(), [
    'instagram_create_media_container',
    'instagram_get_container_status',
    'instagram_get_publishing_limit',
    'instagram_post_image',
    'instagram_post_reel',
    'instagram_post_story',
    'instagram_publish_media',
  ]);
  for (const t of publishingTools) {
    assert.equal(t.package, 'publishing');
    assert.equal(t.annotations.openWorldHint, true);
  }
  const readOnly = new Set(['instagram_get_container_status', 'instagram_get_publishing_limit']);
  for (const t of publishingTools) {
    assert.equal(t.annotations.readOnlyHint === true, readOnly.has(t.name));
  }
});

test('write tools declare `apply` in their input; read tools do not', () => {
  for (const t of publishingTools) {
    const isWrite = t.annotations.readOnlyHint !== true;
    assert.equal('apply' in t.input, isWrite, `${t.name} apply presence`);
  }
});

// --- instagram_create_media_container --------------------------------------

test('create_media_container preview issues NO network call and returns a preview', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));
  const res = await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.jpg', caption: 'hi' },
    makeCtx(req),
  );
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent?.mode, 'preview');
  assert.equal(res.structuredContent?.action, 'create_media_container');
  assert.equal(calls.length, 0, 'preview must not create a container');
});

test('create_media_container apply creates a feed-image container with NO media_type', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));
  const res = await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.jpg', caption: 'hi', apply: true },
    makeCtx(req),
  );
  assert.equal(res.structuredContent?.status, 'created');
  assert.equal(res.structuredContent?.container_id, 'C1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, '/999/media');
  assert.equal('media_type' in (calls[0]?.params ?? {}), false);
});

test('create_media_container rejects an over-limit caption before any write (validation)', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));
  await assert.rejects(
    async () =>
      tool('instagram_create_media_container').handler(
        { imageUrl: 'https://cdn/a.jpg', caption: 'x'.repeat(2201), apply: true },
        makeCtx(req),
      ),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

// --- instagram_get_container_status ----------------------------------------

test('get_container_status maps status_code/status and needs no apply', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'C1', status_code: 'FINISHED' }));
  const res = await tool('instagram_get_container_status').handler(
    { containerId: 'C1' },
    makeCtx(req),
  );
  assert.equal(res.structuredContent?.id, 'C1');
  assert.equal(res.structuredContent?.status_code, 'FINISHED');
  assert.equal(calls[0]?.path, '/C1');
  assert.equal(calls[0]?.params?.fields, 'status_code,status');
});

// --- instagram_publish_media -----------------------------------------------

test('publish_media preview issues NO media_publish call', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'M1' }));
  const res = await tool('instagram_publish_media').handler({ creationId: 'C1' }, makeCtx(req));
  assert.equal(res.structuredContent?.mode, 'preview');
  assert.equal(calls.length, 0, 'preview must not publish');
});

test('publish_media apply posts creation_id and returns the new media id', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'M1' }));
  const res = await tool('instagram_publish_media').handler(
    { creationId: 'C1', apply: true },
    makeCtx(req),
  );
  assert.equal(res.structuredContent?.status, 'published');
  assert.equal(res.structuredContent?.media_id, 'M1');
  assert.equal(calls[0]?.path, '/999/media_publish');
  assert.equal(calls[0]?.params?.creation_id, 'C1');
});

// --- instagram_get_publishing_limit ----------------------------------------

test('get_publishing_limit surfaces runtime quota_total and derived remaining', async () => {
  const { req } = fakeReq(() => ({
    data: [{ quota_usage: 10, config: { quota_total: 50, quota_duration: 86400 } }],
  }));
  const res = await tool('instagram_get_publishing_limit').handler({}, makeCtx(req));
  assert.equal(res.structuredContent?.quota_usage, 10);
  assert.equal(res.structuredContent?.quota_total, 50);
  assert.equal(res.structuredContent?.remaining, 40);
});

// --- instagram_post_image (composite) --------------------------------------

test('post_image preview performs nothing (no create, no publish)', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'x' }));
  const res = await tool('instagram_post_image').handler(
    { imageUrls: ['https://cdn/a.jpg'], caption: 'hello' },
    makeCtx(req),
  );
  assert.equal(res.structuredContent?.mode, 'preview');
  assert.equal(calls.length, 0);
});

test('post_image apply creates a single feed image, polls FINISHED, then publishes', async () => {
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'C1' };
    if (opts.path === '/C1' && opts.method === 'GET') return { id: 'C1', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'M1' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });
  const res = await tool('instagram_post_image').handler(
    { imageUrls: ['https://cdn/a.jpg'], apply: true },
    makeCtx(req),
  );
  assert.equal(res.structuredContent?.status, 'published');
  assert.equal(res.structuredContent?.media_id, 'M1');
  // create had no media_type (feed image), and publish carried the container id.
  const create = calls.find((c) => c.path === '/999/media');
  assert.equal('media_type' in (create?.params ?? {}), false);
  const pub = calls.find((c) => c.path === '/999/media_publish');
  assert.equal(pub?.params?.creation_id, 'C1');
});

test('post_image apply with 2+ images builds a carousel album then publishes it', async () => {
  let child = 0;
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') {
      if (opts.params?.children !== undefined) return { id: 'ALBUM' };
      child += 1;
      return { id: `ch-${child}` };
    }
    if (opts.path === '/ALBUM' && opts.method === 'GET')
      return { id: 'ALBUM', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'MPOST' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });
  const res = await runPostImage(
    { imageUrls: ['https://cdn/1.jpg', 'https://cdn/2.jpg'], caption: 'trip', apply: true },
    makeCtx(req),
  );
  assert.equal(res.structuredContent?.status, 'published');
  assert.equal(res.structuredContent?.container_id, 'ALBUM');
  assert.equal(res.structuredContent?.media_id, 'MPOST');
  const album = calls.find((c) => c.params?.children !== undefined);
  assert.equal(album?.params?.children, 'ch-1,ch-2');
});

test('post_image apply returns in_progress with a resume id when the poll budget elapses', async () => {
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'C1' };
    if (opts.path === '/C1' && opts.method === 'GET')
      return { id: 'C1', status_code: 'IN_PROGRESS' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });
  const res = await runPostImage({ imageUrls: ['https://cdn/a.jpg'], apply: true }, makeCtx(req), {
    maxPollMs: 0,
  });
  assert.equal(res.isError, undefined, 'in_progress is not an error');
  assert.equal(res.structuredContent?.status, 'in_progress');
  assert.equal(res.structuredContent?.resume_container_id, 'C1');
  assert.equal(
    calls.every((c) => c.path !== '/999/media_publish'),
    true,
    'never auto-publishes',
  );
});

test('post_image resume publishes the given container without creating a new one', async () => {
  let created = false;
  const { req } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') {
      created = true;
      return { id: 'NEW' };
    }
    if (opts.path === '/RESUME' && opts.method === 'GET')
      return { id: 'RESUME', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'MRES' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });
  const res = await runPostImage({ resumeContainerId: 'RESUME', apply: true }, makeCtx(req));
  assert.equal(created, false);
  assert.equal(res.structuredContent?.status, 'published');
  assert.equal(res.structuredContent?.media_id, 'MRES');
});

// --- instagram_post_reel (composite) ---------------------------------------

test('post_reel apply creates a REELS container, polls, and publishes', async () => {
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'R1' };
    if (opts.path === '/R1' && opts.method === 'GET') return { id: 'R1', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'RMEDIA' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });
  const res = await tool('instagram_post_reel').handler(
    { videoUrl: 'https://cdn/v.mp4', caption: 'reel', apply: true },
    makeCtx(req),
  );
  assert.equal(res.structuredContent?.status, 'published');
  assert.equal(res.structuredContent?.media_id, 'RMEDIA');
  const create = calls.find((c) => c.path === '/999/media');
  assert.equal(create?.params?.media_type, 'REELS');
  assert.equal(create?.params?.video_url, 'https://cdn/v.mp4');
});

test('post_reel without a videoUrl or resume id is a validation error', async () => {
  const { req } = fakeReq(() => ({ id: 'x' }));
  await assert.rejects(
    () => runPostReel({ apply: true }, makeCtx(req)),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
});

// --- instagram_post_story (composite) --------------------------------------

test('post_story apply creates a STORIES container from an image and publishes', async () => {
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'S1' };
    if (opts.path === '/S1' && opts.method === 'GET') return { id: 'S1', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'SMEDIA' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });
  const res = await tool('instagram_post_story').handler(
    { imageUrl: 'https://cdn/s.jpg', apply: true },
    makeCtx(req),
  );
  assert.equal(res.structuredContent?.status, 'published');
  assert.equal(res.structuredContent?.media_id, 'SMEDIA');
  const create = calls.find((c) => c.path === '/999/media');
  assert.equal(create?.params?.media_type, 'STORIES');
});

test('post_story rejects neither/both of imageUrl and videoUrl (validation)', async () => {
  const { req } = fakeReq(() => ({ id: 'x' }));
  await assert.rejects(
    () => runPostStory({ apply: true }, makeCtx(req)),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
  await assert.rejects(
    () =>
      runPostStory(
        { imageUrl: 'https://cdn/a.jpg', videoUrl: 'https://cdn/b.mp4', apply: true },
        makeCtx(req),
      ),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
});
