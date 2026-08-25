/**
 * Unit tests for the publishing tool specs (src/tools/publishing.ts). A minimal
 * fake {@link ToolContext} drives each handler; assertions cover the write gate
 * (preview issues NO network call — no container create, no media_publish),
 * apply behavior, the composite create→poll→publish flow, its in-progress /
 * resume outcomes, and client-side validation.
 *
 * Applied writes journal via mcp/write-mode; every context carries a
 * `writeJournal` pointed at a temp file so the tests never touch the real
 * audit log.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { InstagramError } from '../../src/core/types.js';
import type { Clock } from '../../src/core/clock.js';
import type {
  IgRequestFn,
  IgRequestOptions,
  Logger,
  ResolvedProfile,
  Settings,
} from '../../src/core/types.js';
import type { ToolContext, ToolSpec } from '../../src/mcp/define.js';
import { testSettings } from '../helpers/settings.js';
import { fakeClock } from '../helpers/fake-clock.js';
import {
  publishingTools,
  runPostImage,
  runPostReel,
  runPostStory,
} from '../../src/tools/publishing.js';

// Isolate the best-effort write journal to a temp dir for the whole file.
const journalDir = mkdtempSync(join(tmpdir(), 'ig-pub-journal-'));
const journalPath = join(journalDir, 'writes.jsonl');
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
  return testSettings({ writeJournal: journalPath, ...overrides });
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

/** The tool's declared input as a parseable object — what the SDK enforces pre-handler. */
function inputOf(name: string) {
  return z.object(tool(name).input);
}

/** The tool's declared `structuredContent` schema, which the SDK validates results against. */
function outputOf(name: string) {
  const shape = tool(name).output;
  if (!shape) throw new Error(`${name} declares no output schema`);
  return z.object(shape);
}

/** `logFields` of a spec, as the registry calls it. */
function logFieldsOf(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const fn = tool(name).logFields;
  if (!fn) throw new Error(`${name} declares no logFields`);
  return fn(args);
}

/** Every write tool in the package (everything the write gate applies to). */
const writeToolNames = publishingTools
  .filter((t) => t.annotations.readOnlyHint !== true)
  .map((t) => t.name);

/**
 * A clock whose `sleep` moves time forward instead of waiting. `fakeClock` only
 * advances on an explicit `advance()` call, which deadlocks any test that has to
 * let the composite's own poll loop run; this one lets the loop run to completion
 * in zero real time, so the poll budget is observable rather than a hang.
 */
function autoClock(startMs = 0): Clock {
  let current = startMs;
  return {
    now: () => current,
    sleep: (ms: number) => {
      current += ms;
      return Promise.resolve();
    },
  };
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

test('publishing writes are declared NON-idempotent — a repeat is a second post', () => {
  // Instagram has no request key here: calling `instagram_post_image` twice
  // publishes twice. A client that read `idempotentHint: true` would be entitled
  // to retry a timed-out call on its own and double-post to the account.
  for (const t of publishingTools) {
    if (t.annotations.readOnlyHint === true) continue;
    assert.equal(t.annotations.idempotentHint, false, `${t.name} idempotentHint`);
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
  // The URL is the entire content of the container. Dropping it does not fail
  // here — Graph accepts the create and the container ends in ERROR minutes
  // later — so the operator sees a successful "created" result for a container
  // that can never be published.
  assert.equal(calls[0]?.params?.image_url, 'https://cdn/a.jpg');
});

test('create_media_container preview says a feed image sends NO media_type at all', async () => {
  // The preview text is the entire basis on which an operator authorizes a write,
  // and `IMAGE` is not a value Instagram accepts for a container. A preview that
  // prints it describes a call the server never makes, and hides the one
  // non-obvious rule of this endpoint: a feed image is the container kind you get
  // by omitting the kind. An operator who trusts the preview goes looking for the
  // bug in Graph rather than in the argument they did not pass.
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));

  const feed = await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.jpg' },
    makeCtx(req),
  );
  const feedDetails = feed.structuredContent?.details as Record<string, unknown> | undefined;
  assert.equal(feedDetails?.media_type, '(feed image — no media_type)');

  const reel = await tool('instagram_create_media_container').handler(
    { mediaType: 'REELS', videoUrl: 'https://cdn/v.mp4' },
    makeCtx(req),
  );
  const reelDetails = reel.structuredContent?.details as Record<string, unknown> | undefined;
  assert.equal(reelDetails?.media_type, 'REELS');

  assert.equal(calls.length, 0, 'neither preview touched the network');
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

test('create_media_container apply sends a REELS container with its cover and thumb offset', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'C9' }));
  const res = await tool('instagram_create_media_container').handler(
    {
      mediaType: 'REELS',
      videoUrl: 'https://cdn/v.mp4',
      coverUrl: 'https://cdn/cover.jpg',
      thumbOffset: 1500,
      shareToFeed: true,
      apply: true,
    },
    makeCtx(req),
  );

  assert.equal(res.structuredContent?.container_id, 'C9');
  const p = calls[0]?.params ?? {};
  assert.equal(p.media_type, 'REELS');
  assert.equal(p.video_url, 'https://cdn/v.mp4');
  // A dropped cover_url/thumb_offset is invisible in the response — the reel
  // publishes with Instagram's own frame — so the pass-through is pinned here.
  assert.equal(p.cover_url, 'https://cdn/cover.jpg');
  assert.equal(p.thumb_offset, 1500);
  assert.equal(p.share_to_feed, true);
});

test('create_media_container refuses a plaintext videoUrl or coverUrl before any write', async () => {
  // Instagram fetches these URLs server-side; a http:// source would ship the
  // media over the wire in the clear, and the container is a write.
  for (const args of [
    { mediaType: 'REELS' as const, videoUrl: 'http://cdn/v.mp4' },
    { mediaType: 'REELS' as const, videoUrl: 'https://cdn/v.mp4', coverUrl: 'http://cdn/c.jpg' },
  ]) {
    const { req, calls } = fakeReq(() => ({ id: 'C1' }));
    await assert.rejects(
      async () =>
        tool('instagram_create_media_container').handler({ ...args, apply: true }, makeCtx(req)),
      (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
      JSON.stringify(args),
    );
    assert.equal(calls.length, 0, 'nothing is created from a rejected URL');
  }
});

test('create_media_container previews a carousel with its child count and enforces 2-10', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));
  const res = await tool('instagram_create_media_container').handler(
    { mediaType: 'CAROUSEL', children: ['A', 'B', 'C'], caption: 'album' },
    makeCtx(req),
  );

  const details = res.structuredContent?.details as Record<string, unknown> | undefined;
  assert.equal(details?.children, 3, 'the preview states how many children would be attached');
  assert.equal(calls.length, 0, 'a preview creates nothing');

  // 1 and 11 are the two sides of the documented 2–10 range. The message is
  // asserted verbatim, not just the error kind: every other rejection in this
  // handler (a plaintext URL, a missing field) is `kind: 'validation'` too, so a
  // kind-only predicate would pass even if the size check never ran.
  for (const children of [['A'], Array.from({ length: 11 }, (_, i) => `C${i}`)]) {
    const rejecting = fakeReq(() => ({ id: 'C1' }));
    await assert.rejects(
      async () =>
        tool('instagram_create_media_container').handler(
          { mediaType: 'CAROUSEL', children, apply: true },
          makeCtx(rejecting.req),
        ),
      (e: unknown) =>
        e instanceof InstagramError &&
        e.kind === 'validation' &&
        e.message === `A carousel needs 2–10 items (got ${children.length}).`,
      `${children.length} children`,
    );
    assert.equal(rejecting.calls.length, 0);
  }
});

test('a non-JPEG image URL is warned about in the preview and again in the applied result', async () => {
  // The server never downloads the URL, so this extension hint is the only
  // pre-flight signal an operator gets before Instagram rejects the fetch.
  const preview = await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.png' },
    makeCtx(fakeReq(() => ({ id: 'C1' })).req),
  );
  const details = preview.structuredContent?.details as Record<string, unknown> | undefined;
  const previewWarnings = details?.warnings as string[] | undefined;
  assert.equal(previewWarnings?.length, 1, 'the preview carries the warning');
  assert.match(previewWarnings?.[0] ?? '', /".png"/, 'the offending extension is named');

  const applied = await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.png', apply: true },
    makeCtx(fakeReq(() => ({ id: 'C1' })).req),
  );
  const appliedWarnings = applied.structuredContent?.warnings as string[] | undefined;
  assert.equal(appliedWarnings?.length, 1, 'applying does not drop the warning');
  assert.equal(applied.structuredContent?.container_id, 'C1', 'and the warning is not fatal');
});

test('a plain .jpg URL produces no warning field at all', async () => {
  const res = await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.jpg', apply: true },
    makeCtx(fakeReq(() => ({ id: 'C1' })).req),
  );
  // An always-present `warnings: []` would train callers to ignore the field.
  assert.equal('warnings' in (res.structuredContent ?? {}), false);
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

test('get_container_status carries the free-text status through when Graph returns one', async () => {
  const { req } = fakeReq(() => ({
    id: 'C1',
    status_code: 'ERROR',
    status: 'Error: 2207026 - Unsupported video format',
  }));
  const res = await tool('instagram_get_container_status').handler(
    { containerId: 'C1' },
    makeCtx(req),
  );

  assert.equal(res.structuredContent?.status_code, 'ERROR');
  // status_code alone says "it failed"; the status string says why, and it is
  // the only place the Graph media error code (2207026 here) ever appears.
  assert.equal(res.structuredContent?.status, 'Error: 2207026 - Unsupported video format');
});

test('get_container_status omits status_code and status when Graph reports neither', async () => {
  const { req } = fakeReq(() => ({ id: 'C1' }));
  const res = await tool('instagram_get_container_status').handler(
    { containerId: 'C1' },
    makeCtx(req),
  );

  assert.deepEqual(res.structuredContent, { id: 'C1' }, 'absent fields are not invented as null');
});

// --- instagram_publish_media -----------------------------------------------

test('publish_media preview issues NO media_publish call', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'M1' }));
  const res = await tool('instagram_publish_media').handler({ creationId: 'C1' }, makeCtx(req));
  assert.equal(res.structuredContent?.mode, 'preview');
  assert.equal(calls.length, 0, 'preview must not publish');
});

