import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROFILE_NAME,
  currentAccount,
  loadProfiles,
  resolveProfile,
  withAccount,
  type Env,
} from '../../src/core/config.js';
import { isInstagramError } from '../../src/core/types.js';

/** Assert `fn` throws an InstagramError with `kind: 'validation'`. */
function assertValidation(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => isInstagramError(err) && err.kind === 'validation');
}

// --- Default profile & auth-path inference ---------------------------------

test('default profile: a bare token infers ig-login', () => {
  const { profiles, defaultName } = loadProfiles({ IG_ACCESS_TOKEN: 'tok-a' });
  assert.equal(defaultName, DEFAULT_PROFILE_NAME);
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0], {
    name: 'default',
    authPath: 'ig-login',
    accessToken: 'tok-a',
    accountId: undefined,
    appId: undefined,
    appSecret: undefined,
  });
});

test('default profile: app id + secret infers fb-login and captures all fields', () => {
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-b',
    IG_ACCOUNT_ID: '178414',
    IG_APP_ID: 'app-1',
    IG_APP_SECRET: 'sec-1',
  });
  assert.deepEqual(profiles[0], {
    name: 'default',
    authPath: 'fb-login',
    accessToken: 'tok-b',
    accountId: '178414',
    appId: 'app-1',
    appSecret: 'sec-1',
  });
});

test('default profile: explicit IG_AUTH_PATH overrides inference', () => {
  // App creds present would infer fb-login; the explicit value wins.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_AUTH_PATH: 'ig-login',
    IG_APP_ID: 'app',
    IG_APP_SECRET: 'sec',
  });
  assert.equal(profiles[0]?.authPath, 'ig-login');
});

test('default profile: IG_AUTH_MODE is accepted as a fallback for IG_AUTH_PATH', () => {
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_AUTH_MODE: 'fb-login',
    IG_APP_ID: 'app',
    IG_APP_SECRET: 'sec',
  });
  assert.equal(profiles[0]?.authPath, 'fb-login');
});

test('default profile: setting both spellings, IG_AUTH_PATH wins over IG_AUTH_MODE', () => {
  // The named-profile rule ("the canonical suffix wins") is pinned below; the
  // default profile reads its two spellings through a separate expression, so
  // nothing above proves the two halves agree. They must: an operator who
  // migrated from one spelling to the other and left both in the .env file gets
  // a different auth path — and therefore a different Graph host — depending on
  // which of the two code paths built the profile.
  const both = (authPath: string, authMode: string): string | undefined =>
    loadProfiles({
      IG_ACCESS_TOKEN: 'tok',
      IG_AUTH_PATH: authPath,
      IG_AUTH_MODE: authMode,
      // Present so either winner is a *valid* profile — otherwise fb-login would
      // fail on missing app credentials and the assertion would pass for the
      // wrong reason.
      IG_APP_ID: 'app',
      IG_APP_SECRET: 'sec',
    }).profiles[0]?.authPath;

  assert.equal(both('ig-login', 'fb-login'), 'ig-login');
  // Both directions, so this cannot pass by 'ig-login' happening to win.
  assert.equal(both('fb-login', 'ig-login'), 'fb-login');
});

test('inference needs both app credentials — a lone app id stays on ig-login', () => {
  // Path B needs the id *and* the secret to compute `appsecret_proof`, so half a
  // credential pair is not evidence of Path B. Inferring fb-login from one of
  // them turns a working Path A setup into a hard startup failure ("missing
  // IG_APP_ID / IG_APP_SECRET") for an operator who parked an app id in the
  // environment for something else entirely.
  for (const partial of [{ IG_APP_ID: 'app-only' }, { IG_APP_SECRET: 'sec-only' }]) {
    const { profiles } = loadProfiles({ IG_ACCESS_TOKEN: 'tok', ...partial });
    assert.equal(profiles[0]?.authPath, 'ig-login', JSON.stringify(partial));
  }
});

test('blank / whitespace values are treated as absent (token only -> ig-login)', () => {
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: '  tok  ',
    IG_APP_ID: '   ',
    IG_APP_SECRET: '',
  });
  assert.equal(profiles[0]?.accessToken, 'tok');
  assert.equal(profiles[0]?.authPath, 'ig-login');
  assert.equal(profiles[0]?.appId, undefined);
});

// --- Named profiles --------------------------------------------------------

