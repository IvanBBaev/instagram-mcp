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

test('a named profile colliding with "default" is ignored (bare vars own it)', () => {
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'bare',
    IG_PROFILE_DEFAULT_ACCESS_TOKEN: 'shadow',
  });
  const defaults = profiles.filter((p) => p.name === 'default');
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0]?.accessToken, 'bare');
});

test('IG_ACTIVE_PROFILE sets the default name (lowercased)', () => {
  const { defaultName } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
    IG_ACTIVE_PROFILE: 'BRAND',
  });
  assert.equal(defaultName, 'brand');
});

// --- Validation failures ---------------------------------------------------

test('validation: empty env (no default token) is rejected', () => {
  assertValidation(() => loadProfiles({}));
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

test('validation: a named profile without a token is rejected', () => {
  assertValidation(() =>
    loadProfiles({
      IG_ACCESS_TOKEN: 'tok-default',
      IG_PROFILE_BRAND_APP_ID: 'app',
      IG_PROFILE_BRAND_APP_SECRET: 'sec',
    }),
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