test('publish_media preview names the exact container it would publish', async () => {
  // `summary` is what the operator reads in the preview and what the elicitation
  // prompt quotes back before they tick "yes". "Publish container", with no id,
  // asks consent for a category rather than for an act: with two containers in
  // flight nothing distinguishes the one about to become a public post, and
  // approving the wrong prompt publishes the wrong media to a live account.
  const { req, calls } = fakeReq(() => ({ id: 'M1' }));
  const res = await tool('instagram_publish_media').handler({ creationId: 'C1' }, makeCtx(req));

  assert.equal(res.structuredContent?.mode, 'preview');
  assert.equal(res.structuredContent?.summary, 'Publish container C1');
  assert.equal(calls.length, 0, 'a preview publishes nothing');
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

test('a profile with no numeric account id targets /me, never the local profile name', async () => {
  // `accountId` is optional — on the ig-login path a profile may carry only the
  // operator's local alias for the account. Falling back to that alias builds
  // `/work/media`, a path Graph cannot resolve, so every write for such a profile
  // fails with an object-not-found and the operator hunts a permissions problem
  // that does not exist. `me` is the one id that is always correct for the token.
  const creating = fakeReq(() => ({ id: 'C1' }));
  await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.jpg', apply: true },
    makeCtx(creating.req, { profile: { name: 'work', accountId: undefined } }),
  );
  assert.equal(creating.calls.length, 1);
  assert.equal(creating.calls[0]?.path, '/me/media');

  const publishing = fakeReq(() => ({ id: 'M1' }));
  await tool('instagram_publish_media').handler(
    { creationId: 'C1', apply: true },
    makeCtx(publishing.req, { profile: { name: 'work', accountId: undefined } }),
  );
  assert.equal(publishing.calls.length, 1);
  assert.equal(publishing.calls[0]?.path, '/me/media_publish');
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

test('post_image apply carries userTags and locationId onto the single-image container', async () => {
  // Tags and the place are the reason many posts are published at all: the tagged
  // accounts get the notification, and the post joins the location feed. Dropping
  // them is invisible in the result — the post goes live and looks correct — so
  // nobody notices until a collaborator asks why they were never tagged, by which
  // point the post is public and tags can no longer be attached to it.
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'C1' };
    if (opts.path === '/C1' && opts.method === 'GET') return { id: 'C1', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'M1' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  await runPostImage(
    {
      imageUrls: ['https://cdn/a.jpg'],
      userTags: [{ username: 'ana', x: 0.25, y: 0.75 }],
      locationId: '17841400000',
      apply: true,
    },
    makeCtx(req),
  );

  const create = calls.find((c) => c.path === '/999/media');
  assert.equal(create?.params?.user_tags, '[{"username":"ana","x":0.25,"y":0.75}]');
  assert.equal(create?.params?.location_id, '17841400000');
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

test('post_image apply puts the caption on the carousel album, not on its children', async () => {
  // A carousel is built child-first and only the album container carries text —
  // the children are bare images. Losing the caption there publishes a silent
  // album: no words, no hashtags, no @mentions, and no way to add them afterwards
  // except deleting the post and spending another slot of the account's rolling
  // publishing quota to redo it.
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

  await runPostImage(
    {
      imageUrls: ['https://cdn/1.jpg', 'https://cdn/2.jpg'],
      caption: 'Golden hour',
      locationId: '17841400000',
      apply: true,
    },
    makeCtx(req),
  );

  const album = calls.find((c) => c.params?.children !== undefined);
  assert.equal(album?.params?.children, 'ch-1,ch-2');
  assert.equal(album?.params?.caption, 'Golden hour');
  assert.equal(album?.params?.location_id, '17841400000');

  const kids = calls.filter((c) => c.params?.is_carousel_item === true);
  assert.equal(kids.length, 2, 'two child containers, neither of them captioned');
  assert.equal(kids[0]?.params?.caption, undefined);
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

test('resuming a container that is already PUBLISHED does not post it a second time', async () => {
  // The duplicate-post guard: a caller retrying after a lost response resumes a
  // container Instagram has already published. The flow must report it and stop,
  // never issue media_publish again (which would create a second post).
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/DONE' && opts.method === 'GET')
      return { id: 'DONE', status_code: 'PUBLISHED' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  const res = await runPostImage({ resumeContainerId: 'DONE', apply: true }, makeCtx(req));

  assert.equal(res.isError, undefined, 'an already-published container is not an error');
  assert.equal(res.structuredContent?.status, 'already_published');
  assert.equal(res.structuredContent?.container_id, 'DONE');
  assert.equal(res.structuredContent?.media_id, undefined, 'no new media id is invented');
  assert.match(String(res.structuredContent?.note), /NOT published again/);
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/DONE'],
    'only the status read happens — no create, no media_publish',
  );
});

test('a successful publish journals the media id that went live, not the container', async () => {
  // The container id is scaffolding: it expires, it is not addressable on
  // Instagram, and nothing links it back to the post. The media id is the only
  // handle naming the thing now visible on a real account. An audit trail that
  // stores the container answers "what did this server publish?" with a string
  // nobody can resolve — and the already-published branch is the one case where
  // the container genuinely IS the target, so the two must not collapse together.
  const livePath = join(journalDir, 'live-target.jsonl');
  const { req } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'C1' };
    if (opts.path === '/C1' && opts.method === 'GET') return { id: 'C1', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'M-LIVE' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  await runPostImage(
    { imageUrls: ['https://cdn/a.jpg'], apply: true },
    makeCtx(req, { settings: { writeJournal: livePath } }),
  );

  const rec = JSON.parse(readFileSync(livePath, 'utf8').trim()) as Record<string, unknown>;
  assert.equal(rec.action, 'post_image');
  assert.equal(rec.targetId, 'M-LIVE');

  const donePath = join(journalDir, 'resumed-target.jsonl');
  const resuming = fakeReq(() => ({ id: 'DONE', status_code: 'PUBLISHED' }));
  await runPostImage(
    { resumeContainerId: 'DONE', apply: true },
    makeCtx(resuming.req, { settings: { writeJournal: donePath } }),
  );

  const resumed = JSON.parse(readFileSync(donePath, 'utf8').trim()) as Record<string, unknown>;
  assert.equal(resumed.targetId, 'DONE');
});

test('post_image apply with an empty imageUrls list refuses before any network call', async () => {
  // Not reachable through the registry (zod enforces a non-empty array), but the
  // exported flow is also called directly, so the client-side guard must hold on
  // its own rather than letting a container be created from nothing.
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));

  await assert.rejects(
    () => runPostImage({ imageUrls: [], apply: true }, makeCtx(req)),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      /at least one imageUrl/.test(e.message),
  );
  assert.equal(calls.length, 0);
});

test('post_image refuses an 11-image carousel before creating a single child container', async () => {
  // The 2-10 bound is Instagram's, and the album is built child-first: an
  // 11-image call that is not stopped here creates eleven real containers and
  // only then has the album rejected by Graph. Every one of those was a write
  // against the account's rolling publishing quota, spent on a post that could
  // never have existed — and the caller gets a Graph error instead of the
  // client-side validation error that names the actual limit.
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));
  const urls = Array.from({ length: 11 }, (_, i) => `https://cdn/${i}.jpg`);

  await assert.rejects(
    () => runPostImage({ imageUrls: urls, apply: true }, makeCtx(req), { maxPollMs: 0 }),
    (e: unknown) =>
      e instanceof InstagramError && e.kind === 'validation' && /got 11/.test(e.message),
  );
  assert.equal(calls.length, 0, 'not one child container is created');
});

test('post_image refuses a plaintext http image URL anywhere in the list', async () => {
  // Instagram fetches these URLs itself, so an http:// source ships the media in
  // the clear and is trivially substitutable in transit — the account would
  // publish whatever an on-path attacker returned, under the operator's name.
  // The check is per URL, not on the first one: in a carousel the poisoned image
  // is rarely the one the caller happened to list first.
  for (const imageUrls of [['http://cdn/a.jpg'], ['https://cdn/1.jpg', 'http://cdn/2.jpg']]) {
    const { req, calls } = fakeReq(() => ({ id: 'C1' }));
    await assert.rejects(
      () => runPostImage({ imageUrls, apply: true }, makeCtx(req), { maxPollMs: 0 }),
      (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
      imageUrls.join(),
    );
    assert.equal(calls.length, 0, 'nothing is created from a rejected URL');
  }
});

test('post_image collects a format warning for every non-JPEG image in the carousel', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));
  const res = await runPostImage(
    { imageUrls: ['https://cdn/a.png', 'https://cdn/b.jpg', 'https://cdn/c.webp'] },
    makeCtx(req),
  );

  const details = res.structuredContent?.details as Record<string, unknown> | undefined;
  const warnings = details?.warnings as string[] | undefined;
  // One warning per offending URL — a single collapsed warning would leave the
  // operator guessing which of the three images is the problem.
  assert.equal(warnings?.length, 2, 'only the .png and the .webp are flagged');
  assert.match(warnings?.[0] ?? '', /".png"/);
  assert.match(warnings?.[1] ?? '', /".webp"/);
  assert.equal(details?.media_kind, 'carousel');
  assert.equal(details?.image_count, 3);
  assert.equal(calls.length, 0, 'a preview creates nothing');
});

test('the preview caption stats report hashtags and mentions under the right keys', async () => {
  // These numbers are the only pre-flight read an operator gets on a caption, and
  // they are checked against limits an order of magnitude apart (30 hashtags, 20
  // mentions). Swapped, a caption with 25 hashtags and 2 mentions previews as
  // comfortably inside both limits and is then rejected by Instagram at publish
  // time — or, the other way round, previews as over-limit and the operator
  // rewrites a caption that was fine all along.
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));
  const res = await runPostImage(
    { imageUrls: ['https://cdn/a.jpg'], caption: '#sun #sea @ana' },
    makeCtx(req),
  );

  const details = res.structuredContent?.details as Record<string, unknown> | undefined;
  assert.deepEqual(details?.caption, { characters: 14, hashtags: 2, mentions: 1 });
  assert.equal(calls.length, 0, 'a preview counts, it does not create');
});