test('named profiles: NAME is uppercased in env, stored lowercased', () => {
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
    IG_PROFILE_BRAND_APP_ID: 'app-brand',
    IG_PROFILE_BRAND_APP_SECRET: 'sec-brand',
  });
  const brand = profiles.find((p) => p.name === 'brand');
  assert.ok(brand);
  assert.equal(brand.authPath, 'fb-login');
  assert.equal(brand.accessToken, 'tok-brand');
  assert.equal(brand.appId, 'app-brand');
});

test('named profiles: a NAME containing an underscore is parsed correctly', () => {
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_MY_BRAND_ACCESS_TOKEN: 'tok-mb',
    IG_PROFILE_MY_BRAND_ACCOUNT_ID: '999',
  });
  const mb = profiles.find((p) => p.name === 'my_brand');
  assert.ok(mb);
  assert.equal(mb.accessToken, 'tok-mb');
  assert.equal(mb.accountId, '999');
  assert.equal(mb.authPath, 'ig-login');
});

test('CC-CFG-2: auth path is resolved per profile (default Path A, named Path B)', () => {
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_BIZ_ACCESS_TOKEN: 'tok-biz',
    IG_PROFILE_BIZ_AUTH_PATH: 'fb-login',
    IG_PROFILE_BIZ_APP_ID: 'app',
    IG_PROFILE_BIZ_APP_SECRET: 'sec',
  });
  assert.equal(profiles.find((p) => p.name === 'default')?.authPath, 'ig-login');
  assert.equal(profiles.find((p) => p.name === 'biz')?.authPath, 'fb-login');
});

test('a named profile accepts IG_PROFILE_<NAME>_AUTH_MODE as well as _AUTH_PATH', () => {
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_BIZ_ACCESS_TOKEN: 'tok-biz',
    IG_PROFILE_BIZ_AUTH_MODE: 'fb-login',
    IG_PROFILE_BIZ_APP_ID: 'app',
    IG_PROFILE_BIZ_APP_SECRET: 'sec',
  });
  assert.equal(profiles.find((p) => p.name === 'biz')?.authPath, 'fb-login');
});

test('a named profile setting both spellings: _AUTH_PATH wins over _AUTH_MODE', () => {
  // Both orderings, because `readNamedRaw` walks `Object.entries` insertion order.
  for (const env of [
    { IG_PROFILE_BIZ_AUTH_PATH: 'ig-login', IG_PROFILE_BIZ_AUTH_MODE: 'fb-login' },
    { IG_PROFILE_BIZ_AUTH_MODE: 'fb-login', IG_PROFILE_BIZ_AUTH_PATH: 'ig-login' },
  ]) {
    const { profiles } = loadProfiles({
      IG_ACCESS_TOKEN: 'tok-default',
      IG_PROFILE_BIZ_ACCESS_TOKEN: 'tok-biz',
      ...env,
    });
    assert.equal(profiles.find((p) => p.name === 'biz')?.authPath, 'ig-login');
  }
});

test('a profile named "auth" is not swallowed by the AUTH_MODE alias', () => {
  // `IG_PROFILE_AUTH_MODE` ends with `_MODE`, not `_AUTH_MODE`, so it must not
  // parse as an auth-path assignment for an empty profile name.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_AUTH_ACCESS_TOKEN: 'tok-auth',
    IG_PROFILE_AUTH_AUTH_MODE: 'fb-login',
    IG_PROFILE_AUTH_APP_ID: 'app',
    IG_PROFILE_AUTH_APP_SECRET: 'sec',
  });
  assert.equal(profiles.find((p) => p.name === 'auth')?.authPath, 'fb-login');
});

test('the suffix must be separated by an underscore, not merely trailing', () => {
  // `IG_PROFILE_BRANDACCESS_TOKEN` — the separator typo — still *ends with*
  // `ACCESS_TOKEN`. Matching on the bare suffix would accept it and then slice
  // the name by the suffix length, producing a profile called `bran`: a
  // credential silently attached to an account nobody named, under a token the
  // operator believes belongs to `brand`.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_BRANDACCESS_TOKEN: 'tok-typo',
    IG_PROFILE_MYAPP_ID: 'app-typo',
  });
  assert.deepEqual(
    profiles.map((p) => p.name),
    ['default'],
  );
});

