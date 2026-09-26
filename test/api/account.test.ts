/**
 * Unit tests for the `account` api layer. Each function is driven with a fake
 * {@link IgRequestFn} that records the outgoing {@link IgRequestOptions} and
 * returns canned Graph payloads — no network, no fetch stub needed.
 */
import { after as afterAll, test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { InstagramError } from '../../src/core/types.js';
import { MAX_RECORDED_EXPIRY_SEC } from '../../src/core/time.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import {
  debugToken,
  getAccount,
  listLinkedAccounts,
  summarizeDataAccessExpiry,
  summarizeTokenExpiry,
} from '../../src/api/account.js';

/**
 * The only seam this layer may use is the injected {@link IgRequestFn}, and
 * every test below hands it a fake. Poisoning the global transport makes that
 * structural rather than conventional: this package reads the operated account
 * and introspects the access token, so code that reached for `fetch` directly —
 * or a helper that quietly fell back to it — would ship the operator's live
 * credential to Meta from a test run. It dies offline here instead. Restored in
 * `after()` so nothing leaks into another test file.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('api/account unit tests must never touch the network');
};
afterAll(() => {
  globalThis.fetch = realFetch;
});

/**
 * The exact profile field set this layer must ask Graph for, pinned
 * character-for-character and deliberately duplicated from the source rather
 * than imported. Graph answers with exactly the fields it was asked for, so a
 * field that quietly falls out of the selection is not an error anywhere: the
 * call succeeds, `get_account` renders, and the operator simply sees a blank
 * follower count or a missing bio and concludes the account has none.
 */
const ACCOUNT_FIELDS =
  'username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count';

/** Build a fake request seam that records calls and returns `responder(opts)`. */
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

const DAY = 86_400_000;

/**
 * Strings that are NOT fixed points of the usual normalisers: edge whitespace
 * (`.trim()`), upper case (`.toLowerCase()`), a ligature (NFKC folds `ﬁ` to
 * `fi`), a query clause (`.split('?')[0]`), plus the empty string and arbitrary
 * graphemes. The named ones are always drawn, so the pass-through properties
 * below do not depend on the random draw happening to produce a leading space.
 */
const nonFixedPointString = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 12 }),
  fc.constantFrom(' padded ', '\tTabbed\n', 'ﬁne', 'MixedCase', 'a?b=c', '', ' '),
);

test('getAccount requests the documented field set and maps snake_case → camelCase', async () => {
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

  const profile = await getAccount(req, { igId: '178414' });

  assert.equal(calls.length, 1);
  // The WHOLE options object is pinned, not method/path/params one field at a
  // time. `host`, `idempotent` and `body` are optional, so adding one is
  // invisible to the compiler and to every per-field assertion — yet each is a
  // real incident: an explicit `host` would send the access token (and, on
  // Path B, the `appsecret_proof` derived from the app secret) to a host the
  // operator never configured, `idempotent: false` would silently switch off
  // retry on 429/5xx for a plain read, and a `body` on a GET would make the
  // client attach a form payload to a read.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/178414',
    params: { fields: ACCOUNT_FIELDS },
  });

  assert.deepEqual(profile, {
    id: '178414',
    username: 'acme',
    name: 'ACME Co',
    biography: 'We make anvils',
    website: 'https://acme.example',
    profilePictureUrl: 'https://cdn.example/pic.jpg',
    followersCount: 1200,
    followsCount: 42,
    mediaCount: 87,
  });
});

test('getAccount tolerates omitted fields (CC-DATA-2)', async () => {
  // Every absent field stays absent — none of them may acquire a fabricated
  // default. A `?? 0` on a count is the worst of these: Meta omits
  // `followers_count` / `media_count` when the metric is unavailable, and a
  // reported 0 is indistinguishable from a real zero. The operator reads "0
  // followers" or "0 posts" for a healthy account and concludes the account was
  // wiped, or the model reports a collapse in reach that never happened.
  const { req, calls } = stubReq(() => ({ id: '999' }));

  const profile = await getAccount(req, { igId: 'me' });

  assert.equal(calls[0]!.path, '/me');
  assert.deepEqual(profile, {
    id: '999',
    username: undefined,
    name: undefined,
    biography: undefined,
    website: undefined,
    profilePictureUrl: undefined,
    followersCount: undefined,
    followsCount: undefined,
    mediaCount: undefined,
  });
});

test('getAccount passes falsy-but-present profile values through as themselves (CC-PROC-46)', async () => {
  // The omitted-field case above only proves that ABSENT stays absent. It says
  // nothing about `0` and `''`, which are present AND falsy: a `|| undefined`
  // on any of the eight mapping lines passes every fixture in this file, because
  // none of them carries a zero count or an empty string. Yet these are ordinary
  // Graph answers — a brand-new professional account has `followers_count: 0`,
  // `follows_count: 0` and `media_count: 0`, and an account that cleared its bio
  // and website sends both as `''`. Dropping them turns "zero" into
  // "unavailable": `get_account` documents every count as "absent if
  // unavailable", so the operator is told the metric could not be read when
  // Graph just reported a real zero.
  const { req } = stubReq(() => ({
    id: '178414',
    username: 'acme',
    name: '',
    biography: '',
    website: '',
    profile_picture_url: '',
    followers_count: 0,
    follows_count: 0,
    media_count: 0,
  }));

  assert.deepEqual(await getAccount(req, { igId: '178414' }), {
    id: '178414',
    username: 'acme',
    name: '',
    biography: '',
    website: '',
    profilePictureUrl: '',
    followersCount: 0,
    followsCount: 0,
    mediaCount: 0,
  });
});

test('getAccount property — every profile field and the igId travel verbatim, never normalised', async () => {
  // Fixed-point fixtures in reverse (CC-PROC-53): the ASCII, already-trimmed,
  // already-lowercase strings above are unchanged by `.trim()`, `.toLowerCase()`,
  // NFKC or `.split('?')[0]`, so an inserted transform on any pass-through line
  // — or on the id before it is percent-encoded — survives every one of them.
  // This layer is a mapper, not an editor: the tool renders exactly what Graph
  // said, and an edited `name` or `biography` (leading whitespace gone, a
  // ligature folded, a `?` clause cut) is a misreport the operator cannot
  // detect. Arbitrary strings, whitespace and non-ASCII included, pin the
  // pass-through for every field and the path at once.
  const anyString = nonFixedPointString;
  await fc.assert(
    fc.asyncProperty(
      anyString,
      fc.record({
        id: anyString,
        username: anyString,
        name: anyString,
        biography: anyString,
        website: anyString,
        profile_picture_url: anyString,
      }),
      async (igId, wire) => {
        const { req, calls } = stubReq(() => ({
          ...wire,
          followers_count: 1,
          follows_count: 2,
          media_count: 3,
        }));

        const profile = await getAccount(req, { igId });

        assert.equal(calls[0]!.path, `/${encodeURIComponent(igId)}`);
        assert.deepEqual(profile, {
          id: wire.id,
          username: wire.username,
          name: wire.name,
          biography: wire.biography,
          website: wire.website,
          profilePictureUrl: wire.profile_picture_url,
          followersCount: 1,
          followsCount: 2,
          mediaCount: 3,
        });
      },
    ),
    { numRuns: 200 },
  );
});