test('post_image resume previews the container it would finish, not a new post', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));
  const res = await runPostImage({ resumeContainerId: 'C-PRIOR' }, makeCtx(req));

  const details = res.structuredContent?.details as Record<string, unknown> | undefined;
  assert.equal(details?.resume_container_id, 'C-PRIOR');
  assert.equal(details?.image_count, undefined, 'a resume does not describe itself as a new image');
  assert.match(String(res.structuredContent?.summary), /Resume publishing container C-PRIOR/);
  assert.equal(calls.length, 0);
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

test('post_reel apply transmits the shareToFeed choice in both directions', async () => {
  // share_to_feed decides whether the reel also lands on the profile grid, and it
  // is honoured only at container creation — it cannot be changed once the reel
  // is published. Dropping it silently substitutes Instagram's default for the
  // operator's decision in both directions: a reel meant for the grid never
  // reaches it, and a reel deliberately kept off the grid appears there anyway.
  for (const shareToFeed of [true, false]) {
    const { req, calls } = fakeReq((opts) => {
      if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'R1' };
      if (opts.path === '/R1' && opts.method === 'GET')
        return { id: 'R1', status_code: 'FINISHED' };
      if (opts.path === '/999/media_publish') return { id: 'RMEDIA' };
      throw new Error(`unexpected ${opts.method} ${opts.path}`);
    });

    const args = { videoUrl: 'https://cdn/v.mp4', shareToFeed, thumbOffset: 2500, apply: true };
    await runPostReel(args, makeCtx(req));

    const create = calls.find((c) => c.path === '/999/media');
    assert.equal(create?.params?.share_to_feed, shareToFeed, String(shareToFeed));
    assert.equal(create?.params?.thumb_offset, 2500, String(shareToFeed));
  }
});

test('post_reel without a videoUrl or resume id is a validation error naming videoUrl', async () => {
  // Without the guard the flow creates a REELS container with no source at all:
  // Graph accepts it, the ingest ends in ERROR, and a publishing slot of the
  // rolling quota is gone. The message has to name `videoUrl`, because the model
  // recovers from it unaided — a generic "cannot run with these arguments" leaves
  // it guessing which of six optional fields it forgot.
  const { req, calls } = fakeReq(() => ({ id: 'x' }));
  await assert.rejects(
    () => runPostReel({ apply: true }, makeCtx(req), { maxPollMs: 0 }),
    (e: unknown) =>
      e instanceof InstagramError && e.kind === 'validation' && /needs a videoUrl/.test(e.message),
  );
  assert.equal(calls.length, 0, 'no container is created for a reel with no video');
});

test('post_reel passes a cover through and refuses a plaintext one before any write', async () => {
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'R2' };
    if (opts.path === '/R2' && opts.method === 'GET') return { id: 'R2', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'RMEDIA' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });
  await runPostReel(
    { videoUrl: 'https://cdn/v.mp4', coverUrl: 'https://cdn/cover.jpg', apply: true },
    makeCtx(req),
  );
  assert.equal(
    calls.find((c) => c.path === '/999/media')?.params?.cover_url,
    'https://cdn/cover.jpg',
  );

  const rejecting = fakeReq(() => ({ id: 'x' }));
  await assert.rejects(
    () =>
      runPostReel(
        { videoUrl: 'https://cdn/v.mp4', coverUrl: 'http://cdn/cover.jpg', apply: true },
        makeCtx(rejecting.req),
      ),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
  assert.equal(rejecting.calls.length, 0, 'the reel is not created with a bad cover');
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

test('post_story names its source, and a resume describes the container it finishes', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'x' }));

  const fresh = await runPostStory({ videoUrl: 'https://cdn/s.mp4' }, makeCtx(req));
  const freshDetails = fresh.structuredContent?.details as Record<string, unknown> | undefined;
  assert.equal(freshDetails?.media_kind, 'story');
  assert.equal(freshDetails?.source, 'video', 'a video story is not described as an image');

  const resumed = await runPostStory({ resumeContainerId: 'S-PRIOR' }, makeCtx(req));
  const resumedDetails = resumed.structuredContent?.details as Record<string, unknown> | undefined;
  // A resume must read as "finish that one", never as "create a story" — the
  // whole point of the resume path is not posting a second story.
  assert.equal(resumedDetails?.resume_container_id, 'S-PRIOR');
  assert.equal(resumedDetails?.media_kind, undefined);
  assert.match(String(resumed.structuredContent?.summary), /Resume publishing container S-PRIOR/);

  assert.equal(calls.length, 0, 'neither preview touched the network');
});

test('post_story apply sends the image URL as image_url and never as video_url', async () => {
  // `image_url` and `video_url` select which ingest pipeline Instagram runs. A
  // dropped or swapped field does not fail fast: Graph accepts the container
  // create, then processing ends in ERROR — or worse, a story is published from
  // whichever URL did arrive. Both are spent quota and a wrong (or missing) story
  // on a live account, diagnosed only from an opaque container status.
  const image = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'S1' };
    if (opts.path === '/S1' && opts.method === 'GET') return { id: 'S1', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'SMEDIA' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });
  await runPostStory({ imageUrl: 'https://cdn/s.jpg', apply: true }, makeCtx(image.req));
  const imageCreate = image.calls.find((c) => c.path === '/999/media')?.params ?? {};
  assert.equal(imageCreate.image_url, 'https://cdn/s.jpg');
  assert.equal('video_url' in imageCreate, false, 'a photo story sends no video_url');

  const video = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'S2' };
    if (opts.path === '/S2' && opts.method === 'GET') return { id: 'S2', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'SMEDIA' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });
  await runPostStory({ videoUrl: 'https://cdn/s.mp4', apply: true }, makeCtx(video.req));
  const videoCreate = video.calls.find((c) => c.path === '/999/media')?.params ?? {};
  assert.equal(videoCreate.video_url, 'https://cdn/s.mp4');
  assert.equal('image_url' in videoCreate, false, 'a video story sends no image_url');
});

test('post_story refuses a plaintext image URL before creating anything', async () => {
  // The video arm is checked elsewhere; the image arm is the one a photo story
  // takes. Instagram fetches the URL server-side, so http:// publishes whatever
  // an on-path attacker returns, under the operator's account.
  const { req, calls } = fakeReq(() => ({ id: 'S1' }));
  await assert.rejects(
    () => runPostStory({ imageUrl: 'http://cdn/s.jpg', apply: true }, makeCtx(req)),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message ===
        'imageUrl must be a well-formed https:// URL (Instagram fetches media over HTTPS).',
  );
  assert.equal(calls.length, 0, 'nothing is created from a rejected URL');
});

test('post_story honours the poll budget it is handed instead of the default one', async () => {
  // `opts` is how a caller bounds the wait; dropping it silently substitutes the
  // 60 s default. That is not merely slower — an MCP client that times out first
  // never sees the `resume_container_id`, so the operator has no id to resume
  // with and the natural next move is to post again, duplicating the story.
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'S1' };
    if (opts.path === '/S1' && opts.method === 'GET')
      return { id: 'S1', status_code: 'IN_PROGRESS' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  const res = await runPostStory(
    { imageUrl: 'https://cdn/s.jpg', apply: true },
    { ...makeCtx(req), clock: autoClock() },
    { maxPollMs: 0 },
  );

  assert.equal(res.structuredContent?.status, 'in_progress');
  assert.equal(
    calls.filter((c) => c.path === '/S1').length,
    1,
    'a zero budget reads the status once and returns; it does not poll for a minute',
  );
});

test('post_story resume skips the both-or-neither check that a fresh story enforces', async () => {
  // Resuming carries no imageUrl and no videoUrl, which is exactly the shape the
  // fresh path rejects; the guard must be scoped to a fresh post or every resume
  // would be a validation error.
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/S9' && opts.method === 'GET') return { id: 'S9', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'SMEDIA' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  const res = await runPostStory({ resumeContainerId: 'S9', apply: true }, makeCtx(req));

  assert.equal(res.structuredContent?.status, 'published');
  assert.equal(res.structuredContent?.media_id, 'SMEDIA');
  assert.equal(
    calls.find((c) => c.path === '/999/media'),
    undefined,
    'no second container is created',
  );
});

