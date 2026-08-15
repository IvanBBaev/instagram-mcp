/**
 * Unit tests for the `account` tool specs. Handlers run against a hand-built
 * {@link ToolContext} (fake `req`, stub settings/profile/log, `fakeClock`) and
 * are asserted to produce a well-formed {@link ToolResult} with the expected
 * `structuredContent` and untrusted fields wrapped by `fence()`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext, ToolResult, ToolSpec } from '../../src/mcp/define.js';
import type {
  IgRequestFn,
  IgRequestOptions,
  Logger,
  ResolvedProfile,
  Settings,
} from '../../src/core/types.js';
import type { Clock } from '../../src/core/clock.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { fence } from '../../src/mcp/result.js';
import { accountTools } from '../../src/tools/account.js';
import { testSettings } from '../helpers/settings.js';

const DAY = 86_400_000;

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

const baseProfile: ResolvedProfile = {
  name: 'default',
  authPath: 'ig-login',
  accessToken: 'token-abc',
};

function stubReq(responder: (opts: IgRequestOptions) => unknown): {
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

function makeCtx(opts: {
  req: IgRequestFn;
  profile?: Partial<ResolvedProfile>;
  settings?: Partial<Settings>;
  clock?: Clock;
}): ToolContext {
  return {
    req: opts.req,
    settings: { ...baseSettings, ...opts.settings },
    profile: { ...baseProfile, ...opts.profile },
    clock: opts.clock ?? fakeClock(0),
    log: noopLog,
  };
}

function tool(name: string): ToolSpec {
  const found = accountTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} is present`);
  return found;
}

function sc(res: ToolResult): Record<string, unknown> {
  assert.ok(res.structuredContent, 'structuredContent is present');
  return res.structuredContent;
}

// --- surface / spec shape --------------------------------------------------

test('accountTools exposes exactly the three documented account read tools', () => {
  assert.deepEqual(
    accountTools.map((t) => t.name),
    ['instagram_get_account', 'instagram_list_linked_accounts', 'instagram_token_status'],
  );
});

test('every account tool is a well-formed read-only spec in the account package', () => {
  for (const t of accountTools) {
    assert.match(t.name, /^instagram_[a-z_]+$/);
    assert.equal(t.package, 'account');
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.openWorldHint, true);
    assert.equal(typeof t.input, 'object');
    assert.equal(typeof t.handler, 'function');
  }
});

test('only list_linked_accounts is restricted to the fb-login path', () => {
  assert.deepEqual(tool('instagram_list_linked_accounts').paths, ['fb-login']);
  assert.equal(tool('instagram_get_account').paths, undefined);
  assert.equal(tool('instagram_token_status').paths, undefined);
});

// --- instagram_get_account -------------------------------------------------

test('get_account returns fenced profile text and raw numeric counts', async () => {
  const { req, calls } = stubReq(() => ({
    id: '178414',
    username: 'acme',
    name: 'ACME Co',
    biography: 'We make anvils',
    website: 'https://acme.example',
    profile_picture_url: 'https://cdn.example/pic.jpg',
    followers_count: 1200,
    follows_count: 42,
    media_count: 87,
  }));
  const ctx = makeCtx({ req, profile: { accountId: '178414' } });

  const res = await tool('instagram_get_account').handler({}, ctx);

  assert.equal(calls[0]!.path, '/178414');
  assert.equal(res.content[0]?.type, 'text');
  assert.ok((res.content[0]?.text.length ?? 0) > 0);

  const body = sc(res);
  assert.equal(body.id, '178414');
  assert.equal(body.username, fence('acme'));
  assert.equal(body.name, fence('ACME Co'));
  assert.equal(body.biography, fence('We make anvils'));
  assert.equal(body.website, fence('https://acme.example'));
  // Fencing actually changed the value (defence against a no-op fence).
  assert.notEqual(body.username, 'acme');
  // Non-text fields are surfaced raw.
  assert.equal(body.profilePictureUrl, 'https://cdn.example/pic.jpg');
  assert.equal(body.followersCount, 1200);
  assert.equal(body.followsCount, 42);
  assert.equal(body.mediaCount, 87);
});

test('get_account falls back to /me when no account ID is resolved, and omits absent fields', async () => {
  const { req, calls } = stubReq(() => ({ id: '999' }));
  const ctx = makeCtx({ req });

  const res = await tool('instagram_get_account').handler({}, ctx);

  assert.equal(calls[0]!.path, '/me');
  const body = sc(res);
  assert.equal(body.id, '999');
  assert.equal(body.username, undefined);
  assert.equal(body.biography, undefined);
});

test('get_account renders its text block according to the prettyJson setting', async () => {
  // The text block is the only payload a client without structured-output
  // support ever sees, and `IG_PRETTY_JSON` is the operator's knob for how it is
  // rendered. The handler has to hand that setting to `json()`; a handler that
  // called `json(structured)` would look correct in every content assertion
  // above while silently pinning every deployment to the compact rendering.
  const wire = { id: '178414', username: 'acme', followers_count: 12 };

  const compact = await tool('instagram_get_account').handler(
    {},
    makeCtx({ req: stubReq(() => wire).req, settings: { prettyJson: false } }),
  );
  const compactText = String(compact.content[0]?.text);
  assert.equal(compactText, JSON.stringify(sc(compact)));
  assert.equal(compactText.includes('\n'), false, 'the default rendering is single-line');

  const pretty = await tool('instagram_get_account').handler(
    {},
    makeCtx({ req: stubReq(() => wire).req, settings: { prettyJson: true } }),
  );
  const prettyText = String(pretty.content[0]?.text);
  // The killer: with prettyJson on, the text must be the two-space indented form
  // of exactly the same structured payload.
  assert.equal(prettyText, JSON.stringify(sc(pretty), null, 2));
  assert.ok(prettyText.includes('\n  "id": "178414"'), 'the payload is indented, not compact');
});

// --- instagram_list_linked_accounts ----------------------------------------

test('list_linked_accounts fences names/handles and queries /me/accounts on graph.facebook.com', async () => {
  const { req, calls } = stubReq(() => ({
    data: [
      { id: 'p1', name: 'Acme Page', instagram_business_account: { id: 'ig1', username: 'acme' } },
      { id: 'p2', name: 'Spare Page' },
    ],
  }));
  const ctx = makeCtx({ req, profile: { authPath: 'fb-login' } });

  const res = await tool('instagram_list_linked_accounts').handler({}, ctx);

  assert.equal(calls[0]!.path, '/me/accounts');
  assert.equal(calls[0]!.host, 'graph.facebook.com');

  const items = sc(res).items as Array<Record<string, unknown>>;
  assert.equal(items.length, 2);
  assert.equal(items[0]!.pageId, 'p1');
  assert.equal(items[0]!.pageName, fence('Acme Page'));
  assert.equal(items[0]!.igId, 'ig1');
  assert.equal(items[0]!.igUsername, fence('acme'));
  assert.equal(items[1]!.pageName, fence('Spare Page'));
  assert.equal(items[1]!.igId, undefined);
  assert.equal(items[1]!.igUsername, undefined);
});

test('list_linked_accounts renders its text block according to the prettyJson setting', async () => {
  // Same operator knob as get_account, and the same trap: the `{ items }`
  // envelope always produces valid JSON, so only the *shape* of the rendering
  // tells a dropped `pretty` option apart from an honoured one.
  const wire = { data: [{ id: 'p1', name: 'Acme Page' }] };
  const fbProfile = { authPath: 'fb-login' as const };

  const compact = await tool('instagram_list_linked_accounts').handler(
    {},
    makeCtx({ req: stubReq(() => wire).req, profile: fbProfile, settings: { prettyJson: false } }),
  );
  const compactText = String(compact.content[0]?.text);
  assert.equal(compactText, JSON.stringify(sc(compact)));
  assert.equal(compactText.includes('\n'), false, 'the default rendering is single-line');

  const pretty = await tool('instagram_list_linked_accounts').handler(
    {},
    makeCtx({ req: stubReq(() => wire).req, profile: fbProfile, settings: { prettyJson: true } }),
  );
  const prettyText = String(pretty.content[0]?.text);
  assert.equal(prettyText, JSON.stringify(sc(pretty), null, 2));
  assert.ok(prettyText.includes('\n  "items": ['), 'the payload is indented, not compact');
});

// --- instagram_token_status ------------------------------------------------

test('token_status (Path B) introspects via debug_token and computes expiry on the clock', async () => {
  const nowMs = 100 * DAY;
  const expiresAtSec = (nowMs + 10 * DAY) / 1000;
  const dataAccessSec = nowMs / 1000 + 5 * 86_400;
  const { req, calls } = stubReq(() => ({
    data: {
      is_valid: true,
      app_id: '55500',
      type: 'USER',
      user_id: '178414',
      scopes: ['instagram_basic', 'pages_show_list'],
      expires_at: expiresAtSec,
      data_access_expires_at: dataAccessSec,
    },
  }));
  const ctx = makeCtx({
    req,
    clock: fakeClock(nowMs),
    profile: {
      name: 'brand',
      authPath: 'fb-login',
      accessToken: 'EAAsecret',
      accountId: '178414',
      appId: '55500',
    },
  });

  const res = await tool('instagram_token_status').handler({}, ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, '/debug_token');
  assert.equal(calls[0]!.params?.input_token, 'EAAsecret');

  const body = sc(res);
  assert.equal(body.profile, 'brand');
  assert.equal(body.authPath, 'fb-login');
  assert.equal(body.tokenConfigured, true);
  assert.equal(body.appConfigured, true);
  assert.equal(body.accountId, '178414');
  assert.equal(body.isValid, true);
  assert.deepEqual(body.scopes, ['instagram_basic', 'pages_show_list']);
  assert.equal(body.expiryState, 'expiring_soon');
  assert.equal(body.daysLeft, 10);
  assert.equal(body.expiresAt, new Date(nowMs + 10 * DAY).toISOString());
  assert.equal(body.dataAccessExpiresAt, new Date(dataAccessSec * 1000).toISOString());
  assert.ok(typeof body.warning === 'string' && body.warning.length > 0);
  assert.deepEqual(body.rateLimitBudget, {
    available: false,
    note: 'Usage headers are parsed by the HTTP client; the last-seen snapshot is not exposed through the tool context yet.',
  });
});

test('token_status (Path B) omits dataAccessExpiresAt when Meta does not disclose it', async () => {
  // CC-DATA-2: Meta omits rather than nulls. `debug_token` leaves
  // `data_access_expires_at` out for tokens with no data-access window, and the
  // tool must not invent one (or emit an explicit null) for it.
  const nowMs = 10 * DAY;
  const { req } = stubReq(() => ({
    data: {
      is_valid: true,
      app_id: '55500',
      type: 'USER',
      scopes: ['instagram_basic'],
      expires_at: (nowMs + 80 * DAY) / 1000,
    },
  }));
  const ctx = makeCtx({
    req,
    clock: fakeClock(nowMs),
    profile: { authPath: 'fb-login', accessToken: 'EAAsecret', appId: '55500' },
  });

  const res = await tool('instagram_token_status').handler({}, ctx);

  const body = sc(res);
  assert.equal(body.dataAccessExpiresAt, undefined);
  assert.equal(body.isValid, true);
  assert.equal(body.expiryState, 'valid');
  // The serialized payload the client actually receives carries no such key.
  const wire = JSON.parse(String(res.content[0]?.text)) as Record<string, unknown>;
  assert.equal('dataAccessExpiresAt' in wire, false);
  assert.equal(wire.expiresAt, new Date(nowMs + 80 * DAY).toISOString());
});

test('token_status (Path A) reports expiry unknown and makes no network call (CC-AUTH-7)', async () => {
  const { req, calls } = stubReq(() => {
    throw new Error('Path A must not call debug_token');
  });
  const ctx = makeCtx({ req, profile: { authPath: 'ig-login' } });

  const res = await tool('instagram_token_status').handler({}, ctx);

  assert.equal(calls.length, 0);
  const body = sc(res);
  assert.equal(body.authPath, 'ig-login');
  assert.equal(body.expiryState, 'unknown');
  assert.equal(body.isValid, undefined);
  assert.equal(body.scopes, undefined);
  assert.equal(body.tokenConfigured, true);
  assert.equal((body.rateLimitBudget as Record<string, unknown>).available, false);
  assert.ok(typeof body.warning === 'string' && body.warning.includes('login'));
});

test('token_status reports an empty token and a blank app id as NOT configured', async () => {
  // A profile can be half-configured: `IG_ACCESS_TOKEN=` / `IG_APP_ID=` in an env
  // file export present-but-empty strings, which survive resolution as `''`.
  // Reporting either as "configured" is the worst possible answer this tool can
  // give — it is exactly what an operator runs to find out why nothing works,
  // and a `true` here sends them hunting for the fault everywhere except where
  // it actually is. `.length > 0`, not "is defined", is what makes the flags mean
  // "usable credential".
  const { req, calls } = stubReq(() => {
    throw new Error('Path A must not call debug_token');
  });

  const blank = sc(
    await tool('instagram_token_status').handler(
      {},
      makeCtx({ req, profile: { authPath: 'ig-login', accessToken: '', appId: '' } }),
    ),
  );
  assert.equal(calls.length, 0);
  assert.equal(blank.tokenConfigured, false, 'an empty token string is not a configured token');
  assert.equal(blank.appConfigured, false, 'a blank app id is not a configured app');

  // An absent app id must read the same as a blank one; a non-empty token still
  // reads as configured, so the flags stay informative rather than always-false.
  const absent = sc(
    await tool('instagram_token_status').handler(
      {},
      makeCtx({
        req,
        profile: { authPath: 'ig-login', accessToken: 'token-abc', appId: undefined },
      }),
    ),
  );
  assert.equal(absent.appConfigured, false, 'an unset app id is not a configured app');
  assert.equal(absent.tokenConfigured, true, 'a real token is still reported as configured');
});

test('token_status (Path A) stays "unknown" whatever refresh threshold is configured', async () => {
  // Path A has no debug_token, so there is no expiry to compare a threshold
  // against (CC-AUTH-7). Whatever `IG_REFRESH_AFTER_DAYS` says, the answer must
  // remain the honest "unknown" with the re-login remediation — a configured
  // threshold must never be able to dress this up as a confident `valid` or
  // `expiring_soon`, and no expiry numbers may be invented alongside it.
  const { req } = stubReq(() => {
    throw new Error('Path A must not call debug_token');
  });

  for (const refreshAfterDays of [0, 7, 3650]) {
    const body = sc(
      await tool('instagram_token_status').handler(
        {},
        makeCtx({ req, settings: { refreshAfterDays } }),
      ),
    );
    assert.equal(
      body.expiryState,
      'unknown',
      `threshold ${refreshAfterDays} must not change state`,
    );
    assert.equal(body.expiresAt, undefined, 'no absolute expiry may be invented on Path A');
    assert.equal(body.daysLeft, undefined, 'no days-left may be invented on Path A');
    assert.ok(typeof body.warning === 'string' && body.warning.includes('login'));
  }
});
