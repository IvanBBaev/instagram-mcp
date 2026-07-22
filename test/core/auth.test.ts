import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAuthProvider } from '../../src/core/auth.js';
import { isInstagramError } from '../../src/core/types.js';
import type { ResolvedProfile } from '../../src/core/types.js';

const IG_HOST = 'graph.instagram.com' as const;
const FB_HOST = 'graph.facebook.com' as const;

/** Known (token, secret) pair with a golden HMAC-SHA256 hex digest. */
const KNOWN_TOKEN = 'EAAtESTtoken0123456789';
const KNOWN_SECRET = 's3cr3t-app-secret';
const GOLDEN_PROOF = '43cfff5530206654c5c768125fd2088b48048b671ea715767ea1f9922a12b288';

function igProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return { name: 'default', authPath: 'ig-login', accessToken: 'IGQtoken', ...overrides };
}

function fbProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: 'default',
    authPath: 'fb-login',
    accessToken: KNOWN_TOKEN,
    appSecret: KNOWN_SECRET,
    ...overrides,
  };
}

test('ig-login: defaultHost is graph.instagram.com and path is ig-login', () => {
  const provider = createAuthProvider(igProfile());
  assert.equal(provider.path, 'ig-login');
  assert.equal(provider.defaultHost, IG_HOST);
});

test('ig-login: authParams returns only access_token, never appsecret_proof', async () => {
  const provider = createAuthProvider(igProfile({ accessToken: 'IGQ_abc' }));
  const params = await provider.authParams(IG_HOST);
  assert.deepEqual(params, { access_token: 'IGQ_abc' });
  assert.ok(!('appsecret_proof' in params));
});

test('ig-login: still omits appsecret_proof even if addressed to graph.facebook.com', async () => {
  const provider = createAuthProvider(igProfile({ accessToken: 'IGQ_abc' }));
  const params = await provider.authParams(FB_HOST);
  assert.deepEqual(params, { access_token: 'IGQ_abc' });
});

test('fb-login: defaultHost is graph.facebook.com and path is fb-login', () => {
  const provider = createAuthProvider(fbProfile());
  assert.equal(provider.path, 'fb-login');
  assert.equal(provider.defaultHost, FB_HOST);
});

test('fb-login: appsecret_proof matches an independently computed HMAC-SHA256 digest', async () => {
  const provider = createAuthProvider(fbProfile());
  const params = await provider.authParams(FB_HOST);

  const independent = createHmac('sha256', KNOWN_SECRET).update(KNOWN_TOKEN).digest('hex');
  const proof = params.appsecret_proof;
  assert.ok(proof, 'appsecret_proof must be present on graph.facebook.com');
  assert.equal(params.access_token, KNOWN_TOKEN);
  assert.equal(proof, independent);
  // Golden literal — proves the digest against a value computed outside this run.
  assert.equal(proof, GOLDEN_PROOF);
  assert.match(proof, /^[0-9a-f]{64}$/);
});

test('fb-login: appsecret_proof is included only for graph.facebook.com targets', async () => {
  const provider = createAuthProvider(fbProfile());

  const fbParams = await provider.authParams(FB_HOST);
  assert.ok('appsecret_proof' in fbParams);

  // graph.instagram.com does not support appsecret_proof (docs/auth.md §1).
  const igParams = await provider.authParams(IG_HOST);
  assert.deepEqual(igParams, { access_token: KNOWN_TOKEN });
  assert.ok(!('appsecret_proof' in igParams));
});

test('fb-login: throws a validation InstagramError when appSecret is missing', () => {
  assert.throws(
    () => createAuthProvider(fbProfile({ appSecret: undefined })),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(err.kind, 'validation');
      return true;
    },
  );
});

test('fb-login: throws a validation InstagramError when appSecret is empty', () => {
  assert.throws(
    () => createAuthProvider(fbProfile({ appSecret: '' })),
    (err: unknown) => isInstagramError(err) && err.kind === 'validation',
  );
});