// --- model-facing contract text ---------------------------------------------

test('the apply field documents preview-by-default and that an explicit false wins', () => {
  // This description is the only thing that tells the model what `apply` costs.
  // "Omitted (or false) previews it" reads as a formatting choice; the point is
  // that a preview calls NOTHING, so a model may safely explore. Losing the
  // second half is worse: with IG_WRITE_MODE=apply configured, a model that
  // believes `apply: false` is ignored has no way left to ask a question without
  // publishing, and stops sending it.
  for (const name of writeToolNames) {
    const doc = tool(name).input.apply?.description ?? '';
    assert.equal(doc.includes('non-mutating preview'), true, `${name}: preview is non-mutating`);
    assert.equal(doc.includes('calls nothing'), true, `${name}: a preview performs no call`);
    assert.equal(
      doc.includes('An explicit false always forces preview.'),
      true,
      `${name}: an explicit false overrides IG_WRITE_MODE=apply`,
    );
  }
});

test('the write descriptions never suggest that a duplicate post is harmless', () => {
  // Instagram has no idempotency key: every one of these paths, run twice,
  // produces two public posts and spends two slots of the rolling quota. The
  // descriptions and the resume field are the only place the model is told that,
  // and the safe recovery (resume the container id it already has) only happens
  // if the text says so. Text that says "or simply create a new post", or that a
  // repeat is de-duplicated, actively instructs the model to double-post.
  const create = tool('instagram_create_media_container').description;
  assert.equal(create.includes('This does NOT publish'), true, 'phase 1 does not publish');

  const publish = tool('instagram_publish_media').description;
  assert.equal(
    publish.includes('a repeated publish costs quota and posts a duplicate'),
    true,
    'publish_media states the cost of a retry',
  );

  const postImage = tool('instagram_post_image').description;
  assert.equal(
    postImage.includes('never create a new post, which would duplicate it'),
    true,
    'post_image points at resume, not at a fresh post',
  );

  for (const name of ['instagram_post_image', 'instagram_post_reel', 'instagram_post_story']) {
    const doc = tool(name).input.resumeContainerId?.description ?? '';
    assert.equal(
      doc.includes('instead of creating a new post (avoids a duplicate)'),
      true,
      `${name}: the resume field explains what it prevents`,
    );
  }
});

test('get_publishing_limit tells the model the quota total is read live, not hardcoded', () => {
  // Meta's own docs give conflicting totals (100 vs 50) and the real allowance is
  // per account. A description that names a fixed number invites the model to
  // compute headroom from that number instead of from `quota_total`, which is the
  // one value that came from the account being operated.
  const doc = tool('instagram_get_publishing_limit').description;
  assert.equal(doc.includes('never hardcoded'), true);
  assert.equal(/always \d+/.test(doc), false, 'no fixed total is asserted to the model');
});

// --- declared input schemas (what the SDK enforces before a handler runs) ----

test('the declared input schemas reject empty ids that would build a wrong Graph path', () => {
  // An empty id is not a harmless no-op: `/${id}` collapses to a path that either
  // 404s or, worse, addresses the parent collection. These fields are optional,
  // so an empty string is what a model produces when it "has no value" — the
  // schema is what turns that into a refusal instead of a request.
  assert.equal(
    inputOf('instagram_create_media_container').safeParse({ locationId: '' }).success,
    false,
  );
  assert.equal(
    inputOf('instagram_create_media_container').safeParse({ locationId: '17841400000' }).success,
    true,
  );

  assert.equal(inputOf('instagram_post_image').safeParse({ resumeContainerId: '' }).success, false);
  assert.equal(
    inputOf('instagram_post_image').safeParse({ resumeContainerId: 'C1' }).success,
    true,
  );

  assert.equal(inputOf('instagram_publish_media').safeParse({ creationId: '' }).success, false);
  assert.equal(inputOf('instagram_publish_media').safeParse({ creationId: 'C1' }).success, true);
});

test('every declared media URL field refuses a non-https URL at the schema boundary', () => {
  // Instagram fetches these URLs server-side. Over http:// the media travels in
  // the clear and an on-path attacker chooses what actually gets published under
  // the operator's account. The handlers re-check, but the schema is the boundary
  // that keeps the plaintext URL out of the audit log and out of the model's
  // successful-call history in the first place.
  const create = inputOf('instagram_create_media_container');
  for (const field of ['imageUrl', 'videoUrl', 'coverUrl']) {
    assert.equal(create.safeParse({ [field]: 'http://cdn/x' }).success, false, `${field} http`);
    assert.equal(create.safeParse({ [field]: 'https://cdn/x' }).success, true, `${field} https`);
  }

  const reel = inputOf('instagram_post_reel');
  for (const field of ['videoUrl', 'coverUrl']) {
    assert.equal(reel.safeParse({ [field]: 'http://cdn/x' }).success, false, `reel ${field} http`);
    assert.equal(reel.safeParse({ [field]: 'https://cdn/x' }).success, true, `reel ${field} https`);
  }

  const image = inputOf('instagram_post_image');
  assert.equal(image.safeParse({ imageUrls: ['http://cdn/a.jpg'] }).success, false);
  assert.equal(
    image.safeParse({ imageUrls: ['https://cdn/a.jpg', 'http://cdn/b.jpg'] }).success,
    false,
    'the check is per URL, not on the first one',
  );
  assert.equal(image.safeParse({ imageUrls: ['https://cdn/a.jpg'] }).success, true);
});

test('the carousel bounds are declared in the schema, not only re-checked in the handler', () => {
  // 2–10 is Instagram's own album range and the album is assembled child-first:
  // an 11-image call that reaches the handler has already cost eleven container
  // creates before Graph rejects the album. An empty child id is the same failure
  // one level down — it builds an album that references nothing.
  const create = inputOf('instagram_create_media_container');
  assert.equal(create.safeParse({ children: ['A'] }).success, false, '1 child is not a carousel');
  assert.equal(create.safeParse({ children: ['A', 'B'] }).success, true, '2 children is the floor');
  assert.equal(
    create.safeParse({ children: Array.from({ length: 10 }, (_, i) => `C${i}`) }).success,
    true,
    '10 children is the ceiling',
  );
  assert.equal(
    create.safeParse({ children: Array.from({ length: 11 }, (_, i) => `C${i}`) }).success,
    false,
    '11 children is over the ceiling',
  );
  assert.equal(create.safeParse({ children: ['A', ''] }).success, false, 'no empty child ids');

  const image = inputOf('instagram_post_image');
  assert.equal(image.safeParse({ imageUrls: [] }).success, false, 'a post needs an image');
  assert.equal(
    image.safeParse({ imageUrls: Array.from({ length: 10 }, (_, i) => `https://cdn/${i}.jpg`) })
      .success,
    true,
    '10 images is the ceiling',
  );
  assert.equal(
    image.safeParse({ imageUrls: Array.from({ length: 11 }, (_, i) => `https://cdn/${i}.jpg`) })
      .success,
    false,
    '11 images is over the ceiling',
  );
});

test('thumbOffset is declared as a whole, non-negative number of milliseconds', () => {
  // The offset picks the cover frame. Graph rejects a negative or fractional
  // offset at container creation, so anything the schema lets through is a failed
  // create the operator has to diagnose from a Graph error rather than from the
  // field they mistyped (seconds instead of milliseconds is the usual cause).
  for (const name of ['instagram_create_media_container', 'instagram_post_reel']) {
    const schema = inputOf(name);
    assert.equal(schema.safeParse({ thumbOffset: -1 }).success, false, `${name}: negative`);
    assert.equal(schema.safeParse({ thumbOffset: 1.5 }).success, false, `${name}: fractional`);
    assert.equal(schema.safeParse({ thumbOffset: 0 }).success, true, `${name}: zero`);
    assert.equal(schema.safeParse({ thumbOffset: 1500 }).success, true, `${name}: 1500ms`);
  }
});

// --- declared output schemas (validated by the SDK against structuredContent) -

test('get_container_status output requires the id and keeps both status fields optional', () => {
  // The SDK validates `structuredContent` against this shape and turns a mismatch
  // into a tool error. A freshly created container legitimately reports neither
  // `status_code` nor `status`, so requiring either converts the normal first poll
  // — the one that tells the operator ingest has started — into a failure. The id
  // is the opposite case: a status payload that cannot say which container it
  // describes is unusable when two containers are in flight.
  const schema = outputOf('instagram_get_container_status');
  assert.equal(schema.safeParse({ status_code: 'FINISHED' }).success, false, 'the id is required');
  assert.equal(schema.safeParse({ id: 'C1' }).success, true, 'a bare container is valid');
  assert.equal(schema.safeParse({ id: 'C1', status_code: 'ERROR', status: 'why' }).success, true);
});

test('get_publishing_limit output requires quota_usage and keeps the derived facts optional', () => {
  // `quota_usage` is the one number Instagram always returns, and the whole point
  // of the tool; the total, the window and `remaining` exist only when the account
  // reports a `config` block. Requiring them fails the read for exactly the
  // accounts whose quota is unknown — the ones an operator most needs to inspect.
  const schema = outputOf('instagram_get_publishing_limit');
  assert.equal(schema.safeParse({}).success, false, 'usage is required');
  assert.equal(schema.safeParse({ quota_usage: 3 }).success, true, 'an unknown total is valid');
  assert.equal(
    schema.safeParse({ quota_usage: 3, quota_total: 50, quota_duration: 86400, remaining: 47 })
      .success,
    true,
  );
});

// --- annotations ------------------------------------------------------------