test('getAccount sends an empty igId as-is instead of falling back to `me`', async () => {
  // `igId` comes from `IG_ACCOUNT_ID` (via the tool layer's `accountId ?? 'me'`),
  // and an empty value there means the operator's config is broken. Substituting
  // `me` for it turns that broken config into a successful read of whichever
  // account owns the token — the operator sees plausible numbers, never learns
  // the configured id was ignored, and cannot tell the two accounts apart from
  // the response. A request for `/` fails loudly at Graph, which is the point.
  const { req, calls } = stubReq(() => ({ id: '178414' }));

  await getAccount(req, { igId: '' });

  assert.equal(calls[0]!.path, '/');
});

test('getAccount percent-encodes igId so a crafted id cannot forge a second path segment', async () => {
  // `igId` arrives from tool input and from the config file, so it has to stay a
  // single path segment. Unencoded, an id like `me/media?fields=id` retargets the
  // call at a different edge with caller-chosen fields, and `get_account` answers
  // with someone else's media list while the operator believes they read a profile.
  const { req, calls } = stubReq(() => ({ id: '178414' }));

  const profile = await getAccount(req, { igId: 'me/media?fields=id' });

  assert.equal(calls[0]!.path, '/me%2Fmedia%3Ffields%3Did');
  assert.equal(profile.id, '178414');
});

test('getAccount refuses a body that is not an object instead of throwing a TypeError (CC-DATA-84)', async () => {
  // `req` casts the body. `null` threw a raw TypeError on `wire.id`, whose
  // engine text reached `get_account` and the `doctor` reachability line; a
  // scalar or a list read as a profile with every field absent. Each is now the
  // same `upstream` refusal `getMedia` gives.
  for (const body of [null, 'x', 7, false, [], [{ id: '178414' }]]) {
    const { req } = stubReq(() => body);
    await assert.rejects(
      () => getAccount(req, { igId: 'me' }),
      (e: unknown) =>
        e instanceof InstagramError &&
        e.kind === 'upstream' &&
        e.message === 'Instagram returned no account object for this id. Retry later.',
      `body=${JSON.stringify(body)}`,
    );
  }
});

test('listLinkedAccounts hits /me/accounts on graph.facebook.com and maps rows', async () => {
  const { req, calls } = stubReq(() => ({
    data: [
      {
        id: 'page1',
        name: 'Acme Page',
        instagram_business_account: { id: 'ig1', username: 'acme' },
      },
      { id: 'page2', name: 'No-IG Page' },
    ],
  }));

  const linked = await listLinkedAccounts(req, 200);

  // Whole-shape pin again. Two things here are load-bearing beyond method/path:
  // the host MUST stay graph.facebook.com — the Page graph only exists there, and
  // the tool's `paths: ['fb-login']` capability guard is written on the assumption
  // that this call agrees with it; and no `idempotent: false` may creep in, or a
  // 429 during the login flow stops being retried and the operator is told they
  // have no linked Pages. A `body` on this GET would be equally silent.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/me/accounts',
    params: { fields: 'name,instagram_business_account{id,username}' },
    host: 'graph.facebook.com',
  });

  // Whole-result pin: the walk ended on its own, so it says `truncated: false`
  // and offers no cursor or note.
  assert.deepEqual(linked, {
    items: [
      { pageId: 'page1', pageName: 'Acme Page', igId: 'ig1', igUsername: 'acme' },
      { pageId: 'page2', pageName: 'No-IG Page', igId: undefined, igUsername: undefined },
    ],
    truncated: false,
  });
});

test('listLinkedAccounts hands a null entry through for the tool layer to count, not a crashed page (CC-DATA-64)', async () => {
  // Reading `.id` off `null` threw a TypeError that failed the whole enumeration.
  const { req } = stubReq(() => ({ data: [null, { id: 'page1' }, 'x'] }));
  const linked = await listLinkedAccounts(req, 200);
  assert.deepEqual(linked.items, [
    null,
    { pageId: 'page1', pageName: undefined, igId: undefined, igUsername: undefined },
    'x',
  ]);
});

test('listLinkedAccounts returns [] when the edge is empty', async () => {
  const { req } = stubReq(() => ({ data: [] }));
  assert.deepEqual((await listLinkedAccounts(req, 200)).items, []);
});

test('listLinkedAccounts treats a response with no data key as no pages', async () => {
  // Graph omits `data` entirely on some empty edges rather than sending `[]`.
  // Mapping over the missing key would be a TypeError, so an account with no
  // linked Pages would fail the login flow instead of reporting "none found".
  const { req } = stubReq(() => ({}));
  assert.deepEqual((await listLinkedAccounts(req, 200)).items, []);
});

test('listLinkedAccounts follows the cursor so Pages past the first page are not dropped', async () => {
  // `/me/accounts` pages at 25 Pages by default. Reading only the first page
  // returned an operator with more Pages a silently short list, and the Page
  // linked to the account they wanted was simply not there.
  const { req, calls } = stubReq((opts) =>
    opts.params?.after === undefined
      ? {
          data: [{ id: 'page1', name: 'One' }],
          paging: { cursors: { after: 'CUR1' }, next: 'https://graph.facebook.com/next' },
        }
      : { data: [{ id: 'page2', name: 'Two' }] },
  );

  const linked = await listLinkedAccounts(req, 200);

  assert.deepEqual(
    linked.items.map((row) => row.pageId),
    ['page1', 'page2'],
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    method: 'GET',
    path: '/me/accounts',
    params: { fields: 'name,instagram_business_account{id,username}', after: 'CUR1' },
    host: 'graph.facebook.com',
  });
});

