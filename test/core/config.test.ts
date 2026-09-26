import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PROFILE_NAME,
  TOKEN_EXPIRES_AT_SUFFIX,
  currentAccount,
  isProfileEnvName,
  loadProfiles,
  resolveProfile,
  strayExpiryKeys,
  tokenFingerprint,
  unsetPlaceholderKeys,
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
  // `find(...)?.authPath` reads ONE field off whichever element it picked, so it
  // is blind to every other field of that element. A named profile could lose
  // the app secret that `fb-login` cannot sign a single call without, and this
  // assertion would still read `fb-login` and pass. That blindness is not
  // covered elsewhere: all eight whole-profile `deepEqual`s in the corpus are on
  // `profiles[0]`, the DEFAULT profile — no test anywhere pins a NAMED one
  // whole. Pin `biz` as a whole record, next to the path it resolved.
  assert.deepEqual(
    profiles.find((p) => p.name === 'biz'),
    {
      name: 'biz',
      authPath: 'fb-login',
      accessToken: 'tok-biz',
      accountId: undefined,
      appId: 'app',
      appSecret: 'sec',
    },
  );
});

test('a named profile accepts IG_PROFILE_<NAME>_AUTH_MODE as well as _AUTH_PATH', () => {
  // The alias must be the ONLY thing that can produce this answer, or the test
  // proves nothing: app id + secret are set, so inference would say `fb-login`
  // all by itself, and asking for `fb-login` through the alias would pass just
  // as well with the alias table emptied. Ask for the value inference would not
  // have chosen instead.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_BIZ_ACCESS_TOKEN: 'tok-biz',
    IG_PROFILE_BIZ_AUTH_MODE: 'ig-login',
    IG_PROFILE_BIZ_APP_ID: 'app',
    IG_PROFILE_BIZ_APP_SECRET: 'sec',
  });
  assert.equal(profiles.find((p) => p.name === 'biz')?.authPath, 'ig-login');
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
  //
  // The requested path is `ig-login` against an env carrying app credentials,
  // for the same reason as the test above: `fb-login` is what inference would
  // return anyway, so it cannot distinguish "the alias was read" from "the
  // alias was dropped on the floor".
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_AUTH_ACCESS_TOKEN: 'tok-auth',
    IG_PROFILE_AUTH_AUTH_MODE: 'ig-login',
    IG_PROFILE_AUTH_APP_ID: 'app',
    IG_PROFILE_AUTH_APP_SECRET: 'sec',
  });
  assert.equal(profiles.find((p) => p.name === 'auth')?.authPath, 'ig-login');
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

test('the suffix must END the key, not merely appear inside it', () => {
  // The mirror of the test above. `IG_PROFILE_BRAND_ACCESS_TOKEN_OLD` is the
  // shape an operator produces by keeping a rotated credential around instead
  // of deleting it. `_ACCESS_TOKEN` occurs in the middle of that key, so a
  // containment test matches it and then slices the name by the suffix length
  // measured from the END — yielding `brand_acc`, a profile holding the
  // *superseded* token under a name nobody typed. The same slip on
  // `IG_PROFILE_BRAND_APP_ID_OLD` is worse still: the bogus profile has no
  // token of its own, so `loadProfiles` throws and the whole server refuses to
  // start over a parked variable.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
    IG_PROFILE_BRAND_ACCESS_TOKEN_OLD: 'tok-rotated-out',
    IG_PROFILE_BRAND_APP_ID_OLD: 'app-rotated-out',
  });
  assert.deepEqual(
    profiles.map((p) => p.name),
    ['default', 'brand'],
  );
  assert.equal(profiles.find((p) => p.name === 'brand')?.accessToken, 'tok-brand');
});

test('the IG_PROFILE_ prefix must START the key, not merely appear inside it', () => {
  // `OLD_IG_PROFILE_BRAND_ACCESS_TOKEN` is the other parking habit: rename the
  // variable rather than delete it. The name is sliced at a FIXED offset —
  // `key.slice(NAMED_PREFIX.length)` — which only lines up with the real prefix
  // when the prefix begins the key, so a containment test here does not merely
  // admit an extra variable, it reads the name out of the wrong characters and
  // produces the profile `ile_brand`.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    OLD_IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-retired',
  });
  assert.deepEqual(
    profiles.map((p) => p.name),
    ['default'],
  );
});