test('no publishing tool is announced destructive — publishing creates, it does not destroy', () => {
  // `destructive` in this server means "removes or overwrites data that cannot be
  // restored through this server". Publishing creates new content. Marking it
  // destructive puts every ordinary post behind IG_ALLOW_DESTRUCTIVE, so operators
  // set that flag permanently — which is precisely how the genuinely destructive
  // tools (comment deletion) lose their second gate. Read tools declare no hint at
  // all: a `false` there would imply the question was ever relevant.
  for (const name of writeToolNames) {
    assert.equal(tool(name).annotations.destructiveHint, false, `${name} destructiveHint`);
  }
  assert.deepEqual(
    [...writeToolNames].sort((a, b) => a.localeCompare(b)),
    [
      'instagram_create_media_container',
      'instagram_post_image',
      'instagram_post_reel',
      'instagram_post_story',
      'instagram_publish_media',
    ],
  );
  for (const name of ['instagram_get_container_status', 'instagram_get_publishing_limit']) {
    assert.equal(tool(name).annotations.destructiveHint, undefined, `${name} destructiveHint`);
  }
});

// --- logFields --------------------------------------------------------------

test('the log records whether a video was supplied, not whether a cover was', () => {
  // `hasVideo` is what an operator greps when a reel or a container misbehaves.
  // Read off `coverUrl` it inverts in both directions: every reel published
  // without a cover logs `hasVideo:false`, and a plain image container that
  // carried a cover logs `hasVideo:true`. The log then contradicts the account.
  for (const name of ['instagram_create_media_container', 'instagram_post_reel']) {
    assert.equal(
      logFieldsOf(name, { videoUrl: 'https://cdn/v.mp4' }).hasVideo,
      true,
      `${name}: a video is a video`,
    );
    assert.equal(
      logFieldsOf(name, { coverUrl: 'https://cdn/c.jpg' }).hasVideo,
      false,
      `${name}: a cover is not a video`,
    );
  }
});

test('a container with no children is logged as zero children, not as a sentinel', () => {
  // `children` is the only field in the create line that says whether a container
  // was a carousel and how wide it was, and the log line is the after-the-fact
  // record — the container id it carries is what an operator follows when
  // reconciling a duplicated or half-published post. A default other than 0 for
  // the absent list makes every single-media create report a child count no
  // carousel can ever have, so counting children across the journal (or filtering
  // `children > 0` for the carousels) silently reads the wrong set.
  assert.equal(logFieldsOf('instagram_create_media_container', {}).children, 0);
  assert.equal(
    logFieldsOf('instagram_create_media_container', { imageUrl: 'https://cdn/a.jpg' }).children,
    0,
  );
  assert.equal(
    logFieldsOf('instagram_create_media_container', {
      mediaType: 'CAROUSEL',
      children: ['C1', 'C2', 'C3'],
    }).children,
    3,
  );
});

// --- create_media_container -------------------------------------------------

test('create_media_container refuses a plaintext imageUrl and names imageUrl in the refusal', () => {
  // The image arm of the https check, which nothing else covers: a feed image is
  // the one container kind with no videoUrl at all. Instagram fetches the URL, so
  // http:// publishes whatever an on-path attacker substitutes. The field name in
  // the message is what the model corrects — told "videoUrl", it retries with the
  // same poisoned image URL.
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));
  return assert
    .rejects(
      async () =>
        tool('instagram_create_media_container').handler(
          { imageUrl: 'http://cdn/a.jpg', apply: true },
          makeCtx(req),
        ),
      (e: unknown) =>
        e instanceof InstagramError &&
        e.kind === 'validation' &&
        e.message ===
          'imageUrl must be a well-formed https:// URL (Instagram fetches media over HTTPS).',
    )
    .then(() => {
      assert.equal(calls.length, 0, 'nothing is created from a rejected URL');
    });
});

test('create_media_container names the container kind it would create in the preview', async () => {
  // `summary` is the sentence the operator reads in the preview and the sentence
  // the elicitation prompt quotes before they tick "yes". "Create a media
  // container" asks consent for a category; the kind is the decision, because a
  // STORIES container that should have been a REELS one is a 24-hour story
  // instead of a permanent reel and cannot be converted after the fact. `IMAGE`
  // is not even a value Instagram accepts, so a preview that prints it describes
  // a call the server never makes.
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));

  const feed = await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.jpg' },
    makeCtx(req),
  );
  assert.equal(feed.structuredContent?.summary, 'Create a feed image media container');

  const reel = await tool('instagram_create_media_container').handler(
    { mediaType: 'REELS', videoUrl: 'https://cdn/v.mp4' },
    makeCtx(req),
  );
  assert.equal(reel.structuredContent?.summary, 'Create a REELS media container');

  assert.equal(calls.length, 0, 'neither preview touched the network');
});

test('a clean preview carries no warnings key at all, not an empty list', async () => {
  // The applied result is already covered; this is the preview, which is what the
  // operator actually reads before authorizing. An always-present `warnings: []`
  // trains both the operator and the model to skim past the field, so the one
  // preview that does carry a real format warning reads like all the others.
  const res = await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.jpg' },
    makeCtx(fakeReq(() => ({ id: 'C1' })).req),
  );
  const details = res.structuredContent?.details as Record<string, unknown> | undefined;
  assert.equal('warnings' in (details ?? {}), false);
});

test('create_media_container marks a carousel child so the album can reference it', async () => {
  // `is_carousel_item` is what makes a container eligible to be listed in an
  // album's `children`. Without it the child is created as an ordinary standalone
  // container — the create succeeds, and the failure only surfaces later when the
  // album create is rejected, after every child has already been made and paid
  // for. The flag is also deliberately sent only when true: Graph treats the
  // presence of the field as the marker.
  const marked = fakeReq(() => ({ id: 'CH1' }));
  await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.jpg', isCarouselItem: true, apply: true },
    makeCtx(marked.req),
  );
  assert.equal(marked.calls[0]?.params?.is_carousel_item, true);

  const plain = fakeReq(() => ({ id: 'C1' }));
  await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.jpg', apply: true },
    makeCtx(plain.req),
  );
  assert.equal('is_carousel_item' in (plain.calls[0]?.params ?? {}), false);
});

// --- get_container_status / publish_media -----------------------------------

test('get_container_status reports the id Graph returned, not the one that was asked for', async () => {
  // Echoing the request turns the read into a mirror that can never disagree with
  // the caller. The id is how an operator confirms the status they are looking at
  // belongs to the container they think they polled; if Graph resolves the request
  // to a different object, that is exactly the moment the discrepancy must show.
  const { req } = fakeReq(() => ({ id: 'C-GRAPH', status_code: 'FINISHED' }));
  const res = await tool('instagram_get_container_status').handler(
    { containerId: 'C-REQ' },
    makeCtx(req),
  );
  assert.equal(res.structuredContent?.id, 'C-GRAPH');
});

test('publish_media previews under the action name it journals and confirms with', async () => {
  // `action` is the key of the whole gate: it is the verb in the elicitation
  // prompt the human approves, the `action` field of the append-only write
  // journal, and the string an operator greps when reconstructing what this
  // server published. Renaming it splits the audit trail in two — the old name
  // still appears in past entries — while the prompt stops matching the tool.
  const { req, calls } = fakeReq(() => ({ id: 'M1' }));
  const res = await tool('instagram_publish_media').handler({ creationId: 'C1' }, makeCtx(req));
  assert.equal(res.structuredContent?.action, 'publish_media');
  assert.equal(calls.length, 0);

  const journal = join(journalDir, 'publish-action.jsonl');
  const applying = fakeReq(() => ({ id: 'M1' }));
  await tool('instagram_publish_media').handler(
    { creationId: 'C1', apply: true },
    makeCtx(applying.req, { settings: { writeJournal: journal } }),
  );
  const rec = JSON.parse(readFileSync(journal, 'utf8').trim()) as Record<string, unknown>;
  assert.equal(rec.action, 'publish_media');
});

// --- get_publishing_limit ---------------------------------------------------

test('get_publishing_limit reads the quota of the selected account, not of `me`', async () => {
  // `me` is whichever account the token belongs to. For an operator running
  // several profiles that is a different account than the one selected, so the
  // headroom reported is someone else's: they publish believing there is room and
  // hit the real window's limit mid-carousel.
  const { req, calls } = fakeReq(() => ({ data: [{ quota_usage: 1 }] }));
  await tool('instagram_get_publishing_limit').handler({}, makeCtx(req));
  assert.equal(calls[0]?.path, '/999/content_publishing_limit');
});

test('get_publishing_limit reports the rolling-window length and invents nothing', async () => {
  // `quota_duration` is what makes `quota_usage` mean anything — 10 posts used is
  // fine over 24 hours and impossible over an hour — and it is the only way to
  // know when the window frees up. Under a different key the field is silently
  // gone. The reverse matters just as much: an account that reports no `config`
  // must not be described with `quota_total: undefined` keys, because a caller
  // that sees the key present reads "the total is unknown-but-answered" rather
  // than "Instagram did not say".
  const { req } = fakeReq(() => ({
    data: [{ quota_usage: 10, config: { quota_total: 50, quota_duration: 86400 } }],
  }));
  const res = await tool('instagram_get_publishing_limit').handler({}, makeCtx(req));
  assert.deepEqual(res.structuredContent, {
    quota_usage: 10,
    quota_total: 50,
    quota_duration: 86400,
    remaining: 40,
  });

  const bare = fakeReq(() => ({ data: [{ quota_usage: 3 }] }));
  const unknown = await tool('instagram_get_publishing_limit').handler({}, makeCtx(bare.req));
  assert.deepEqual(unknown.structuredContent, { quota_usage: 3 });
});