test('listLinkedAccounts stops at the item cap instead of walking an unbounded edge', async () => {
  let n = 0;
  const { req, calls } = stubReq(() => ({
    data: [{ id: 'p' }, { id: 'q' }],
    paging: {
      cursors: { after: `CUR${String((n += 1))}` },
      next: 'https://graph.facebook.com/next',
    },
  }));

  const linked = await listLinkedAccounts(req, 3);

  assert.equal(linked.items.length, 3);
  assert.equal(calls.length, 2);
});

test('listLinkedAccounts reports a capped walk as truncated instead of a complete set', async () => {
  // Returning only `page.items` dropped the walk's verdict: an operator with
  // more Pages than IG_MAX_ITEMS got a short list that read as the whole set.
  // The cap here lands on a page boundary, so the cursor is safe to publish.
  const { req } = stubReq((opts) =>
    opts.params?.after === undefined
      ? {
          data: [{ id: 'p1' }, { id: 'p2' }],
          paging: { cursors: { after: 'CUR1' }, next: 'https://graph.facebook.com/next' },
        }
      : {
          data: [{ id: 'p3' }],
          paging: { cursors: { after: 'CUR2' }, next: 'https://graph.facebook.com/next' },
        },
  );

  const linked = await listLinkedAccounts(req, 2);

  assert.equal(linked.truncated, true);
  assert.equal(linked.after, 'CUR1');
  assert.deepEqual(
    linked.items.map((row) => row.pageId),
    ['p1', 'p2'],
  );
});

test('listLinkedAccounts resumes from a caller-supplied cursor', async () => {
  const { req, calls } = stubReq(() => ({ data: [{ id: 'p3' }] }));

  const linked = await listLinkedAccounts(req, 200, 'CUR1');

  assert.deepEqual(calls[0]?.params, {
    fields: 'name,instagram_business_account{id,username}',
    after: 'CUR1',
  });
  assert.deepEqual(linked, {
    items: [{ pageId: 'p3', pageName: undefined, igId: undefined, igUsername: undefined }],
    truncated: false,
  });
});

test('listLinkedAccounts property — page and IG ids and names travel verbatim, never normalised', async () => {
  // Same reverse fixed-point argument as for `getAccount`: `page1` / `ig1` /
  // `acme` are unchanged by every common normaliser, so a `.trim()`, a
  // `.toLowerCase()` or a `|| undefined` inserted on any of the four mapping
  // lines survives the fixtures above. The rows feed the `login` picker and
  // `list_linked_accounts`: an edited `igId` is an id the operator then writes
  // into their config, and it is not the one Graph will recognise.
  const anyString = nonFixedPointString;
  await fc.assert(
    fc.asyncProperty(
      fc.record({ pageId: anyString, pageName: anyString, igId: anyString, igUsername: anyString }),
      async (w) => {
        const { req } = stubReq(() => ({
          data: [
            {
              id: w.pageId,
              name: w.pageName,
              instagram_business_account: { id: w.igId, username: w.igUsername },
            },
          ],
        }));

        assert.deepEqual((await listLinkedAccounts(req, 200)).items, [
          { pageId: w.pageId, pageName: w.pageName, igId: w.igId, igUsername: w.igUsername },
        ]);
      },
    ),
    { numRuns: 200 },
  );
});

test('debugToken reports every field unknown when the envelope has no data', async () => {
  // `/debug_token` answers `{}` for a token the app cannot inspect. Reading the
  // fields off the missing wrapper would throw inside `doctor`, turning a
  // "cannot introspect this token" diagnosis into a crashed diagnostic.
  const { req } = stubReq(() => ({}));

  assert.deepEqual(await debugToken(req, { inputToken: 'EAAsecret' }), {
    isValid: undefined,
    appId: undefined,
    type: undefined,
    userId: undefined,
    scopes: undefined,
    expiresAtSec: undefined,
    dataAccessExpiresAtSec: undefined,
  });
});

test('debugToken refuses a body that is not an object instead of reporting it as undisclosed (CC-DATA-85)', async () => {
  // `null` threw a raw TypeError on `.data`; a scalar or a list read as an
  // envelope with no `data`, i.e. every field unknown — the same summary a real
  // `{}` answer gives, so nonsense read as "Meta disclosed nothing". The `{}`
  // case above is unaffected.
  for (const body of [null, 'x', 7, true, [], [{ data: { is_valid: true } }]]) {
    const { req } = stubReq(() => body);
    await assert.rejects(
      () => debugToken(req, { inputToken: 'placeholder-token' }),
      (e: unknown) =>
        e instanceof InstagramError &&
        e.kind === 'upstream' &&
        e.message === 'Instagram returned no token introspection object. Retry later.',
      `body=${JSON.stringify(body)}`,
    );
  }
});

test('debugToken parses the { data } envelope on graph.facebook.com', async () => {
  const { req, calls } = stubReq(() => ({
    data: {
      is_valid: true,
      app_id: '55500',
      type: 'USER',
      user_id: '178414',
      scopes: ['instagram_basic', 'pages_show_list'],
      expires_at: 1_800_000_000,
      data_access_expires_at: 1_790_000_000,
    },
  }));

  const info = await debugToken(req, { inputToken: 'EAAsecret' });

  // This is the one call in the package that carries a credential in the query
  // string, so its shape is pinned whole. The token must travel as `input_token`
  // and nowhere else: an extra `access_token` key here would put the inspected
  // token in the slot the auth provider owns, and a `body` would move a secret
  // into a request body that the client only builds for writes. The host must
  // stay graph.facebook.com — `debug_token` exists nowhere else, and dropping the
  // pin would ship the token to graph.instagram.com on Path A. `idempotent` stays
  // unset so this read keeps its default retry behaviour.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/debug_token',
    params: { input_token: 'EAAsecret' },
    host: 'graph.facebook.com',
  });

  assert.deepEqual(info, {
    isValid: true,
    appId: '55500',
    type: 'USER',
    userId: '178414',
    scopes: ['instagram_basic', 'pages_show_list'],
    expiresAtSec: 1_800_000_000,
    dataAccessExpiresAtSec: 1_790_000_000,
  });
});