test('the IG_PROFILE_ prefix is matched case-sensitively — ig_profile_ in another case defines nothing', () => {
  // Environment variable names are case-sensitive on every platform this server
  // runs on, and the documented spelling is upper-case. A key whose prefix is
  // spelled in another case but whose suffix is not (`ig_profile_BRAND_ACCESS_TOKEN`)
  // is the fixture that separates an exact prefix match from a case-folded one:
  // with the prefix folded the suffix still matches and a `brand` profile appears
  // out of a variable the operator never meant as configuration.
  for (const key of [
    'ig_profile_BRAND_ACCESS_TOKEN',
    'Ig_Profile_BRAND_ACCESS_TOKEN',
    'IG_PROFILE_brand_access_token',
    'IG_PROFILES_BRAND_ACCESS_TOKEN',
    'IG_PROFILE-BRAND_ACCESS_TOKEN',
  ]) {
    const { profiles } = loadProfiles({ IG_ACCESS_TOKEN: 'tok-default', [key]: 'tok-stray' });
    assert.deepEqual(
      profiles.map((p) => p.name),
      ['default'],
      key,
    );
  }
});

test('an env entry whose value is undefined is ignored, not turned into a profile', () => {
  // `Env` is `Record<string, string | undefined>` — a caller that merges a
  // dotenv map over `process.env`, or clears one key of an override object,
  // hands us an entry that exists with no value. Grouping it by name would
  // create a profile whose every field is unset, and `buildProfile` would then
  // reject it for having no access token: one benign leftover key and the
  // server will not start.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_GHOST_ACCESS_TOKEN: undefined,
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
  // And rejected by the up-front check, with the first-run message the test
  // above argues for. A blank value is not the same as a missing one to the
  // `=== undefined` test that guard could have been written as, and the
  // per-profile check downstream would also throw — with the wrong message, one
  // that talks about a profile the operator never created.
  assert.throws(
    () => loadProfiles({ IG_ACCESS_TOKEN: '   ' }),
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'validation' &&
      /No default profile configured/.test(err.message),
  );
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

// --- Whole-message pins and near-miss lookups (third mutation pass) -----------

/** Assert `fn` throws a validation InstagramError whose message is exactly `message`. */
function assertValidationMessage(fn: () => unknown, message: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(isInstagramError(err), 'expected an InstagramError');
    assert.equal(err.kind, 'validation');
    assert.equal(err.message, message);
    return true;
  });
}

test('every configuration refusal is pinned whole — variable names, echoed value, guidance', () => {
  // Rule CC-PROC-54 again: `includes('IG_AUTH_MODE') && includes('IG_AUTH_PATH')` is
  // satisfied by a message that calls the canonical spelling the alias, and
  // `includes("'brand'")` by one that has lost its "set <var>" instruction. Five
  // mutants survived on these lines: the fb-login refusal naming APP_ID twice
  // instead of APP_ID / APP_SECRET, the first-run message without its "(the
  // default account token)" gloss, the unknown-auth-path message without the
  // value it refused, the same message with canonical and alias swapped, and the
  // named-profile token refusal reworded around its fragments. Each row pins the
  // entire line an operator reads at startup.
  const rows: ReadonlyArray<readonly [Env, string]> = [
    [{}, 'No default profile configured; set IG_ACCESS_TOKEN (the default account token).'],
    [
      { IG_ACCESS_TOKEN: 'tok', IG_AUTH_PATH: 'fb-login', IG_APP_ID: 'app' },
      "Profile 'default' uses fb-login but is missing IG_APP_ID / IG_APP_SECRET.",
    ],
    [
      {
        IG_ACCESS_TOKEN: 'tok',
        IG_PROFILE_BIZ_ACCESS_TOKEN: 'tok-biz',
        IG_PROFILE_BIZ_AUTH_MODE: 'fb-login',
        IG_PROFILE_BIZ_APP_ID: 'app',
      },
      // A named profile names BOTH of its own variables — never the default's.
      "Profile 'biz' uses fb-login but is missing IG_PROFILE_BIZ_APP_ID / IG_PROFILE_BIZ_APP_SECRET.",
    ],
    [
      { IG_ACCESS_TOKEN: 'tok', IG_AUTH_MODE: 'oauth2' },
      "IG_AUTH_MODE (alias IG_AUTH_PATH) has an unknown value 'oauth2'; expected 'ig-login' or 'fb-login'.",
    ],
    [
      {
        IG_ACCESS_TOKEN: 'tok',
        IG_PROFILE_BIZ_ACCESS_TOKEN: 'tok-biz',
        IG_PROFILE_BIZ_AUTH_PATH: 'x',
      },
      "IG_PROFILE_BIZ_AUTH_MODE (alias IG_PROFILE_BIZ_AUTH_PATH) has an unknown value 'x'; expected 'ig-login' or 'fb-login'.",
    ],
    [
      {
        IG_ACCESS_TOKEN: 'tok',
        IG_PROFILE_BRAND_APP_ID: 'app',
        IG_PROFILE_BRAND_APP_SECRET: 'sec',
      },
      "Profile 'brand' has no access token; set IG_PROFILE_BRAND_ACCESS_TOKEN.",
    ],
  ];
  for (const [env, message] of rows) {
    assertValidationMessage(() => loadProfiles(env), message);
  }
});