// --- post_image -------------------------------------------------------------

test('post_image with no imageUrls at all refuses instead of inventing one', async () => {
  // The array is optional in the schema (a resume carries no URLs), so "absent"
  // and "empty" are different shapes and both have to be refused. Substituting a
  // default URL would publish a container built from a URL the caller never
  // supplied — a real post, on a real account, of content nobody chose.
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));
  await assert.rejects(
    () => runPostImage({ apply: true }, makeCtx(req), { maxPollMs: 0 }),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      /at least one imageUrl/.test(e.message),
  );
  assert.equal(calls.length, 0, 'nothing is created out of thin air');
});

test('post_image treats exactly two images as a carousel, in the details and the summary', async () => {
  // Two is the floor of Instagram's album range, and the boundary decides which
  // Graph call is made: one image is a single feed container, two is child-first
  // album assembly. Previewed as a single image, the operator authorizes one post
  // and gets an album built from two extra containers — and the count in the
  // summary is the only place they could have noticed before approving.
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));

  const pair = await runPostImage(
    { imageUrls: ['https://cdn/1.jpg', 'https://cdn/2.jpg'] },
    makeCtx(req),
  );
  const pairDetails = pair.structuredContent?.details as Record<string, unknown> | undefined;
  assert.equal(pairDetails?.media_kind, 'carousel');
  assert.equal(pairDetails?.image_count, 2);
  assert.equal(
    pair.structuredContent?.summary,
    'Create a 2-image carousel and publish it to the feed',
  );

  const three = await runPostImage(
    { imageUrls: ['https://cdn/1.jpg', 'https://cdn/2.jpg', 'https://cdn/3.jpg'] },
    makeCtx(req),
  );
  assert.equal(
    three.structuredContent?.summary,
    'Create a 3-image carousel and publish it to the feed',
  );

  const single = await runPostImage({ imageUrls: ['https://cdn/1.jpg'] }, makeCtx(req));
  const singleDetails = single.structuredContent?.details as Record<string, unknown> | undefined;
  assert.equal(singleDetails?.media_kind, 'image');
  assert.equal(singleDetails?.image_count, 1);
  assert.equal(
    single.structuredContent?.summary,
    'Create a single feed image container and publish it',
  );

  assert.equal(calls.length, 0, 'no preview touched the network');
});

test('post_image omits the warnings key entirely when every URL looks like a JPEG', async () => {
  // The warnings list is the only pre-flight signal about media format, because
  // the server never downloads the URL. An empty list attached to every clean
  // preview makes the field noise, and the one preview that carries a real
  // warning stops standing out.
  const { req } = fakeReq(() => ({ id: 'C1' }));
  const res = await runPostImage(
    { imageUrls: ['https://cdn/1.jpg', 'https://cdn/2.jpg'] },
    makeCtx(req),
  );
  const details = res.structuredContent?.details as Record<string, unknown> | undefined;
  assert.equal('warnings' in (details ?? {}), false);
});

test('post_image keeps polling within the default budget instead of giving up at once', async () => {
  // The registered handler must not hand the flow a zero budget: a container that
  // is FINISHED a moment later would come back `in_progress` on every single call,
  // so an operator asking for one post gets a resume id and no post — and the
  // obvious next move, calling post_image again, is exactly the duplicate the
  // resume path exists to prevent.
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'C1' };
    if (opts.path === '/C1' && opts.method === 'GET') {
      const seen = calls.filter((c) => c.path === '/C1').length;
      return { id: 'C1', status_code: seen > 1 ? 'FINISHED' : 'IN_PROGRESS' };
    }
    if (opts.path === '/999/media_publish') return { id: 'M1' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  const res = await tool('instagram_post_image').handler(
    { imageUrls: ['https://cdn/a.jpg'], apply: true },
    { ...makeCtx(req), clock: autoClock() },
  );

  assert.equal(res.structuredContent?.status, 'published');
  assert.equal(res.structuredContent?.media_id, 'M1');
  assert.equal(
    calls.filter((c) => c.path === '/C1').length,
    2,
    'the first IN_PROGRESS is followed by a second poll, not by a bail-out',
  );
});

test('an in_progress result journals the container id the operator must resume with', async () => {
  // This entry is the audit record of a write that really happened: a container
  // exists on the account and will publish or expire on Instagram's schedule. The
  // id is the only handle that can finish it. Journalling the action without a
  // target leaves the trail saying "something was started" with nothing to resume,
  // and the operator's remaining option is to post again.
  const path = join(journalDir, 'in-progress-target.jsonl');
  const { req } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'C-STUCK' };
    if (opts.path === '/C-STUCK' && opts.method === 'GET')
      return { id: 'C-STUCK', status_code: 'IN_PROGRESS' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  const res = await runPostImage(
    { imageUrls: ['https://cdn/a.jpg'], apply: true },
    makeCtx(req, { settings: { writeJournal: path } }),
    { maxPollMs: 0 },
  );
  assert.equal(res.structuredContent?.resume_container_id, 'C-STUCK');

  const rec = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>;
  assert.equal(rec.action, 'post_image');
  assert.equal(rec.targetId, 'C-STUCK');
});

// --- post_reel --------------------------------------------------------------

test('post_reel validates the video URL itself, not whichever URL happens to be present', async () => {
  // A reel with an https cover and an http video is the case that separates
  // "checked the video" from "checked something". Instagram fetches the video
  // server-side, so a plaintext source is content an on-path attacker chooses,
  // published as a reel under the operator's account.
  const { req, calls } = fakeReq(() => ({ id: 'R1' }));
  await assert.rejects(
    () =>
      runPostReel(
        { videoUrl: 'http://cdn/v.mp4', coverUrl: 'https://cdn/c.jpg', apply: true },
        makeCtx(req),
        { maxPollMs: 0 },
      ),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message ===
        'videoUrl must be a well-formed https:// URL (Instagram fetches media over HTTPS).',
  );
  assert.equal(calls.length, 0, 'no reel container is created from a plaintext video URL');
});

