/**
 * The env-file credential provider and the resolving auth provider
 * (core/credentials.ts, architecture §13). Every store targets a throwaway
 * temp config home via `write.configDir`, never the real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { loadProfiles, type Env } from '../../src/core/config.js';
import { envFileCredentialProvider, resolvingAuthProvider } from '../../src/core/credentials.js';
import { createRedactor } from '../../src/core/redact.js';
import { isInstagramError } from '../../src/core/types.js';
import type { ResolvedProfile } from '../../src/core/types.js';
import { makeTempConfigHome } from '../helpers/config-home.js';
import { memoryCredentialProvider, memorySecretRegistry } from '../helpers/ports.js';

const TOKEN = 'tok-default-0001';
const SHOP_TOKEN = 'tok-shop-0000002';
const SHOP_SECRET = 'shop-app-secret-01';

const ENV: Env = {
  IG_ACCESS_TOKEN: TOKEN,
  IG_PROFILE_SHOP_ACCESS_TOKEN: SHOP_TOKEN,
  IG_PROFILE_SHOP_APP_ID: '1234',
  IG_PROFILE_SHOP_APP_SECRET: SHOP_SECRET,
  IG_PROFILE_SHOP_ACCOUNT_ID: '17841400000000001',
};

/** A provider over `env` writing into a fresh temp config home. */
async function provider(env: Env = ENV) {
  const configDir = await makeTempConfigHome('igmcp-creds-');
  const secrets = memorySecretRegistry();
  const creds = envFileCredentialProvider({ env, secrets, write: { configDir } });
  return { creds, secrets };
}

/** Reject with an InstagramError of kind `validation` carrying `message`. */
async function rejectsValidation(p: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(
    p,
    (err: unknown) => isInstagramError(err) && err.kind === 'validation' && err.message === message,
  );
}

// --- load / resolve ----------------------------------------------------------

test('load returns what loadProfiles parses and registers every token and app secret', async () => {
  const { creds, secrets } = await provider();
  assert.equal(creds.kind, 'env-file');
  const set = await creds.load();
  assert.deepEqual(set, loadProfiles(ENV));
  assert.deepEqual([...secrets.secrets].sort(), [SHOP_SECRET, TOKEN, SHOP_TOKEN].sort());
});

test('load keeps the loadProfiles error message unchanged', async () => {
  const { creds } = await provider({});
  await rejectsValidation(
    creds.load(),
    'No default profile configured; set IG_ACCESS_TOKEN (the default account token).',
  );
});

test('resolve before load reads lazily; blank or absent name is the active default', async () => {
  const { creds, secrets } = await provider({ ...ENV, IG_ACTIVE_PROFILE: 'Shop' });
  assert.equal((await creds.resolve()).name, 'shop');
  assert.ok(secrets.secrets.has(SHOP_TOKEN));
  assert.equal((await creds.resolve('  ')).name, 'shop');
  assert.equal((await creds.resolve(' DEFAULT ')).accessToken, TOKEN);
});

test('resolve rejects an unknown name with the resolveProfile message', async () => {
  const { creds } = await provider();
  await rejectsValidation(
    creds.resolve('nope'),
    "Unknown account profile 'nope'; configured profiles: default, shop.",
  );
});

test('resolve returns a copy the caller cannot use to alter the provider', async () => {
  const { creds } = await provider();
  const got = await creds.resolve('shop');
  got.accessToken = 'mutated-token-x';
  assert.equal((await creds.resolve('shop')).accessToken, SHOP_TOKEN);
});

test('the default options read process.env and register in the process registry', async () => {
  const saved = process.env.IG_ACCESS_TOKEN;
  process.env.IG_ACCESS_TOKEN = 'tok-process-env-77';
  try {
    const profile = await envFileCredentialProvider().resolve();
    assert.equal(profile.accessToken, 'tok-process-env-77');
    assert.equal(createRedactor()('x tok-process-env-77 y'), 'x [REDACTED] y');
  } finally {
    if (saved === undefined) delete process.env.IG_ACCESS_TOKEN;
    else process.env.IG_ACCESS_TOKEN = saved;
  }
});

// --- store -------------------------------------------------------------------

test('store keeps omitted fields, writes the env file and is visible to resolve', async () => {
  const { creds, secrets } = await provider();
  const receipt = await creds.store(' SHOP ', {
    accessToken: ' tok-shop-rotated-3 ',
    expiresAtSec: 2_000_000_000,
  });
  assert.ok(secrets.secrets.has(' tok-shop-rotated-3 '));
  assert.match(receipt.location, /instagram-mcp-ai[\\/]\.env$/);
  assert.ok(receipt.keys.includes('IG_PROFILE_SHOP_ACCESS_TOKEN'));
  // Names only: no secret value anywhere in the receipt.
  const json = JSON.stringify(receipt);
  for (const secret of ['tok-shop-rotated-3', SHOP_SECRET]) assert.ok(!json.includes(secret));

  const expected: ResolvedProfile = {
    name: 'shop',
    authPath: 'fb-login',
    accessToken: 'tok-shop-rotated-3',
    accountId: '17841400000000001',
    appId: '1234',
    appSecret: SHOP_SECRET,
    tokenExpiresAtSec: 2_000_000_000,
  };
  assert.deepEqual(await creds.resolve('shop'), expected);
  // The file reads back to the same profile.
  const file = parse(await readFile(receipt.location, 'utf8'));
  assert.deepEqual(
    loadProfiles({ IG_ACCESS_TOKEN: TOKEN, ...file }).profiles.find((p) => p.name === 'shop'),
    expected,
  );
});