test('resolveProfile matches the whole name — a prefix, an extension or a substring is unknown', () => {
  // `profiles.find((p) => p.name === target)` mutated to `startsWith(target)`
  // survived: every unknown name the suite asked for ('ghost') was unrelated to
  // every configured one. With a prefix match, `--account bra` (or a typo that
  // drops the last letter) would silently pick 'brand' — and on an account
  // switch between 'brand' and 'brand2', a truncated name would land writes on
  // the wrong Instagram account.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
    IG_PROFILE_BRAND2_ACCESS_TOKEN: 'tok-brand2',
  });
  assert.equal(resolveProfile(profiles, 'brand').name, 'brand');
  assert.equal(resolveProfile(profiles, 'brand2').name, 'brand2');
  for (const near of ['bra', 'b', 'brand3', 'rand', 'defaul', 'default2', 'efault']) {
    assertValidationMessage(
      () => resolveProfile(profiles, near),
      `Unknown account profile '${near}'; configured profiles: default, brand, brand2.`,
    );
  }
});

test('an auth-path value is matched case-insensitively and resolves to the canonical spelling', () => {
  // Every enum knob folds case since CC-CFG-13 (2026-09-19): `IG_AUTH_MODE` is
  // one of them, and `login --path` already accepted `IG`/`FB`. What comes out
  // is the lower-case value every `authPath === 'fb-login'` downstream compares
  // against — never the operator's casing.
  assert.equal(
    loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_AUTH_MODE: 'IG-LOGIN' }).profiles[0]?.authPath,
    'ig-login',
  );
  assert.equal(
    loadProfiles({
      IG_ACCESS_TOKEN: 'tok',
      IG_AUTH_MODE: 'Fb-Login',
      IG_APP_ID: 'app',
      IG_APP_SECRET: 'sec',
    }).profiles[0]?.authPath,
    'fb-login',
  );
  // Folding case does not widen the set, and the refusal echoes the value as
  // typed so the operator can find it in their file.
  for (const near of ['ig_login', 'FB-LOGIN2', 'fb']) {
    assertValidationMessage(
      () => loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_AUTH_MODE: near }),
      `IG_AUTH_MODE (alias IG_AUTH_PATH) has an unknown value '${near}'; expected 'ig-login' or 'fb-login'.`,
    );
  }
});