test('debugToken passes falsy-but-present introspection fields through as themselves (CC-PROC-46)', async () => {
  // Every field `debug_token` answers has a falsy value that MEANS something:
  // `is_valid: false` is the whole point of the call, `expires_at: 0` is Meta's
  // spelling of "never expires" (which `summarizeTokenExpiry` turns into `never`
  // — see below), `data_access_expires_at: 0` likewise, and `scopes: []` is a
  // token that carries no permissions at all, as opposed to `scopes` absent,
  // which is "not inspected". The envelope test above supplies only the truthy
  // spelling of each, so a `|| undefined` or a `?.length ? … : undefined` on any
  // of the seven lines survives it — and turns a dead or scope-less token into
  // an uninspectable one in `token_status`, exactly the report an operator gets
  // for a token that is fine but merely unknown.
  const { req } = stubReq(() => ({
    data: {
      is_valid: false,
      app_id: '',
      type: '',
      user_id: '',
      scopes: [],
      expires_at: 0,
      data_access_expires_at: 0,
    },
  }));

  const info = await debugToken(req, { inputToken: 'EAAsecret' });

  assert.deepEqual(info, {
    isValid: false,
    appId: '',
    type: '',
    userId: '',
    scopes: [],
    expiresAtSec: 0,
    dataAccessExpiresAtSec: 0,
  });
  // And the zero is the one `summarizeTokenExpiry` recognises, end to end.
  assert.deepEqual(
    summarizeTokenExpiry({
      expiresAtSec: info.expiresAtSec,
      nowMs: 10 * DAY,
      refreshAfterDays: 45,
    }),
    { state: 'never' },
  );
});

test('debugToken property — the inspected token is sent verbatim, never normalised', async () => {
  // `EAAsecret` is a fixed point of `.trim()`, `.toLowerCase()` and NFKC, so an
  // inserted transform on the `input_token` line survives the envelope test. A
  // token is opaque: any edit to it introspects a DIFFERENT credential, and
  // `doctor` then reports validity and scopes for a token nobody holds.
  const anyString = nonFixedPointString;
  await fc.assert(
    fc.asyncProperty(anyString, async (inputToken) => {
      const { req, calls } = stubReq(() => ({}));

      await debugToken(req, { inputToken });

      assert.deepEqual(calls[0], {
        method: 'GET',
        path: '/debug_token',
        params: { input_token: inputToken },
        host: 'graph.facebook.com',
      });
    }),
    { numRuns: 200 },
  );
});

test('summarizeTokenExpiry: unknown when expiresAtSec is undefined (CC-AUTH-7)', () => {
  const s = summarizeTokenExpiry({ expiresAtSec: undefined, nowMs: 0, refreshAfterDays: 45 });
  // The whole summary, and the exact sentence rather than a substring.
  //
  // The sentence first. Path A and the unrepresentable-timestamp guard below
  // BOTH answer `unknown` and BOTH say `login`, so every weaker assertion here —
  // the state, or `includes('login')` — is satisfied by either one. Deleting the
  // `expiresAtSec === undefined` branch outright would then go unnoticed:
  // `undefined * 1000` is NaN, the NaN clause catches it, and the operator is
  // told upstream reported an `expires_at` of `undefined` — inventing a wire
  // value for a field that was never on the wire, and pointing the investigation
  // at Meta instead of at the local record that has no expiry metadata in it.
  // The two messages are different because the two situations call for different
  // things; this pins that they stay different.
  //
  // And WHOLE, like the other five branches of this function — `never` in the
  // next test, the rest in the `deepEqual`s below. This was the only branch read
  // field by field, and `TokenExpirySummary` is a single interface with optional
  // members rather than a discriminated union, so `daysLeft` on this return
  // type-checks with no contortion at all. Planted here, `daysLeft: 0` survived
  // all 221 tests across api/account, tools/account, core/refresh and cli/doctor
  // — while `token_status` on Path B copies `daysLeft` straight out of this
  // summary, so a token whose expiry is simply unknown would reach the model as
  // one with 0 day(s) left. `expiresAt` was already pinned absent here; nothing
  // pinned the absence of anything else.
  assert.deepEqual(s, {
    state: 'unknown',
    warning: 'Token expiry is unknown: `debug_token` reported no `expires_at` for this token.',
  });
});

test('summarizeTokenExpiry: never when expiresAtSec is 0', () => {
  const s = summarizeTokenExpiry({ expiresAtSec: 0, nowMs: 10 * DAY, refreshAfterDays: 45 });
  assert.deepEqual(s, { state: 'never' });
});

test('summarizeTokenExpiry: valid when comfortably beyond the refresh threshold', () => {
  const now = 100 * DAY;
  const expiresAtSec = (now + 60 * DAY) / 1000;
  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });
  assert.equal(s.state, 'valid');
  assert.equal(s.daysLeft, 60);
  assert.equal(s.expiresAt, new Date(now + 60 * DAY).toISOString());
  assert.equal(s.warning, undefined);
});

test('summarizeTokenExpiry: expiring_soon within the refresh threshold, with absolute expiry (CC-AUTH-13)', () => {
  const now = 100 * DAY;
  const expiresAtSec = (now + 10 * DAY) / 1000;
  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });
  assert.equal(s.state, 'expiring_soon');
  assert.equal(s.daysLeft, 10);
  assert.ok(s.warning && s.warning.includes(new Date(now + 10 * DAY).toISOString()));
});

test('summarizeTokenExpiry: daysLeft exactly at refreshAfterDays still warns', () => {
  // `refreshAfterDays` is the operator's last scheduled chance to rotate the token,
  // so the day the boundary is reached must already carry the warning: `doctor` runs
  // on a cadence, and the next run lands after the threshold has been crossed. An
  // exclusive comparison stays silent on exactly that day and the token lapses
  // mid-campaign with no prior notice.
  const now = 100 * DAY;
  const expiresAtSec = (now + 45 * DAY) / 1000;
  const expiresAt = new Date(now + 45 * DAY).toISOString();

  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });

  assert.deepEqual(s, {
    state: 'expiring_soon',
    expiresAt,
    daysLeft: 45,
    warning: `Token expires at ${expiresAt} (~45 day(s) left); run the \`refresh\` or \`login\` CLI.`,
  });
});

test('summarizeTokenExpiry: daysLeft rounds down, never up, on a partial day', () => {
  // `daysLeft` is a promise about remaining runway, so it must round down: with
  // half a day left, "~11 day(s)" tells the operator they can wait until next week.
  // Rounding up inflates every partial day by one and pushes the rotation past the
  // real deadline — publishing then fails on a token the last report called healthy.
  const now = 100 * DAY;
  const expiresAtMs = now + 10 * DAY + DAY / 2;
  const expiresAtSec = expiresAtMs / 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });

  assert.deepEqual(s, {
    state: 'expiring_soon',
    expiresAt,
    daysLeft: 10,
    warning: `Token expires at ${expiresAt} (~10 day(s) left); run the \`refresh\` or \`login\` CLI.`,
  });
});