test('post_reel enforces the caption limits before creating anything', async () => {
  // Instagram rejects an over-limit caption at publish, not at create — so without
  // this check the reel container is created and ingested first, and the failure
  // arrives after the account has already paid for it. The client-side guard is
  // also the only thing that reports the limit as a limit rather than as an opaque
  // Graph error.
  const { req, calls } = fakeReq(() => ({ id: 'R1' }));
  await assert.rejects(
    () =>
      runPostReel(
        { videoUrl: 'https://cdn/v.mp4', caption: 'x'.repeat(2201), apply: true },
        makeCtx(req),
        { maxPollMs: 0 },
      ),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
  assert.equal(calls.length, 0, 'the reel container is never created');
});

test('post_reel carries the location id onto the REELS container', async () => {
  // The location is only settable at container creation and cannot be added to a
  // published reel. Dropping it is invisible in the result — the reel goes live
  // and looks right — but it never joins the place feed, which for many posts is
  // the entire reason they were published.
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'R1' };
    if (opts.path === '/R1' && opts.method === 'GET') return { id: 'R1', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'RMEDIA' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  await runPostReel(
    { videoUrl: 'https://cdn/v.mp4', locationId: '17841400000', apply: true },
    makeCtx(req),
  );
  assert.equal(calls.find((c) => c.path === '/999/media')?.params?.location_id, '17841400000');
});

test('post_reel previews a fresh reel as a reel and a resume as a resume', async () => {
  // These two details blocks are how the operator tells the two acts apart before
  // approving: one creates a new reel, the other only finishes a container that
  // already exists. Swapped, a resume preview advertises a fresh post (and a
  // fresh preview shows an empty resume id), which is the exact confusion that
  // ends in the same reel being published twice. `media_kind` must also say
  // "reel": a reel is not an ordinary video post and cannot be converted later.
  const { req, calls } = fakeReq(() => ({ id: 'x' }));

  const fresh = await runPostReel({ videoUrl: 'https://cdn/v.mp4' }, makeCtx(req));
  const freshDetails = fresh.structuredContent?.details as Record<string, unknown> | undefined;
  assert.equal(freshDetails?.media_kind, 'reel');
  assert.equal('resume_container_id' in (freshDetails ?? {}), false);

  const resumed = await runPostReel({ resumeContainerId: 'R-PRIOR' }, makeCtx(req));
  const resumedDetails = resumed.structuredContent?.details as Record<string, unknown> | undefined;
  assert.equal(resumedDetails?.resume_container_id, 'R-PRIOR');
  assert.equal('media_kind' in (resumedDetails ?? {}), false);

  assert.equal(calls.length, 0, 'neither preview touched the network');
});

// --- the declared surface a client sees before any call ---------------------

test('every publishing tool keeps the title that identifies what it does', () => {
  // The title is the label in a client's tool picker and in the approval prompt.
  // Two of these are one word apart from a different act — "Create media
  // container" versus "Publish media container", "Post an Instagram story"
  // versus "Post to Instagram" — and the operator approving a write reads the
  // title, not the tool id. A title that names the wrong phase gets consent for
  // the wrong thing.
  assert.deepEqual(
    publishingTools.map((t) => [t.name, t.title]),
    [
      ['instagram_create_media_container', 'Create Instagram media container'],
      ['instagram_get_container_status', 'Get media container status'],
      ['instagram_publish_media', 'Publish media container'],
      ['instagram_get_publishing_limit', 'Get publishing rate limit'],
      ['instagram_post_image', 'Post an Instagram image or carousel'],
      ['instagram_post_reel', 'Post an Instagram reel'],
      ['instagram_post_story', 'Post an Instagram story'],
    ],
  );
});

test('the publishing package registers all seven tools in a stable order', () => {
  // This array is the package: a tool missing from it is not registered at all,
  // and the model silently loses a capability — most damagingly `post_image`'s
  // resume path or `get_container_status`, without which an in_progress result
  // cannot be finished and the only way forward is a duplicate post. The order
  // is pinned because it is the order a client lists them in.
  assert.deepEqual(
    publishingTools.map((t) => t.name),
    [
      'instagram_create_media_container',
      'instagram_get_container_status',
      'instagram_publish_media',
      'instagram_get_publishing_limit',
      'instagram_post_image',
      'instagram_post_reel',
      'instagram_post_story',
    ],
  );
});

test('the shared input fields document the rules a model cannot infer', () => {
  // Nothing in the wire format tells a model that captions are capped, that
  // `locationId` wants a numeric Page id rather than a place name, or that a
  // resume ignores the media arguments. Each of those, unstated, produces a call
  // that Graph rejects — or worse, for the resume case, a model that re-sends the
  // image URLs and expects them to take effect on a container already built.
  const caption = tool('instagram_create_media_container').input.caption?.description ?? '';
  assert.equal(caption.includes('≤ 2200 characters'), true);
  assert.equal(caption.includes('≤ 30 hashtags'), true);
  assert.equal(caption.includes('≤ 20 @mentions'), true);

  const location = tool('instagram_create_media_container').input.locationId?.description ?? '';
  assert.equal(location.includes('location Page id'), true);

  const resume = tool('instagram_post_image').input.resumeContainerId?.description ?? '';
  assert.equal(resume.includes('When set, the media inputs are ignored.'), true);
});

test('create_media_container documents the values Instagram actually accepts', () => {
  // `IMAGE` and `VIDEO` are not valid `media_type` values — a feed image sends no
  // media_type at all. A description that lists IMAGE as a choice makes the model
  // send it, and every feed-image create fails. The children field carries the
  // album range for the same reason: the schema rejects 11, but only the text
  // explains why so the model splits the post instead of retrying.
  const mediaType = tool('instagram_create_media_container').input.mediaType?.description ?? '';
  assert.equal(mediaType.includes('OMIT for a single feed image'), true);
  assert.equal(mediaType.includes('IMAGE/VIDEO are invalid values'), true);

  const children = tool('instagram_create_media_container').input.children?.description ?? '';
  assert.equal(children.includes('2–10 previously-created child container ids'), true);

  const carouselItem =
    tool('instagram_create_media_container').input.isCarouselItem?.description ?? '';
  assert.equal(carouselItem.includes('carousel child'), true);

  const images = tool('instagram_post_image').input.imageUrls?.description ?? '';
  assert.equal(
    images.includes('One URL posts a single feed image; 2–10 URLs post a carousel'),
    true,
  );
});

test('the phase-2 tools document the FINISHED precondition and the failure states', () => {
  // Publishing a container that is not FINISHED fails, and the two ways a
  // container ends — ERROR and EXPIRED — are unrecoverable: they need a fresh
  // container, not more polling. A description that says "keep polling" for those
  // states makes the model spin against a container that will never finish, while
  // the media it was supposed to publish never goes out.
  const creationId = tool('instagram_publish_media').input.creationId?.description ?? '';
  assert.equal(creationId.includes('FINISHED'), true);

  const status = tool('instagram_get_container_status').description;
  assert.equal(status.includes('IN_PROGRESS means keep polling (do not re-create)'), true);
  assert.equal(status.includes('ERROR/EXPIRED means re-create the container.'), true);
});

test('the reel and story descriptions keep their own resume-not-repost rule', () => {
  // Each composite tool is described independently, so the duplicate-post warning
  // has to survive in each one. A reel or a story that is still processing is a
  // container that will publish on Instagram's schedule; "or create a new post"
  // tells the model to publish the same video twice. The story text also carries
  // the 24-hour expiry, which is the difference between "it will show up" and
  // "the window has closed".
  const reel = tool('instagram_post_reel').description;
  assert.equal(reel.includes('never create a new post'), true);
  assert.equal(reel.includes('reels can take a while'), true);

  const story = tool('instagram_post_story').description;
  assert.equal(story.includes('never create a new post'), true);
  assert.equal(story.includes('Stories expire after 24 hours.'), true);
  // The resume path is only usable if the model knows the field to read it from.
  assert.equal(story.includes('status=in_progress with a resume_container_id'), true);
  assert.equal(reel.includes('status=in_progress with a resume_container_id'), true);
  assert.equal(story.includes('Provide exactly one of imageUrl or videoUrl.'), true);
});

test('get_container_status refuses an empty container id', () => {
  // `/${containerId}` with an empty id addresses the API root instead of a
  // container, so an empty string turns a status read into a request for
  // something else entirely — and whatever comes back is reported to the model as
  // this container's status.
  assert.equal(
    inputOf('instagram_get_container_status').safeParse({ containerId: '' }).success,
    false,
  );
  assert.equal(
    inputOf('instagram_get_container_status').safeParse({ containerId: 'C1' }).success,
    true,
  );
});

test('the declared input and output vocabularies are exactly these fields', () => {
  // The declared shape is the contract: a field that quietly appears is a field a
  // model will try to use (a `force` or `igId` knob would be read as a supported
  // way around the write gate or the selected account), and a field that
  // disappears is a capability the model can no longer reach. Pinning the member
  // lists — not their count — is what makes either change fail here rather than
  // in production.
  assert.deepEqual(Object.keys(tool('instagram_create_media_container').input), [
    'mediaType',
    'imageUrl',
    'videoUrl',
    'caption',
    'locationId',
    'userTags',
    'children',
    'coverUrl',
    'thumbOffset',
    'shareToFeed',
    'isCarouselItem',
    'apply',
  ]);
  assert.deepEqual(Object.keys(tool('instagram_post_image').input), [
    'imageUrls',
    'caption',
    'locationId',
    'userTags',
    'resumeContainerId',
    'apply',
  ]);
  assert.deepEqual(Object.keys(tool('instagram_get_container_status').output ?? {}), [
    'id',
    'status_code',
    'status',
  ]);
  assert.deepEqual(Object.keys(tool('instagram_get_publishing_limit').output ?? {}), [
    'quota_usage',
    'quota_total',
    'quota_duration',
    'remaining',
  ]);
});

test('a carousel is assembled in the order the images were given', () => {
  // The first child of an album is its cover — the single frame that represents
  // the post everywhere it appears. Reversing the children silently republishes
  // the same set with a different cover and a different narrative order, and
  // nothing in the result says so: the album id and the media id look identical
  // either way. Once published, the order cannot be edited.
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') {
      if (opts.params?.children !== undefined) return { id: 'ALBUM' };
      return { id: `CH${calls.filter((c) => c.path === '/999/media').length}` };
    }
    if (opts.path === '/ALBUM' && opts.method === 'GET')
      return { id: 'ALBUM', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'M1' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  return runPostImage(
    { imageUrls: ['https://cdn/1.jpg', 'https://cdn/2.jpg', 'https://cdn/3.jpg'], apply: true },
    makeCtx(req),
  ).then(() => {
    const children = calls
      .filter((c) => c.path === '/999/media' && c.params?.image_url !== undefined)
      .map((c) => c.params?.image_url);
    assert.deepEqual(children, ['https://cdn/1.jpg', 'https://cdn/2.jpg', 'https://cdn/3.jpg']);
    assert.equal(
      calls.find((c) => c.params?.children !== undefined)?.params?.children,
      'CH1,CH2,CH3',
    );
  });
});

test('post_reel and post_story keep polling within the default budget too', async () => {
  // Same registered-handler trap as post_image, and worse for these two: a reel is
  // the slowest thing Instagram ingests, so a zero budget would make every single
  // reel and story come back `in_progress` with nothing published — and the
  // model's natural retry is a second post of the same video.
  const flow = (containerId: string, mediaId: string) => {
    const { req, calls } = fakeReq((opts) => {
      if (opts.path === '/999/media' && opts.method === 'POST') return { id: containerId };
      if (opts.path === `/${containerId}` && opts.method === 'GET') {
        const seen = calls.filter((c) => c.path === `/${containerId}`).length;
        return { id: containerId, status_code: seen > 1 ? 'FINISHED' : 'IN_PROGRESS' };
      }
      if (opts.path === '/999/media_publish') return { id: mediaId };
      throw new Error(`unexpected ${opts.method} ${opts.path}`);
    });
    return { req, calls };
  };

  const reel = flow('R1', 'MR');
  const reelRes = await tool('instagram_post_reel').handler(
    { videoUrl: 'https://cdn/r.mp4', apply: true },
    { ...makeCtx(reel.req), clock: autoClock() },
  );
  assert.equal(reelRes.structuredContent?.status, 'published');
  assert.equal(reelRes.structuredContent?.media_id, 'MR');
  assert.equal(reel.calls.filter((c) => c.path === '/R1').length, 2);

  const story = flow('S1', 'MS');
  const storyRes = await tool('instagram_post_story').handler(
    { imageUrl: 'https://cdn/s.jpg', apply: true },
    { ...makeCtx(story.req), clock: autoClock() },
  );
  assert.equal(storyRes.structuredContent?.status, 'published');
  assert.equal(storyRes.structuredContent?.media_id, 'MS');
  assert.equal(story.calls.filter((c) => c.path === '/S1').length, 2);
});

test('the poll budget a caller passes is the budget the flow actually uses', async () => {
  // `opts` is the only way to bound the poll loop; if the driver dropped it, every
  // call would sit on the full default budget instead. Pinned by counting status
  // reads: a zero budget means exactly one status read and then a resume id, not a
  // loop that keeps asking.
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'C1' };
    if (opts.path === '/C1' && opts.method === 'GET')
      return { id: 'C1', status_code: 'IN_PROGRESS' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  const res = await runPostImage(
    { imageUrls: ['https://cdn/a.jpg'], apply: true },
    { ...makeCtx(req), clock: autoClock() },
    { maxPollMs: 0 },
  );

  assert.equal(res.structuredContent?.status, 'in_progress');
  assert.equal(calls.filter((c) => c.path === '/C1').length, 1);
});

test('caption limits are reported before URL form, so the caption is not hidden', async () => {
  // Instagram truncates nothing: an over-limit caption fails the post outright. A
  // caller who sent both a too-long caption and a plaintext URL must be told about
  // the caption on the first attempt — otherwise they fix the URL, re-send, and
  // discover the real blocker only on the second round trip. Both refusals happen
  // before any container is created, so neither costs a write.
  const { req, calls } = fakeReq(() => {
    throw new Error('validation must fail before any request');
  });
  const long = 'a'.repeat(2201);

  await assert.rejects(
    async () =>
      tool('instagram_create_media_container').handler(
        { caption: long, imageUrl: 'http://cdn/a.jpg', apply: true },
        makeCtx(req),
      ),
    /Caption exceeds 2200 characters/,
  );
  await assert.rejects(
    () =>
      runPostImage({ caption: long, imageUrls: ['http://cdn/a.jpg'], apply: true }, makeCtx(req)),
    /Caption exceeds 2200 characters/,
  );
  assert.deepEqual(calls, [], 'neither refusal reached Instagram');
});

test('post_reel names the video URL, not the cover, when both are plaintext', async () => {
  // The video is the post; the cover is decoration. Naming the cover first sends
  // the caller to fix the wrong field, and a reel whose video URL is plaintext can
  // never be ingested no matter what the cover says.
  const { req, calls } = fakeReq(() => {
    throw new Error('validation must fail before any request');
  });

  await assert.rejects(
    () =>
      runPostReel(
        { videoUrl: 'http://cdn/v.mp4', coverUrl: 'http://cdn/c.jpg', apply: true },
        makeCtx(req),
      ),
    /^InstagramError: videoUrl must be a well-formed https:\/\/ URL/,
  );
  assert.deepEqual(calls, []);
});

// --- what the operator and the audit trail are actually told -----------------

test('the in_progress note spells out that re-posting would duplicate the post', async () => {
  // This note is the only instruction the model gets at the one moment it is most
  // likely to do damage: the call returned without a media id, so the obvious move
  // is to call post_image again — which publishes the same media twice on a real
  // account, irreversibly and at quota cost. The note has to name the resume
  // mechanism AND forbid the alternative, not just report the state.
  const { req } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'C1' };
    if (opts.path === '/C1' && opts.method === 'GET')
      return { id: 'C1', status_code: 'IN_PROGRESS' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  const res = await runPostImage({ imageUrls: ['https://cdn/a.jpg'], apply: true }, makeCtx(req), {
    maxPollMs: 0,
  });

  const note = res.structuredContent?.note;
  assert.equal(typeof note, 'string');
  const text = typeof note === 'string' ? note : '';
  assert.equal(text.includes('Re-run this tool with apply:true'), true);
  assert.equal(text.includes('resumeContainerId set to this id'), true);
  assert.equal(text.includes('do NOT create a new post'), true);
  assert.equal(text.includes('duplicate it'), true);
});

test('create_media_container sends the caption it previewed, not an empty one', async () => {
  // The caption is the post. A container created without it publishes a silent,
  // unlabelled post that cannot be captioned afterwards — the only fix is to
  // delete and re-post. The location id travels the same way and is equally
  // unfixable after publish.
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));

  await tool('instagram_create_media_container').handler(
    {
      imageUrl: 'https://cdn/a.jpg',
      caption: 'Golden hour on the pier',
      locationId: '17841400000',
      apply: true,
    },
    makeCtx(req),
  );

  assert.equal(calls[0]?.params?.caption, 'Golden hour on the pier');
  assert.equal(calls[0]?.params?.location_id, '17841400000');
});