test('an auth-path refusal never echoes a value long enough to be a mis-filed credential (CC-CFG-47)', () => {
  // The refusal is thrown inside `loadProfiles`, before any secret is
  // registered, so at the startup-failure line only the token-shape backstop
  // runs — and a 32-hex app secret matches no shape. An app secret pasted into
  // `IG_AUTH_MODE` went to stderr verbatim. The fixture is hex-only on purpose:
  // it is the shape the backstop misses. The boundary pins both sides: the
  // longest plausible mode typo is still echoed, one character more is not.
  const misfiled = 'abcdef0123456789abcdef0123456789';
  assertValidationMessage(
    () => loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_AUTH_MODE: misfiled }),
    "IG_AUTH_MODE (alias IG_AUTH_PATH) has an unknown value of 32 characters (not echoed — it may be a credential set under the wrong name); expected 'ig-login' or 'fb-login'.",
  );
  const longestEchoed = 'instagram_business_login';
  assert.equal(longestEchoed.length, 24);
  assertValidationMessage(
    () => loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_AUTH_MODE: longestEchoed }),
    `IG_AUTH_MODE (alias IG_AUTH_PATH) has an unknown value '${longestEchoed}'; expected 'ig-login' or 'fb-login'.`,
  );
  assertValidationMessage(
    () => loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_AUTH_MODE: `${longestEchoed}s` }),
    "IG_AUTH_MODE (alias IG_AUTH_PATH) has an unknown value of 25 characters (not echoed — it may be a credential set under the wrong name); expected 'ig-login' or 'fb-login'.",
  );
});

test('isProfileEnvName vouches for exactly the keys the profile scheme reads or writes', () => {
  // The composition root's unrecognised-`IG_*` warning (CC-CFG-13) trusts this
  // predicate for the profile half of the namespace. Its classification must be
  // `readNamedRaw`'s own: a key the parser drops silently — an empty name, the
  // reserved name `default`, an unknown suffix — is exactly what the operator
  // must hear about, so it is NOT recognised here.
  const recognised = [
    'IG_ACCESS_TOKEN',
    'IG_AUTH_MODE',
    'IG_AUTH_PATH',
    'IG_ACCOUNT_ID',
    'IG_APP_ID',
    'IG_APP_SECRET',
    'IG_ACTIVE_PROFILE',
    `IG_${TOKEN_EXPIRES_AT_SUFFIX}`,
    'IG_PROFILE_BRAND_ACCESS_TOKEN',
    'IG_PROFILE_BRAND_AUTH_MODE',
    'IG_PROFILE_BRAND_AUTH_PATH',
    'IG_PROFILE_BRAND_APP_SECRET',
    `IG_PROFILE_BRAND_${TOKEN_EXPIRES_AT_SUFFIX}`,
    'IG_PROFILE_MY_SHOP_ACCOUNT_ID',
  ];
  for (const key of recognised) assert.equal(isProfileEnvName(key), true, key);
  const unrecognised = [
    'IG_ACCESSTOKEN',
    'IG_ACCESS_TOKEN_',
    'IG_PROFILE_ACCESS_TOKEN',
    'IG_PROFILE__ACCESS_TOKEN',
    'IG_PROFILE_DEFAULT_ACCESS_TOKEN',
    'IG_PROFILE_BRAND_TOKEN',
    'IG_PROFILE_BRAND',
    'IG_PROFILE_',
    'IG_WRITE_MODE',
    'XDG_CONFIG_HOME',
  ];
  for (const key of unrecognised) assert.equal(isProfileEnvName(key), false, key);
  assert.equal(TOKEN_EXPIRES_AT_SUFFIX, 'TOKEN_EXPIRES_AT');
});

test('a present-but-blank _AUTH_PATH beside an _AUTH_MODE alias falls through to the alias, in both orders', () => {
  // The default profile reads `clean(IG_AUTH_PATH) ?? clean(IG_AUTH_MODE)`, so a
  // blank canonical falls through to the alias there. Named profiles used to
  // fold the two spellings while walking `Object.entries`, where a blank
  // canonical was *present* and shadowed the alias, leaving the path to
  // inference (fb-login here, from the app credentials) — a different Graph
  // host from the same .env, depending only on which profile it was written
  // under. Fixed 2026-09-19 by collecting the alias spelling apart and folding
  // it in after the walk with the same `??` rule; both orders pinned because
  // the walk order is the env's insertion order and the fold must not care.
  const base: Env = {
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_BIZ_ACCESS_TOKEN: 'tok-biz',
    IG_PROFILE_BIZ_APP_ID: 'app',
    IG_PROFILE_BIZ_APP_SECRET: 'sec',
  };
  const canonicalFirst = loadProfiles({
    ...base,
    IG_PROFILE_BIZ_AUTH_PATH: '',
    IG_PROFILE_BIZ_AUTH_MODE: 'ig-login',
  });
  const aliasFirst = loadProfiles({
    ...base,
    IG_PROFILE_BIZ_AUTH_MODE: 'ig-login',
    IG_PROFILE_BIZ_AUTH_PATH: '',
  });
  const pathOf = (loaded: ReturnType<typeof loadProfiles>): string | undefined =>
    loaded.profiles.find((p) => p.name === 'biz')?.authPath;
  assert.equal(pathOf(canonicalFirst), 'ig-login');
  assert.equal(pathOf(aliasFirst), 'ig-login');
  // The default profile, same env shape, same answer: the two code paths agree.
  const viaDefault = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_AUTH_PATH: '   ',
    IG_AUTH_MODE: 'ig-login',
    IG_APP_ID: 'app',
    IG_APP_SECRET: 'sec',
  });
  assert.equal(viaDefault.profiles[0]?.authPath, 'ig-login');
});