test('summarizeTokenExpiry: expired for a past expiry', () => {
  const now = 100 * DAY;
  const expiresAtSec = (now - 5 * DAY) / 1000;
  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });
  assert.equal(s.state, 'expired');
  assert.equal(s.daysLeft, -5);
  assert.ok(s.warning && s.warning.includes('expired'));
});

test('summarizeTokenExpiry: a token expiring exactly now is expired and still reports expiresAt', () => {
  // The instant of expiry belongs to the expired side: Meta rejects a token at its
  // `expires_at`, so reporting `expiring_soon` there tells the operator to schedule
  // a refresh for a credential that is already dead. The absolute `expiresAt` has to
  // survive into that summary too (CC-AUTH-13) — without it a skewed local clock
  // looks identical to a genuinely lapsed token, and nobody can tell which it was.
  const now = 100 * DAY;
  const expiresAtSec = now / 1000;
  const expiresAt = new Date(now).toISOString();

  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });

  assert.deepEqual(s, {
    state: 'expired',
    expiresAt,
    daysLeft: 0,
    warning: `Token expired at ${expiresAt}; run the \`login\` CLI to obtain a new one.`,
  });
});

test('summarizeTokenExpiry: an expired token reports whole days elapsed, rounded down', () => {
  // `daysLeft` goes negative once the token is dead, and it must keep rounding
  // DOWN there rather than toward zero: the number is how long the credential has
  // been unusable, and truncation under-reports every partial day by one. An
  // operator reconciling "publishing broke on the 6th" against a report that says
  // the token has been dead for 5 days concludes the outage has another cause and
  // keeps looking, instead of rotating the credential.
  const now = 100 * DAY;
  const expiresAtMs = now - 5 * DAY - DAY / 2;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const s = summarizeTokenExpiry({
    expiresAtSec: expiresAtMs / 1000,
    nowMs: now,
    refreshAfterDays: 45,
  });

  assert.deepEqual(s, {
    state: 'expired',
    expiresAt,
    daysLeft: -6,
    warning: `Token expired at ${expiresAt}; run the \`login\` CLI to obtain a new one.`,
  });
});

test('summarizeTokenExpiry: a negative expiry is unknown, never "never expires" (CC-AUTH-68)', () => {
  // Only the exact value `0` carries `debug_token`'s "never expires" meaning. A
  // negative `expires_at` is corrupt input, and folding it into the
  // never-expires branch is the most dangerous possible misreading: `doctor`
  // would report a permanent token and suppress every refresh warning for good.
  // It is not dated either: `debug_token` states expiries in whole Unix seconds
  // after the epoch, and Path A's reader refuses a signed record, so a date in
  // 1969 is not something either source can mean. It is reported the way Path A
  // reports it — unknown, with the value named.
  const s = summarizeTokenExpiry({ expiresAtSec: -86_400, nowMs: 0, refreshAfterDays: 45 });

  assert.deepEqual(s, {
    state: 'unknown',
    warning:
      'Token expiry is unknown: upstream reported an `expires_at` of -86400, which is not a representable timestamp.',
  });
});

test('summarizeTokenExpiry: a token with hours left is expiring_soon, not expired', () => {
  // Expiry is decided on the instant, not on the day count. A token valid for
  // another twelve hours rounds to `daysLeft: 0`, and treating that 0 as "already
  // expired" declares a working credential dead: `doctor` fails, the operator
  // burns a rotation, and — worse — a still-publishable account looks broken
  // during exactly the window when the last posts before expiry matter most.
  const now = 100 * DAY;
  const expiresAtMs = now + DAY / 2;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const s = summarizeTokenExpiry({
    expiresAtSec: expiresAtMs / 1000,
    nowMs: now,
    refreshAfterDays: 45,
  });

  assert.deepEqual(s, {
    state: 'expiring_soon',
    expiresAt,
    daysLeft: 0,
    warning: `Token expires at ${expiresAt} (~0 day(s) left); run the \`refresh\` or \`login\` CLI.`,
  });
});

test('summarizeTokenExpiry: one day past the threshold is still plain valid', () => {
  // The warning boundary is inclusive but must not creep outward. A threshold
  // that fires a day early is not harmless: `token_status` is what the model
  // reads before deciding what to do next, and a standing "expires soon, run the
  // refresh CLI" on a token with a month and a half of runway trains both the
  // operator and the model to ignore the warning — so the one that matters, 45
  // days later, is ignored too.
  const now = 100 * DAY;
  const expiresAtMs = now + 46 * DAY;

  const s = summarizeTokenExpiry({
    expiresAtSec: expiresAtMs / 1000,
    nowMs: now,
    refreshAfterDays: 45,
  });

  assert.deepEqual(s, {
    state: 'valid',
    expiresAt: new Date(expiresAtMs).toISOString(),
    daysLeft: 46,
  });
});

test('summarizeTokenExpiry: the warning threshold is the caller-supplied one, not a fixed 45', () => {
  // `refreshAfterDays` is operator policy (`IG_REFRESH_AFTER_DAYS`) and the whole
  // point of it is that rotation cadence differs per deployment. Pinning the
  // comparison to the default value silently ignores that setting in BOTH
  // directions: a team that rotates weekly gets no warning until day 45 — long
  // after their own window closed — and a team that asked for 90 days of notice
  // gets none until it is far too late to schedule the change.
  const now = 100 * DAY;

  const tight = summarizeTokenExpiry({
    expiresAtSec: (now + 10 * DAY) / 1000,
    nowMs: now,
    refreshAfterDays: 7,
  });
  assert.equal(tight.state, 'valid');
  assert.equal(tight.warning, undefined);

  const generous = summarizeTokenExpiry({
    expiresAtSec: (now + 60 * DAY) / 1000,
    nowMs: now,
    refreshAfterDays: 90,
  });
  assert.equal(generous.state, 'expiring_soon');
  assert.ok(generous.warning?.includes('~60 day(s) left'));
});

// --- Unrepresentable `expires_at` (wire data, never validated) --------------
//
// `expires_at` reaches `summarizeTokenExpiry` straight off `debug_token` with no
// validation: `DebugTokenWire` types it `number?` and `debugToken` copies it
// through. `Date.prototype.toISOString` throws a bare `RangeError` for any
// instant further than ±8.64e15 ms from the epoch, and for `NaN`. That
// `RangeError` is not an `InstagramError`, so nothing upstream classifies it,
// and it escapes a function documented as pure — crashing `doctor` and
// `token_status`, the two diagnostics an operator runs precisely BECAUSE they
// already suspect the token. The verdict must degrade to a stated `unknown`
// instead: `expired` would declare a possibly healthy token dead and mark the
// install unhealthy in `doctor`, and `valid`/`never` would certify a token
// nobody could inspect and silence every later refresh warning.