test('store replaces fields it is given and clears the expiry when it is omitted', async () => {
  const { creds, secrets } = await provider({
    IG_ACCESS_TOKEN: TOKEN,
    IG_TOKEN_EXPIRES_AT: '1900000000',
  });
  assert.equal((await creds.resolve()).tokenExpiresAtSec, 1_900_000_000);
  await creds.store('', {
    accessToken: 'tok-default-rotated',
    authPath: 'fb-login',
    accountId: '17841400000000009',
    appId: '5678',
    appSecret: 'new-app-secret-99',
  });
  assert.ok(secrets.secrets.has('new-app-secret-99'));
  assert.deepEqual(await creds.resolve(), {
    name: 'default',
    authPath: 'fb-login',
    accessToken: 'tok-default-rotated',
    accountId: '17841400000000009',
    appId: '5678',
    appSecret: 'new-app-secret-99',
  });
});

test('store drops an expiry the env file cannot record', async () => {
  const { creds } = await provider();
  await creds.store('default', { accessToken: 'tok-default-rotated', expiresAtSec: -5 });
  assert.equal((await creds.resolve()).tokenExpiresAtSec, undefined);
});

test('store adds a new profile when it names its auth path', async () => {
  const { creds } = await provider();
  await creds.store('brand', { accessToken: 'tok-brand-new-0001', authPath: 'ig-login' });
  assert.deepEqual(await creds.resolve('brand'), {
    name: 'brand',
    authPath: 'ig-login',
    accessToken: 'tok-brand-new-0001',
    accountId: undefined,
    appId: undefined,
    appSecret: undefined,
  });
});

test('store refuses a new profile without an auth path, after registering the token', async () => {
  const { creds, secrets } = await provider();
  await rejectsValidation(
    creds.store('Brand', { accessToken: 'tok-brand-new-0001' }),
    "Profile 'brand' is new; its auth path is required.",
  );
  assert.ok(secrets.secrets.has('tok-brand-new-0001'));
  await rejectsValidation(
    creds.resolve('brand'),
    "Unknown account profile 'brand'; configured profiles: default, shop.",
  );
});

test('store refuses a blank token with the writeCredentials message', async () => {
  const { creds } = await provider();
  await rejectsValidation(
    creds.store('default', { accessToken: '   ' }),
    'writeCredentials: an access token is required.',
  );
});

test('a reload keeps stored tokens and stored new profiles over the stale env', async () => {
  const { creds } = await provider();
  await creds.store('shop', { accessToken: 'tok-shop-rotated-3' });
  await creds.store('brand', { accessToken: 'tok-brand-new-0001', authPath: 'ig-login' });
  const { profiles } = await creds.load();
  assert.deepEqual(
    profiles.map((p) => [p.name, p.accessToken]),
    [
      ['default', TOKEN],
      ['shop', 'tok-shop-rotated-3'],
      ['brand', 'tok-brand-new-0001'],
    ],
  );
});

// --- resolvingAuthProvider ---------------------------------------------------

const igProfile: ResolvedProfile = {
  name: 'default',
  authPath: 'ig-login',
  accessToken: 'tok-before-rotate',
};
const clock = { now: () => 1_700_000_000_000 };

test('resolvingAuthProvider sends the token current at each attempt', async () => {
  const creds = memoryCredentialProvider({ profiles: [igProfile], defaultName: 'default' });
  const auth = resolvingAuthProvider(creds, igProfile, clock);
  assert.equal(auth.path, 'ig-login');
  assert.equal(auth.defaultHost, 'graph.instagram.com');
  assert.deepEqual(await auth.authParams('graph.instagram.com'), {
    access_token: 'tok-before-rotate',
  });
  await creds.store('default', { accessToken: 'tok-after-rotate' });
  assert.deepEqual(await auth.authParams('graph.instagram.com'), {
    access_token: 'tok-after-rotate',
  });
});

test('resolvingAuthProvider keeps the eager construction-time refusal', () => {
  const creds = memoryCredentialProvider({ profiles: [], defaultName: 'default' });
  assert.throws(
    () =>
      resolvingAuthProvider(
        creds,
        { name: 'default', authPath: 'fb-login', accessToken: 'tok-fb-no-secret', appId: '1' },
        clock,
      ),
    (err: unknown) => isInstagramError(err) && err.kind === 'validation',
  );
});