test('both _AUTH_PATH and _AUTH_MODE blank on a named profile leave the path to inference', () => {
  // `clean(canonical) ?? clean(alias)` with both sides blank is `undefined`,
  // not `''` promoted to a value: inference sees the app credentials and picks
  // fb-login. Guards the fold from ever treating a blank alias as "set".
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_BIZ_ACCESS_TOKEN: 'tok-biz',
    IG_PROFILE_BIZ_APP_ID: 'app',
    IG_PROFILE_BIZ_APP_SECRET: 'sec',
    IG_PROFILE_BIZ_AUTH_MODE: '',
    IG_PROFILE_BIZ_AUTH_PATH: ' ',
  });
  assert.equal(profiles.find((p) => p.name === 'biz')?.authPath, 'fb-login');
});

test('a profile whose first env key is the _AUTH_MODE alias keeps its env position', () => {
  // The alias spelling is folded in after the walk; the profile itself must be
  // registered on its FIRST key of either spelling, or an alias-led profile
  // would be reported after every canonical-led one — visible in the
  // "configured profiles:" list of the unknown-account refusal, and in any
  // caller that treats `profiles` as the operator's own order.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_BRAND_AUTH_MODE: 'ig-login',
    IG_PROFILE_BRAND2_ACCESS_TOKEN: 'tok-brand2',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
  });
  assert.deepEqual(
    profiles.map((p) => p.name),
    ['default', 'brand', 'brand2'],
  );
  assert.equal(profiles.find((p) => p.name === 'brand')?.authPath, 'ig-login');
});

test('an IG_AUTH_MODE from the client loses to the IG_AUTH_PATH login stores, as the guides say', () => {
  // dotenv merges the store under the client's env with `override: false`, which
  // is decided per VARIABLE. `login` and `refresh` write `IG_AUTH_PATH`, so a
  // client that pins the documented `IG_AUTH_MODE` does not override a stored
  // path: both variables end up set and the canonical spelling wins. The setup
  // guide used to promise that `IG_AUTH_MODE` overrides, which is only true
  // before the first `login`.
  const merged: Env = {
    IG_AUTH_MODE: 'fb-login', // from the MCP client
    IG_APP_ID: 'app-id-placeholder',
    IG_APP_SECRET: 'app-secret-placeholder',
    IG_ACCESS_TOKEN: 'tok-a', // from the store
    IG_AUTH_PATH: 'ig-login', // from the store, written by `login`
  };
  assert.equal(loadProfiles(merged).profiles[0]?.authPath, 'ig-login');
  assert.equal(
    loadProfiles({ ...merged, IG_AUTH_PATH: 'fb-login', IG_AUTH_MODE: 'ig-login' }).profiles[0]
      ?.authPath,
    'fb-login',
    'IG_AUTH_PATH is what overrides a stored path',
  );

  const doc = (name: string): string =>
    readFileSync(path.join(process.cwd(), 'docs', name), 'utf8').replace(/\s+/g, ' ');
  assert.ok(
    doc('setup-guide.md').includes(
      'an `IG_AUTH_MODE` passed by the MCP client no longer overrides it; ' +
        'set `IG_AUTH_PATH` instead',
    ),
    'docs/setup-guide.md tells the operator which variable overrides a stored path',
  );
  assert.ok(
    doc('auth.md').includes('once a store exists it is `IG_AUTH_PATH` that pins the path'),
    'docs/auth.md names IG_AUTH_PATH as the pin once a store exists',
  );
});