/** The unrepresentable inputs, each reachable and each with its own route in. */
const UNREPRESENTABLE: [label: string, expiresAtSec: number][] = [
  // `JSON.parse('{"expires_at":1e400}')` yields `Infinity` — a malformed or
  // truncated numeric literal from Meta needs no hostility to get here.
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  // A corrupt/hand-edited credential record, or `expiresInSec` arithmetic on a
  // non-numeric upstream field, lands `NaN` in the same slot.
  ['NaN', NaN],
  // Plausible-looking but wrong unit: seconds where milliseconds (or worse) were
  // meant. 1e15 seconds is ~31 million years past the epoch.
  ['1e15 (huge positive)', 1e15],
  ['-1e15 (huge negative)', -1e15],
  ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
  // One millisecond outside the representable window on either side.
  ['one ms past the maximum instant', 8.64e12 + 0.001],
  ['one ms before the minimum instant', -8.64e12 - 0.001],
  // Inside the `Date` range but outside what Path A would ever read back
  // (CC-AUTH-68): the same plausibility ceiling, 9999-12-31T23:59:59Z, bounds
  // both paths, so `debug_token` cannot certify a date its twin would refuse.
  ['the exact maximum Date instant (CC-AUTH-68)', 8.64e12],
  ['the exact minimum Date instant (CC-AUTH-68)', -8.64e12],
  ['one second past the recorded-expiry ceiling (CC-AUTH-68)', MAX_RECORDED_EXPIRY_SEC + 1],
  // An expiry in epoch MILLISECONDS: thirteen digits, year 58692 as seconds.
  ['an expiry in epoch milliseconds (CC-AUTH-68)', 1_790_000_000_000],
  ['a negative second (CC-AUTH-68)', -1],
  // `debug_token` states whole seconds; a fraction is not one of its answers.
  ['a fractional second (CC-AUTH-68)', 1_800_000_000.5],
];

for (const [label, expiresAtSec] of UNREPRESENTABLE) {
  test(`summarizeTokenExpiry: ${label} degrades to a stated unknown instead of throwing`, () => {
    const s = summarizeTokenExpiry({ expiresAtSec, nowMs: 100 * DAY, refreshAfterDays: 45 });

    // Whole-shape pin, which also settles what must be ABSENT: node's strict
    // deepEqual compares own keys, so an `expiresAt` or `daysLeft` sneaking back
    // in fails here. Neither may: an `expiresAt` would be a date nobody can
    // source, and `daysLeft` would be `NaN`/`Infinity`, which `doctor` renders
    // as "~NaN day(s) left" — reading as a formatting glitch rather than as "the
    // upstream value was garbage". The warning names the offending value for the
    // same reason: without it this line is indistinguishable from the Path-A
    // "no debug_token endpoint" unknown, and the operator cannot tell "expiry
    // was never reported" from "expiry was reported as nonsense".
    assert.deepEqual(s, {
      state: 'unknown',
      warning: `Token expiry is unknown: upstream reported an \`expires_at\` of ${expiresAtSec}, which is not a representable timestamp.`,
    });
  });
}

// The same section, one rung further out: `expires_at` can hold a value that is
// not a number AT ALL. `DebugTokenWire` types it `number?` and `req` CASTS its
// payload rather than validating it, so `debug_token` answering `"soon"`, or a
// hand-edited credential record carrying an object, lands here typed as a number
// and is not one. The first three rows are the inputs whose product is `NaN`.
// Measured 2026-09-22, with the NaN clause rewritten to test the seconds value
// instead of the product: the mutant survived all 52 test files with an empty
// killer diff — `Number.isNaN` coerces nothing, so it answered `false` for
// them, and `new Date(NaN).toISOString()` then threw the bare `RangeError` this
// whole section exists to prevent, out of a function documented as pure, into
// `doctor` and `token_status`. The guard now lives in `core/time.ts` behind a
// `typeof` test, which is what makes that rewrite harmless there.
//
// The second half of the table is the values that are not numbers but DO
// coerce to a finite product (`null`, `false`, `[]` and `"0"` to `0`, `true` to
// `1000`, a numeric string to itself). They used to be excluded from this table
// as "a different question", on the grounds that they take the representable
// path — which was the defect, not a scoping choice. Measured 2026-09-23: each
// of them came back as a plausible `expired` or `valid`, the two answers this
// function's contract rules out, and `"0"` — Graph's never-expires sentinel
// arriving as a string — declared a healthy token dead since 1970. The third
// column is the rendering the operator sees: `String` would print `[]` as
// nothing and `"0"` as a number that is perfectly representable.
const NOT_A_NUMBER: [label: string, expiresAtSec: unknown, rendered: string][] = [
  ['a non-numeric string', 'soon', '"soon" (type string)'],
  ['an object', {}, '{} (type object)'],
  ['an array', [1, 2], '[1,2] (type object)'],
  ['null', null, 'null (type object)'],
  ['false', false, 'false (type boolean)'],
  ['true', true, 'true (type boolean)'],
  ['the never-expires sentinel as a string', '0', '"0" (type string)'],
  ['a numeric string', '1800000000', '"1800000000" (type string)'],
  ['an empty array', [], '[] (type object)'],
  ['a one-element numeric array', [1_800_000_000], '[1800000000] (type object)'],
];

for (const [label, raw, rendered] of NOT_A_NUMBER) {
  test(`summarizeTokenExpiry: ${label} in the expiry slot degrades to unknown, not a RangeError`, () => {
    const s = summarizeTokenExpiry({
      expiresAtSec: raw as number,
      nowMs: 100 * DAY,
      refreshAfterDays: 45,
    });

    // Whole-shape pin for the same reason as the table above: no `expiresAt` and
    // no `daysLeft` may appear, and the warning must name the offending value so
    // the operator can tell a nonsense `expires_at` from a Path-A silence.
    assert.deepEqual(s, {
      state: 'unknown',
      warning: `Token expiry is unknown: upstream reported an \`expires_at\` of ${rendered}, which is not a representable timestamp.`,
    });
  });
}