test('an applied create journals the container it created as the write target', async () => {
  // The journal is the after-the-fact answer to "what did this server do on my
  // account?". A record with an action but no targetId says a container was
  // created and refuses to say which — so an operator auditing an unexpected post
  // cannot tie it to a call, and cannot tell this container from any other created
  // that day.
  const createPath = join(journalDir, 'create-target.jsonl');
  const { req } = fakeReq(() => ({ id: 'C-JOURNAL' }));

  await tool('instagram_create_media_container').handler(
    { imageUrl: 'https://cdn/a.jpg', apply: true },
    makeCtx(req, { settings: { writeJournal: createPath } }),
  );

  const rec = JSON.parse(readFileSync(createPath, 'utf8').trim()) as Record<string, unknown>;
  assert.equal(rec.action, 'create_media_container');
  assert.equal(rec.targetId, 'C-JOURNAL');
});

test('publish_media previews exactly which container it would publish', async () => {
  // `details` is what an elicitation prompt renders for the human. Publishing is
  // the single irreversible act in this package, so a prompt that says only
  // "publish a container" — or names the id under a key the prompt does not read —
  // asks for consent to publish something unspecified. The whole point of the
  // confirmation is that the operator can check the id first.
  const { req, calls } = fakeReq(() => ({ id: 'M1' }));

  const res = await tool('instagram_publish_media').handler({ creationId: 'C-42' }, makeCtx(req));

  assert.deepEqual(res.structuredContent?.details, { creation_id: 'C-42' });
  assert.equal(calls.length, 0, 'a preview publishes nothing');
});

test('post_image builds the single-image container from the URL and caption given', async () => {
  // The one-image path has no carousel helper behind it: whatever it forgets here
  // is simply absent from the post. A container with no image_url is rejected or
  // fetches nothing; a container with no caption publishes an unlabelled post. And
  // a single feed image must carry no media_type at all — IMAGE and CAROUSEL are
  // both invalid for it, so a stray media_type fails the create outright.
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'C1' };
    if (opts.path === '/C1' && opts.method === 'GET') return { id: 'C1', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'M1' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  await runPostImage(
    { imageUrls: ['https://cdn/only.jpg'], caption: 'Solo shot', apply: true },
    makeCtx(req),
  );

  const create = calls.find((c) => c.path === '/999/media' && c.method === 'POST');
  assert.equal(create?.params?.image_url, 'https://cdn/only.jpg');
  assert.equal(create?.params?.caption, 'Solo shot');
  assert.equal('media_type' in (create?.params ?? {}), false);
});

test('post_reel sends the caption on the REELS container', async () => {
  // A reel's caption carries its hashtags, and hashtags are how a reel is
  // distributed at all. Dropping it publishes a reel that reaches nobody, and the
  // caption cannot be added to a container after it is created.
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'R1' };
    if (opts.path === '/R1' && opts.method === 'GET') return { id: 'R1', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'MR' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  await runPostReel(
    { videoUrl: 'https://cdn/v.mp4', caption: 'Behind the scenes #film', apply: true },
    makeCtx(req),
  );

  const create = calls.find((c) => c.path === '/999/media' && c.method === 'POST');
  assert.equal(create?.params?.caption, 'Behind the scenes #film');
  assert.equal(create?.params?.media_type, 'REELS');
});

test('a reel preview reports the cross-post choice exactly as it was made', async () => {
  // Cross-posting to the feed is a separate publication to a separate audience,
  // and it cannot be undone by editing — only by deleting the feed post. So the
  // preview must show the caller's actual choice: an omitted flag has to read as
  // "not set" rather than as "yes", and it has to appear under the key the prompt
  // renders. The summary names the medium for the same reason — a reel and a story
  // reach different places and expire differently.
  const { req } = fakeReq(() => ({ id: 'x' }));

  const unset = await runPostReel({ videoUrl: 'https://cdn/v.mp4' }, makeCtx(req));
  assert.deepEqual(unset.structuredContent?.details, {
    media_kind: 'reel',
    share_to_feed: undefined,
  });
  assert.equal(unset.structuredContent?.summary, 'Create a reel container and publish it');

  const off = await runPostReel(
    { videoUrl: 'https://cdn/v.mp4', shareToFeed: false },
    makeCtx(req),
  );
  assert.deepEqual(off.structuredContent?.details, { media_kind: 'reel', share_to_feed: false });
});

test('post_reel honours the poll budget it is handed', async () => {
  // Same driver as post_image, checked separately because a reel is the slowest
  // ingest: if the reel path ignored the budget it was given, a caller who asked
  // for a bounded attempt would instead sit on the full default while Instagram
  // processes video.
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/999/media' && opts.method === 'POST') return { id: 'R1' };
    if (opts.path === '/R1' && opts.method === 'GET')
      return { id: 'R1', status_code: 'IN_PROGRESS' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  const res = await runPostReel(
    { videoUrl: 'https://cdn/v.mp4', apply: true },
    { ...makeCtx(req), clock: autoClock() },
    { maxPollMs: 0 },
  );

  assert.equal(res.structuredContent?.status, 'in_progress');
  assert.equal(res.structuredContent?.resume_container_id, 'R1');
  assert.equal(calls.filter((c) => c.path === '/R1').length, 1);
});