// --- Recorded token expiry (IG_TOKEN_EXPIRES_AT) ---------------------------

test('the recorded expiry reads back for the default and named profiles; 0 means never', () => {
  // Path A has no introspection endpoint, so this record is the ONLY source of
  // its expiry. Written by login/refresh and never read, it left token_status
  // and doctor reporting "unknown" for every Path A token.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_TOKEN_EXPIRES_AT: '1893456000',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
    IG_PROFILE_BRAND_TOKEN_EXPIRES_AT: '0',
  });
  assert.equal(profiles.find((p) => p.name === 'default')?.tokenExpiresAtSec, 1893456000);
  assert.equal(profiles.find((p) => p.name === 'brand')?.tokenExpiresAtSec, 0);
});

test('a malformed recorded expiry reads as unknown, never as a crash or a bogus date', () => {
  // A hand-edited .env is the realistic source of each value. Anything that is
  // not a whole number of epoch seconds for a representable instant is dropped
  // (the key is absent, so the profile shape is unchanged).
  for (const raw of [
    '2026-12-31T00:00:00.000Z',
    '-5',
    '1.5',
    '1e9',
    'Infinity',
    'NaN',
    '0x10',
    '99999999999999',
    '9999999999999',
    '',
    '   ',
  ]) {
    const { profiles } = loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_TOKEN_EXPIRES_AT: raw });
    assert.equal('tokenExpiresAtSec' in (profiles[0] ?? {}), false, JSON.stringify(raw));
  }
});

test('an expiry recorded in milliseconds reads as unknown, not as a date in year 58692', () => {
  // `Date.now()` pasted where `Math.floor(Date.now() / 1000)` belongs is the
  // likeliest hand-edit mistake, and it yields a 13-digit value that is still a
  // whole number inside the `Date` range. Read as seconds it named year 58692,
  // so `token_status` and `doctor` called the token valid for twenty million
  // days. The reader's ceiling is the last second of year 9999 (CC-AUTH-66).
  const fp = tokenFingerprint('tok');
  for (const raw of ['1790000000000', `1790000000000:${fp}`, '253402300800']) {
    const { profiles } = loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_TOKEN_EXPIRES_AT: raw });
    assert.equal('tokenExpiresAtSec' in (profiles[0] ?? {}), false, JSON.stringify(raw));
  }
  // The ceiling itself, the first second after the epoch, and a far-past
  // instant are all real records: a far-past one reads back, as expired.
  for (const [raw, sec] of [
    ['253402300799', 253_402_300_799],
    [`253402300799:${fp}`, 253_402_300_799],
    ['1', 1],
    ['86400', 86_400],
  ] as const) {
    const { profiles } = loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_TOKEN_EXPIRES_AT: raw });
    assert.equal(profiles[0]?.tokenExpiresAtSec, sec, raw);
  }
});

test('a named profile reads only its own expiry key, not a sibling field', () => {
  // The account id is digits too: were any profile key taken as the expiry, the
  // last one seen would be reported as a date.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_BRAND_TOKEN_EXPIRES_AT: '1893456000',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
    IG_PROFILE_BRAND_ACCOUNT_ID: '1784140000',
  });
  assert.equal(profiles.find((p) => p.name === 'brand')?.tokenExpiresAtSec, 1893456000);
});

test('an expiry recorded for a profile that has no other keys creates no profile', () => {
  // The record is metadata about a token; on its own it must not conjure a
  // tokenless profile that then fails validation at startup.
  const { profiles } = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_PROFILE_GHOST_TOKEN_EXPIRES_AT: '1893456000',
  });
  assert.deepEqual(
    profiles.map((p) => p.name),
    ['default'],
  );
});

// --- Token fingerprint: a record is bound to the token it was written for --

test('tokenFingerprint is 12 hex digits of the SHA-256 of the trimmed token, never the token', () => {
  // Pinned to the digest itself so a change of algorithm or length is a
  // deliberate, visible decision: every record already on disk carries it.
  assert.equal(tokenFingerprint('tok'), '1a7674eb4ee7');
  assert.equal(tokenFingerprint('  tok\n'), '1a7674eb4ee7');
  assert.notEqual(tokenFingerprint('tok2'), tokenFingerprint('tok'));
  assert.equal(tokenFingerprint('IGAA-secret-token').includes('IGAA'), false);
});