test('summarizeTokenExpiry: an unusable expiry does not read as the Path-A unknown', () => {
  // Stated as a relation between the two `unknown` warnings, not just as two
  // pinned strings: both branches answer with the same `state`, so the text is
  // the only thing that separates "this deployment has no `debug_token`
  // endpoint, and never will" — expected, permanent, nothing to do — from
  // "`debug_token` answered with a value we cannot read", which is a live
  // upstream fault worth chasing. Collapsing them into one message would make
  // every Path-B token fault look like ordinary Path-A silence.
  const pathA = summarizeTokenExpiry({ expiresAtSec: undefined, nowMs: 0, refreshAfterDays: 45 });
  const unusable = summarizeTokenExpiry({ expiresAtSec: Infinity, nowMs: 0, refreshAfterDays: 45 });

  assert.equal(pathA.state, unusable.state);
  assert.notEqual(pathA.warning, unusable.warning);
  assert.ok(unusable.warning?.includes('Infinity'));
});

test('summarizeTokenExpiry: a local record is worded as a record, never as a token fact', () => {
  // Path A reads its expiry from `IG_TOKEN_EXPIRES_AT`, which `login`/`refresh`
  // wrote beside the token THEY stored. It is absent for a hand-pasted token and
  // ignored for one replaced by hand, so the remedies differ from Path B's: there,
  // re-running `login` records nothing `debug_token` would ever read.
  const R = 'IG_PROFILE_BRAND_TOKEN_EXPIRES_AT';
  const base = { nowMs: 100 * DAY, refreshAfterDays: 7, recordedIn: R };
  const note = ` This is the expiry \`login\`/\`refresh\` recorded in ${R} for this token.`;

  assert.deepEqual(summarizeTokenExpiry({ ...base, expiresAtSec: undefined }), {
    state: 'unknown',
    warning: `Token expiry is unknown: no usable expiry is recorded in ${R} for this token (a hand-pasted token has none, a record that is not whole Unix seconds (one in milliseconds, say) is not read, and a record from a different source than the token, or written for a different token, is ignored). Run the \`login\` CLI to mint a token and record its expiry, or set ${R} to the token's expiry in Unix seconds.`,
  });
  assert.deepEqual(summarizeTokenExpiry({ ...base, expiresAtSec: Infinity }), {
    state: 'unknown',
    warning: `Token expiry is unknown: ${R} records Infinity, which is not a representable timestamp; set it to the token's expiry in Unix seconds.`,
  });
  const expiredAt = new Date(99 * DAY).toISOString();
  assert.deepEqual(summarizeTokenExpiry({ ...base, expiresAtSec: (99 * DAY) / 1000 }), {
    state: 'expired',
    expiresAt: expiredAt,
    daysLeft: -1,
    warning: `Token expired at ${expiredAt}; run the \`login\` CLI to obtain a new one.${note}`,
  });
  const soonAt = new Date(103 * DAY).toISOString();
  assert.deepEqual(summarizeTokenExpiry({ ...base, expiresAtSec: (103 * DAY) / 1000 }), {
    state: 'expiring_soon',
    expiresAt: soonAt,
    daysLeft: 3,
    warning: `Token expires at ${soonAt} (~3 day(s) left); run the \`refresh\` or \`login\` CLI.${note}`,
  });
  // A healthy record carries no warning, and `never` stays bare.
  assert.deepEqual(summarizeTokenExpiry({ ...base, expiresAtSec: 0 }), { state: 'never' });
  assert.equal(
    summarizeTokenExpiry({ ...base, expiresAtSec: (130 * DAY) / 1000 }).warning,
    undefined,
  );
});

test('summarizeTokenExpiry: a bare hand-set record is reported as unverified in every dated state (CC-AUTH-70)', () => {
  // A record with no token fingerprint is read as written: nothing ties it to
  // the token in the file, which may have been replaced since. Every answer
  // built from it says so — `valid` and `never` included, which otherwise carry
  // no warning at all and would present a hand-typed number as a fact about
  // this token.
  const R = 'IG_TOKEN_EXPIRES_AT';
  const base = { nowMs: 100 * DAY, refreshAfterDays: 7, recordedIn: R, recordUnverified: true };
  const unverified = `${R} records this expiry without a token fingerprint (a record set by hand), so it is taken as written and not checked against the token: if the token was replaced since, it describes the old one. Run the \`refresh\` or \`login\` CLI to record an expiry bound to the token.`;

  const validAt = new Date(130 * DAY).toISOString();
  assert.deepEqual(summarizeTokenExpiry({ ...base, expiresAtSec: (130 * DAY) / 1000 }), {
    state: 'valid',
    expiresAt: validAt,
    daysLeft: 30,
    warning: `Token expiry is unverified: ${unverified}`,
  });
  assert.deepEqual(summarizeTokenExpiry({ ...base, expiresAtSec: 0 }), {
    state: 'never',
    warning: `Token expiry is unverified: ${unverified}`,
  });
  const soonAt = new Date(103 * DAY).toISOString();
  assert.deepEqual(summarizeTokenExpiry({ ...base, expiresAtSec: (103 * DAY) / 1000 }), {
    state: 'expiring_soon',
    expiresAt: soonAt,
    daysLeft: 3,
    warning: `Token expires at ${soonAt} (~3 day(s) left); run the \`refresh\` or \`login\` CLI. ${unverified}`,
  });
  const expiredAt = new Date(99 * DAY).toISOString();
  assert.deepEqual(summarizeTokenExpiry({ ...base, expiresAtSec: (99 * DAY) / 1000 }), {
    state: 'expired',
    expiresAt: expiredAt,
    daysLeft: -1,
    warning: `Token expired at ${expiredAt}; run the \`login\` CLI to obtain a new one. ${unverified}`,
  });
  // No record, no claim: the unknown warning is the plain Path-A one.
  assert.deepEqual(
    summarizeTokenExpiry({ ...base, expiresAtSec: undefined }),
    summarizeTokenExpiry({ ...base, recordUnverified: false, expiresAtSec: undefined }),
  );
  // The flag qualifies a RECORD: on Path B (no `recordedIn`) it changes nothing.
  assert.deepEqual(
    summarizeTokenExpiry({
      nowMs: 100 * DAY,
      refreshAfterDays: 7,
      recordUnverified: true,
      expiresAtSec: 0,
    }),
    { state: 'never' },
  );
});

