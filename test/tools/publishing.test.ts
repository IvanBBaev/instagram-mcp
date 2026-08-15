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
import { InstagramError } from '../../src/core/types.js';
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

test('post_reel without a videoUrl or resume id is a validation error', async () => {
  const { req } = fakeReq(() => ({ id: 'x' }));
  await assert.rejects(
    () => runPostReel({ apply: true }, makeCtx(req)),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
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