test('a fingerprinted record reads back only for the token it was written for (CC-AUTH-59)', () => {
  const record = `1893456000:${tokenFingerprint('tok-default')}`;
  const own = loadProfiles({ IG_ACCESS_TOKEN: 'tok-default', IG_TOKEN_EXPIRES_AT: record });
  assert.equal(own.profiles[0]?.tokenExpiresAtSec, 1893456000);

  // The token was replaced by hand in the same file: the record is someone
  // else's, so the expiry is unknown rather than the previous token's.
  const other = loadProfiles({ IG_ACCESS_TOKEN: 'tok-pasted', IG_TOKEN_EXPIRES_AT: record });
  assert.equal('tokenExpiresAtSec' in (other.profiles[0] ?? {}), false);

  // Named profiles bind to their own token, not the default one.
  const named = loadProfiles({
    IG_ACCESS_TOKEN: 'tok-default',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
    IG_PROFILE_BRAND_TOKEN_EXPIRES_AT: `0:${tokenFingerprint('tok-brand')}`,
  });
  assert.equal(named.profiles.find((p) => p.name === 'brand')?.tokenExpiresAtSec, 0);
});

test('a bare record set by hand still reads, flagged unverified; a malformed fingerprint reads as unknown (CC-AUTH-70)', () => {
  // `<seconds>` alone is what an operator writes by hand and what records
  // written before the fingerprint hold. It is accepted — the unknown-expiry
  // warning itself tells the operator to set one — but nothing ties it to the
  // token, so the profile says so and the diagnostics can report it as
  // unverified rather than as a fact about this token.
  const bare = loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_TOKEN_EXPIRES_AT: ' 1893456000 ' });
  assert.equal(bare.profiles[0]?.tokenExpiresAtSec, 1893456000);
  assert.equal(bare.profiles[0]?.tokenExpiryUnverified, true);
  const bareNever = loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_TOKEN_EXPIRES_AT: '0' });
  assert.equal(bareNever.profiles[0]?.tokenExpiresAtSec, 0);
  assert.equal(bareNever.profiles[0]?.tokenExpiryUnverified, true);
  // A fingerprinted record that matches is verified: no flag at all.
  const bound = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_TOKEN_EXPIRES_AT: `1893456000:${tokenFingerprint('tok')}`,
  });
  assert.equal(bound.profiles[0]?.tokenExpiresAtSec, 1893456000);
  assert.equal('tokenExpiryUnverified' in (bound.profiles[0] ?? {}), false);
  // A bare record that is not read carries no flag either: there is no expiry
  // for it to qualify.
  const unread = loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_TOKEN_EXPIRES_AT: '1790000000000' });
  assert.equal('tokenExpiresAtSec' in (unread.profiles[0] ?? {}), false);
  assert.equal('tokenExpiryUnverified' in (unread.profiles[0] ?? {}), false);
  // Named profiles are flagged per profile.
  const named = loadProfiles({
    IG_ACCESS_TOKEN: 'tok',
    IG_TOKEN_EXPIRES_AT: `1893456000:${tokenFingerprint('tok')}`,
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'tok-brand',
    IG_PROFILE_BRAND_TOKEN_EXPIRES_AT: '1893456000',
  });
  assert.equal(named.profiles.find((p) => p.name === 'brand')?.tokenExpiryUnverified, true);
  assert.equal(
    'tokenExpiryUnverified' in (named.profiles.find((p) => p.name === 'default') ?? {}),
    false,
  );
  const fp = tokenFingerprint('tok');
  for (const raw of [
    '1893456000:',
    `1893456000:${fp.toUpperCase()}`,
    `1893456000:${fp.slice(1)}`,
    `1893456000:${fp}0`,
    `1893456000;${fp}`,
    `:${fp}`,
    `x1893456000:${fp}`,
    `99999999999999:${fp}`,
  ]) {
    const { profiles } = loadProfiles({ IG_ACCESS_TOKEN: 'tok', IG_TOKEN_EXPIRES_AT: raw });
    assert.equal('tokenExpiresAtSec' in (profiles[0] ?? {}), false, JSON.stringify(raw));
  }
});