test('summarizeTokenExpiry: an unrepresentable expiry survives the debugToken → summarize path', async () => {
  // End-to-end through the real seam, with the payload parsed the way the HTTP
  // client parses one, because that is where `Infinity` is actually minted:
  // `1e400` is valid JSON and `JSON.parse` has nowhere else to put it. Driving
  // `summarizeTokenExpiry` with a hand-written `Infinity` would leave the claim
  // "this is reachable from Meta" untested.
  const { req } = stubReq(() => JSON.parse('{"data":{"expires_at":1e400}}'));

  const info = await debugToken(req, { inputToken: 'EAAsecret' });
  assert.equal(info.expiresAtSec, Infinity);

  const s = summarizeTokenExpiry({
    expiresAtSec: info.expiresAtSec,
    nowMs: 100 * DAY,
    refreshAfterDays: 45,
  });
  assert.equal(s.state, 'unknown');
});

test('summarizeTokenExpiry: the bounds of the recorded-expiry range are still reported, not refused (CC-AUTH-68)', () => {
  // The guard must reject only what neither path can mean. Pulling the
  // boundary in by one second would answer `unknown` for a timestamp Path A
  // reads back and `login` writes.
  const max = summarizeTokenExpiry({
    expiresAtSec: MAX_RECORDED_EXPIRY_SEC,
    nowMs: 0,
    refreshAfterDays: 45,
  });
  assert.equal(max.state, 'valid');
  assert.equal(max.expiresAt, '9999-12-31T23:59:59.000Z');

  // The first second after the epoch is a real (long past) instant; `0` is the
  // never-expires sentinel and is pinned separately.
  const min = summarizeTokenExpiry({ expiresAtSec: 1, nowMs: 100 * DAY, refreshAfterDays: 45 });
  assert.equal(min.state, 'expired');
  assert.equal(min.expiresAt, '1970-01-01T00:00:01.000Z');
});

test('summarizeTokenExpiry: property — no finite or non-finite number input can make it throw', () => {
  // The contract is total over `number`, not over the handful of values listed
  // above. `expires_at` is wire data and `nowMs`/`refreshAfterDays` come from a
  // clock and operator config, so the only defensible guarantee is that NO
  // combination of doubles crashes the diagnostic; the enumerated tests then pin
  // what each interesting one actually answers.
  const anyDouble = fc.oneof(
    fc.double(),
    fc.constantFrom(NaN, Infinity, -Infinity, 0, -0, 8.64e12, -8.64e12),
    fc.integer().map((n) => n * 1e9),
  );
  fc.assert(
    fc.property(anyDouble, anyDouble, anyDouble, (expiresAtSec, nowMs, refreshAfterDays) => {
      const s = summarizeTokenExpiry({ expiresAtSec, nowMs, refreshAfterDays });
      // Whatever it answers must be a state callers actually switch on, and any
      // `expiresAt` it does emit must be a real ISO instant.
      assert.ok(['unknown', 'never', 'valid', 'expiring_soon', 'expired'].includes(s.state));
      if (s.expiresAt !== undefined) {
        assert.ok(Number.isFinite(Date.parse(s.expiresAt)));
      }
    }),
    { numRuns: 500 },
  );
});

test('InstagramError from req propagates unchanged through the api layer', async () => {
  const boom = new InstagramError('token expired', { kind: 'auth', status: 401, code: 190 });
  const req: IgRequestFn = () => Promise.reject(boom);
  await assert.rejects(getAccount(req, { igId: 'me' }), (err) => {
    assert.equal(err, boom);
    return true;
  });
});

test('listLinkedAccounts reports an unreadable /me/accounts page instead of crashing (CC-DATA-72)', async () => {
  // The enumeration always walks every page, so an unreadable one used to fail
  // the whole call — and inside `login`, the whole Page selection. It must not
  // turn into "no linked Pages" either: that is the answer that sends an
  // operator to re-link a Page that is linked fine.
  for (const body of [{ data: { id: 'page1' } }, { data: null }, { data: 'abc' }, null, 7]) {
    const { req } = stubReq(() => body);
    const linked = await listLinkedAccounts(req, 200);
    const label = `body=${JSON.stringify(body)}`;
    assert.deepEqual(linked.items, [], label);
    assert.equal(linked.truncated, true, label);
    assert.match(linked.note ?? '', /unreadable page/, label);
  }
});

// --- summarizeDataAccessExpiry (CC-AUTH-77) ---------------------------------

test('summarizeDataAccessExpiry classifies the data-access window (CC-AUTH-77)', () => {
  const DAY_MS = 86_400_000;
  const nowMs = 100 * DAY_MS;
  const nowSec = nowMs / 1000;
  const iso = (sec: number): string => new Date(sec * 1000).toISOString();
  // No window: Meta omitted it, or sent its 0 "not applicable" sentinel.
  assert.deepEqual(summarizeDataAccessExpiry({ nowMs }), { state: 'none' });
  assert.deepEqual(summarizeDataAccessExpiry({ dataAccessExpiresAtSec: 0, nowMs }), {
    state: 'none',
  });
  // Open: strictly after now, however close.
  for (const sec of [nowSec + 1, nowSec + 30 * 86_400, MAX_RECORDED_EXPIRY_SEC]) {
    assert.deepEqual(summarizeDataAccessExpiry({ dataAccessExpiresAtSec: sec, nowMs }), {
      state: 'open',
      expiresAt: iso(sec),
    });
  }
  // Expired: at now exactly (the boundary is inclusive) and before it.
  for (const sec of [nowSec, nowSec - 1, 1]) {
    assert.deepEqual(summarizeDataAccessExpiry({ dataAccessExpiresAtSec: sec, nowMs }), {
      state: 'expired',
      expiresAt: iso(sec),
      warning:
        `Data access expired at ${iso(sec)}: the token can still be valid, but reads of ` +
        'Instagram data fail with a permission error until the app is re-authorized; run the ' +
        '`login` CLI to renew the data-access window.',
    });
  }
  // Unknown: not a representable instant, or not a number at all. `null`,
  // `false` and `"0"` are not the 0 sentinel.
  for (const [value, shown] of [
    [-1, '-1'],
    [1.5, '1.5'],
    [MAX_RECORDED_EXPIRY_SEC + 1, String(MAX_RECORDED_EXPIRY_SEC + 1)],
    [null, 'null (type object)'],
    [false, 'false (type boolean)'],
    ['0', '"0" (type string)'],
  ] as const) {
    assert.deepEqual(
      summarizeDataAccessExpiry({ dataAccessExpiresAtSec: value as unknown as number, nowMs }),
      {
        state: 'unknown',
        warning: `Data-access expiry is unknown: upstream reported a \`data_access_expires_at\` of ${shown}, which is not a representable timestamp.`,
      },
      String(value),
    );
  }
});