test('a suffix with no name in front of it creates no profile', () => {
  // `IG_PROFILE__ACCESS_TOKEN` (double underscore, an easy hand-edit slip) would
  // name the empty profile — unreachable by `account:` and unnameable in an
  // error message. Two independent guards reject it: the length check in
  // `readNamedRaw`'s suffix match and the `name === ''` check right after. Either
  // one alone is enough, which is why a single-point mutation of either survives
  // — this test is what fails the moment both are gone.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE__ACCESS_TOKEN: 'tok-nameless',
    IG_PROFILE__APP_ID: 'app-nameless',
  });
  assert.deepEqual(
    profiles.map((p) => p.name),
    ['default'],
  );
});

test('an IG_PROFILE_ var with an unrecognised suffix creates no profile at all', () => {
  // The prefix is a namespace, not a claim on every key inside it. An operator
  // parking `IG_PROFILE_BRAND_NOTE` (or a future key this build predates) must
  // not conjure a credential-less `brand` profile that then fails validation —
  // the var is simply not ours to read.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_BRAND_NOTE: 'a comment to self',
    IG_PROFILE_BRAND_TOKEN: 'not the ACCESS_TOKEN suffix',
  });
  assert.deepEqual(
    profiles.map((p) => p.name),
    ['default'],
  );
});

test('a named profile colliding with "default" is ignored (bare vars own it)', () => {
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'bare',
    IG_PROFILE_DEFAULT_ACCESS_TOKEN: 'shadow',
  });
  const defaults = profiles.filter((p) => p.name === 'default');
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0]?.accessToken, 'bare');
});

test('IG_ACTIVE_PROFILE sets the default name (lowercased and trimmed)', () => {
  const { defaultName } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
    IG_ACTIVE_PROFILE: 'BRAND',
  });
  assert.equal(defaultName, 'brand');

  // A trailing space is the most ordinary thing in a hand-edited .env file, and
  // `defaultName` is a returned value that `doctor` prints and an embedder may
  // compare — it must not carry the whitespace forward.
  const padded = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
    IG_ACTIVE_PROFILE: '  BRAND  ',
  });
  assert.equal(padded.defaultName, 'brand');

  // Blank means "unset", not "a profile named nothing".
  const blank = loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_ACTIVE_PROFILE: '   ' });
  assert.equal(blank.defaultName, DEFAULT_PROFILE_NAME);
});

test('the default profile is always first, whatever the named profiles are', () => {
  // Documented on `LoadedProfiles.profiles` and relied on by anything that
  // renders the list: the first entry is the account you get when you pass no
  // `account:`. Nothing else in the suite pins the order, so a refactor that
  // appends the default last would silently invert what an operator is shown.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_AAA_ACCESS_TOKEN: 'tok-aaa',
    IG_PROFILE_ZZZ_ACCESS_TOKEN: 'tok-zzz',
  });
  assert.equal(profiles[0]?.name, DEFAULT_PROFILE_NAME);
  assert.equal(profiles.length, 3);
});

// --- Validation failures ---------------------------------------------------

test('validation: empty env (no default token) is rejected', () => {
  assertValidation(() => loadProfiles({}));
});

test('validation: the nothing-configured message is the first-run one, not a per-profile one', () => {
  // This is the very first error a new operator can hit, and there are two
  // candidates for it: the up-front "nothing is configured" check and the
  // per-profile "this profile has no token" check that would fire anyway. They
  // are not interchangeable — the second one talks about a profile the operator
  // never created, and it is reached only *after* the auth-path check, so an
  // otherwise-empty env with a typo'd IG_AUTH_MODE would report the typo rather
  // than the missing token. Pin the up-front message.
  assert.throws(
    () => loadProfiles({ IG_AUTH_MODE: 'oauth2' }),
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'validation' &&
      /No default profile configured/.test(err.message) &&
      err.message.includes('IG_ACCESS_TOKEN'),
  );
});

test('validation: a whitespace-only default token is rejected', () => {
  assertValidation(() => loadProfiles({ IG_ACCESS_TOKEN: '   ' }));
});

test('validation: fb-login default missing app secret is rejected', () => {
  assertValidation(() =>
    loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_AUTH_PATH: 'fb-login', IG_APP_ID: 'app' }),
  );
});

test('validation: an unknown IG_AUTH_PATH value is rejected', () => {
  assertValidation(() => loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_AUTH_PATH: 'oauth2' }));
});