// --- strayExpiryKeys: a record from another source than its token ----------

test('strayExpiryKeys: a record from the same source as its token is kept', () => {
  const env: Env = { IG_ACCESS_TOKEN: 'TEST_TOKEN', IG_TOKEN_EXPIRES_AT: '2000000000' };
  assert.deepEqual(
    strayExpiryKeys(env, () => '/cfg/.env'),
    [],
  );
});

test('strayExpiryKeys: a record from another source than its token is reported', () => {
  // The client passes the token; the config-home file recorded the expiry of
  // the token `login` stored there — a different token.
  const env: Env = { IG_ACCESS_TOKEN: 'TEST_TOKEN', IG_TOKEN_EXPIRES_AT: '2000000000' };
  const sources: Record<string, string> = { IG_TOKEN_EXPIRES_AT: '/cfg/.env' };
  assert.deepEqual(
    strayExpiryKeys(env, (k) => sources[k] ?? 'environment'),
    ['IG_TOKEN_EXPIRES_AT'],
  );
});

test('strayExpiryKeys: named profiles pair by profile name, whatever the key casing', () => {
  const env: Env = {
    IG_PROFILE_Brand_ACCESS_TOKEN: 'TEST_TOKEN_B',
    IG_PROFILE_BRAND_TOKEN_EXPIRES_AT: '2000000000',
    IG_PROFILE_OTHER_ACCESS_TOKEN: 'TEST_TOKEN_O',
    IG_PROFILE_OTHER_TOKEN_EXPIRES_AT: '2000000000',
    // The default profile's token must not vouch for a named profile's record.
    IG_ACCESS_TOKEN: 'TEST_TOKEN',
  };
  const sources: Record<string, string> = {
    IG_PROFILE_Brand_ACCESS_TOKEN: 'a.env',
    IG_PROFILE_BRAND_TOKEN_EXPIRES_AT: 'b.env',
    IG_PROFILE_OTHER_ACCESS_TOKEN: 'a.env',
    IG_PROFILE_OTHER_TOKEN_EXPIRES_AT: 'a.env',
  };
  assert.deepEqual(
    strayExpiryKeys(env, (k) => sources[k] ?? 'environment'),
    ['IG_PROFILE_BRAND_TOKEN_EXPIRES_AT'],
  );
});

test('strayExpiryKeys: a record with no token, or an unset key, is left alone', () => {
  // With no token the profile fails (or is not conjured) on its own terms;
  // an `undefined` entry is an unset variable, not a value from any source.
  const env: Env = {
    IG_TOKEN_EXPIRES_AT: '2000000000',
    IG_PROFILE_GHOST_TOKEN_EXPIRES_AT: '2000000000',
    IG_PROFILE_X_ACCESS_TOKEN: undefined,
    IG_PROFILE_X_TOKEN_EXPIRES_AT: undefined,
    IG_APP_ID: '123',
    UNRELATED: 'value',
  };
  assert.deepEqual(
    strayExpiryKeys(env, (k) => k),
    [],
  );
});

test('unsetPlaceholderKeys names exactly the IG_* keys holding a whole MCPB template (CC-CFG-46)', () => {
  const env: Env = {
    IG_ACCOUNT_ID: '${user_config.IG_ACCOUNT_ID}',
    IG_WORK_APP_ID: '  ${user_config.work_app}  ',
    IG_ACCESS_TOKEN: 'EAAtoken',
    IG_CAPTION_NOTE: 'see ${user_config.IG_X} here',
    IG_EMPTY_NAME: '${user_config.}',
    IG_OTHER_TEMPLATE: '${HOME}',
    IG_TAIL: '${user_config.IG_X}x',
    IG_HEAD: 'x${user_config.IG_X}',
    IG_OTHER_NAMESPACE: '${env.IG_X}',
    IG_UNSET: undefined,
    OTHER_ACCOUNT: '${user_config.OTHER_ACCOUNT}',
  };
  assert.deepEqual(unsetPlaceholderKeys(env), ['IG_ACCOUNT_ID', 'IG_WORK_APP_ID']);
  assert.deepEqual(unsetPlaceholderKeys({}), []);
});