test('validation: the unknown-auth-path error names both accepted spellings', () => {
  // Whichever spelling the operator used, the message must mention it — naming
  // only the variable they did not set reads like a bug in the server.
  assert.throws(
    () => loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_AUTH_MODE: 'oauth2' }),
    (err: unknown) =>
      isInstagramError(err) &&
      err.message.includes('IG_AUTH_MODE') &&
      err.message.includes('IG_AUTH_PATH'),
  );
});

test('validation: a named profile without a token is rejected, naming the real env var', () => {
  // Profile names are stored lowercased; the env vars they came from are upper.
  // An error message that echoes the stored name tells the operator to set
  // `IG_PROFILE_brand_ACCESS_TOKEN`, a variable this parser would never read —
  // they set it, restart, and get the same error with no way to see why.
  assert.throws(
    () =>
      loadProfiles({
        IG_ACCESS_TOKEN: 'tok-default',
        IG_PROFILE_BRAND_APP_ID: 'app',
        IG_PROFILE_BRAND_APP_SECRET: 'sec',
      }),
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'validation' &&
      err.message.includes("'brand'") &&
      err.message.includes('IG_PROFILE_BRAND_ACCESS_TOKEN'),
  );
});

test('validation errors never leak token values', () => {
  const env: Env = { IG_ACCESS_TOKEN: 'tok', IG_AUTH_PATH: 'fb-login', IG_APP_ID: 'app' };
  try {
    loadProfiles(env);
    assert.fail('expected a validation error');
  } catch (err) {
    assert.ok(isInstagramError(err));
    assert.ok(!err.message.includes('tok'));
  }
});

// --- resolveProfile --------------------------------------------------------

test('resolveProfile: returns the named profile (case-insensitive)', () => {
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
  });
  assert.equal(resolveProfile(profiles, 'BRAND').name, 'brand');
});

test('resolveProfile: falls back to the default when name is omitted or blank', () => {
  const { profiles } = loadProfiles({ IG_ACCESS_TOKEN: 'tok' });
  assert.equal(resolveProfile(profiles).name, 'default');
  assert.equal(resolveProfile(profiles, '   ').name, 'default');
});

test('CC-CFG-1: unknown profile throws validation listing configured names', () => {
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
  });
  assert.throws(
    () => resolveProfile(profiles, 'ghost'),
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'validation' &&
      err.message.includes('default') &&
      err.message.includes('brand') &&
      // Names only — never token values.
      !err.message.includes('tok-brand'),
  );

  // The message echoes what the caller asked for, not the lowercased lookup key:
  // the operator has to find `Ghost` in their own config, and a message quoting
  // a spelling they never wrote sends them looking for the wrong string.
  assert.throws(
    () => resolveProfile(profiles, 'Ghost'),
    (err: unknown) => isInstagramError(err) && err.message.includes("'Ghost'"),
  );
});

test('CC-CFG-1: with nothing configured the message says so instead of trailing off', () => {
  // `resolveProfile` is exported and is called with whatever `loadProfiles`
  // returned; an embedder wiring its own list can hand over an empty one. The
  // "configured profiles:" half would then end on a bare period and read as a
  // truncated error — `(none)` names the actual problem: nothing is configured.
  assert.throws(
    () => resolveProfile([], 'brand'),
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'validation' &&
      /configured profiles: \(none\)/.test(err.message) &&
      err.message.includes("'brand'"),
  );
});

// --- Active-account context ------------------------------------------------

test('currentAccount is undefined outside any withAccount scope', () => {
  assert.equal(currentAccount(), undefined);
});

test('withAccount exposes the active account to downstream code', async () => {
  const seen = await withAccount('brand', () => currentAccount());
  assert.equal(seen, 'brand');
  assert.equal(currentAccount(), undefined);
});

test('withAccount nests, and returns the callback result', async () => {
  const result = await withAccount('outer', async () => {
    assert.equal(currentAccount(), 'outer');
    const inner = await withAccount('inner', () => currentAccount());
    assert.equal(inner, 'inner');
    assert.equal(currentAccount(), 'outer');
    return 42;
  });
  assert.equal(result, 42);
});

test('withAccount contexts stay isolated across concurrent async work', async () => {
  const [a, b] = await Promise.all([
    withAccount('a', async () => {
      await Promise.resolve();
      return currentAccount();
    }),
    withAccount('b', async () => currentAccount()),
  ]);
  assert.equal(a, 'a');
  assert.equal(b, 'b');
});

test('withAccount rejects when the callback throws', async () => {
  await assert.rejects(
    withAccount('x', () => {
      throw new Error('boom');
    }),
    /boom/,
  );
});
