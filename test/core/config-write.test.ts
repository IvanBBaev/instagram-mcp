/**
 * Unit tests for credential persistence (src/core/config-write.ts).
 *
 * Every test writes to a throwaway temp directory via the `configDir` injection
 * point, so the real config home is never touched. The central guarantee is a
 * round-trip: what {@link writeCredentials} writes must parse back through the
 * same dotenv + {@link loadProfiles} scheme `core/config.ts` reads, for both the
 * default (`IG_*`) and named (`IG_PROFILE_<NAME>_*`) key layouts. Secret safety
 * (no token to stdout, chmod 0600 on POSIX) and the comment-preserving, atomic
 * rewrite are asserted directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

import { writeCredentials } from '../../src/core/config-write.js';
import { loadProfiles } from '../../src/core/config.js';
import { isInstagramError } from '../../src/core/types.js';

const SERVER_DIR = 'instagram-mcp-ai';

/** A distinctive, token-shaped secret so redaction assertions are meaningful. */
const LONG_TOKEN = 'EAAlongLIVEDtokenVALUE0123456789abcXYZsecretZZ';
const APP_SECRET = 'app-secret-value-0123456789abcdef';

/** Fresh temp config-home base for one test. */
async function tempConfigDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'igmcp-cfgwrite-'));
}

/** Parse a written env file back into a plain env map (as dotenv/loadProfiles see it). */
async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
  return dotenv.parse(await readFile(filePath, 'utf8'));
}

// --- Round-trip: default profile -------------------------------------------

test('default profile round-trips through dotenv + loadProfiles (fb-login)', async () => {
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    {
      accessToken: LONG_TOKEN,
      authPath: 'fb-login',
      accountId: '178414',
      appId: '55500',
      appSecret: APP_SECRET,
    },
    { configDir },
  );

  assert.equal(res.path, path.join(configDir, SERVER_DIR, '.env'));
  // Keys are the bare IG_* scheme for the default profile.
  assert.ok(res.keys.includes('IG_ACCESS_TOKEN'));
  assert.ok(res.keys.includes('IG_AUTH_PATH'));
  assert.ok(res.keys.includes('IG_APP_ID'));
  assert.ok(res.keys.includes('IG_APP_SECRET'));

  const env = await parseEnvFile(res.path);
  const { profiles } = loadProfiles(env);
  assert.deepEqual(profiles[0], {
    name: 'default',
    authPath: 'fb-login',
    accessToken: LONG_TOKEN,
    accountId: '178414',
    appId: '55500',
    appSecret: APP_SECRET,
  });
});

test('default profile: token only round-trips as ig-login', async () => {
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  const { profiles } = loadProfiles(await parseEnvFile(res.path));
  assert.equal(profiles[0]?.authPath, 'ig-login');
  assert.equal(profiles[0]?.accessToken, LONG_TOKEN);
});

// --- Round-trip: named profile ---------------------------------------------

test('named profile uses the IG_PROFILE_<NAME>_* scheme and round-trips', async () => {
  const configDir = await tempConfigDir();
  // A default profile must exist for loadProfiles to succeed — write it first,
  // then the named one into the SAME file (append/merge path).
  await writeCredentials(
    'default',
    { accessToken: 'default-tok', authPath: 'ig-login' },
    { configDir },
  );
  const res = await writeCredentials(
    'Brand',
    {
      accessToken: LONG_TOKEN,
      authPath: 'fb-login',
      appId: 'app-brand',
      appSecret: APP_SECRET,
    },
    { configDir },
  );

  assert.ok(res.keys.includes('IG_PROFILE_BRAND_ACCESS_TOKEN'), 'name is uppercased in the key');
  const { profiles } = loadProfiles(await parseEnvFile(res.path));
  const brand = profiles.find((p) => p.name === 'brand'); // stored lowercased
  assert.ok(brand, 'named profile resolves');
  assert.equal(brand.authPath, 'fb-login');
  assert.equal(brand.accessToken, LONG_TOKEN);
  assert.equal(brand.appId, 'app-brand');
});

// --- expiresAtSec metadata is ignored by config.ts -------------------------

test('expiresAtSec is persisted as metadata and does NOT perturb the round-trip', async () => {
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', expiresAtSec: 1893456000 },
    { configDir },
  );
  const env = await parseEnvFile(res.path);
  // The metadata key is present in the file...
  assert.equal(env.IG_TOKEN_EXPIRES_AT, '1893456000');
  assert.ok(res.keys.includes('IG_TOKEN_EXPIRES_AT'));
  // ...but config.ts ignores the unknown suffix, so the profile is unchanged.
  const { profiles } = loadProfiles(env);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.accessToken, LONG_TOKEN);
});

test('expiresAtSec = 0 (never expires) is written verbatim', async () => {
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', expiresAtSec: 0 },
    { configDir },
  );
  const env = await parseEnvFile(res.path);
  assert.equal(env.IG_TOKEN_EXPIRES_AT, '0');
});

// --- Comment-preserving, in-place, atomic rewrite --------------------------

test('an existing file keeps its comments and unrelated keys; values update in place', async () => {
  const configDir = await tempConfigDir();
  const filePath = path.join(configDir, SERVER_DIR, '.env');
  // Seed a file with a comment, an unrelated key, and a stale token.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    ['# hand-written header', 'IG_TRANSPORT=http', 'IG_ACCESS_TOKEN=stale-token', ''].join('\n'),
    'utf8',
  );

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );

  const text = await readFile(filePath, 'utf8');
  assert.ok(text.includes('# hand-written header'), 'comment preserved');
  assert.ok(text.includes('IG_TRANSPORT=http'), 'unrelated key preserved');
  assert.ok(!text.includes('stale-token'), 'stale value replaced');
  assert.ok(text.includes(LONG_TOKEN), 'new value written');
  // The token key appears exactly once (updated in place, not duplicated).
  const occurrences = text.split('\n').filter((l) => l.startsWith('IG_ACCESS_TOKEN=')).length;
  assert.equal(occurrences, 1);
});

test('a second write updates only the touched keys and leaves the rest', async () => {
  const configDir = await tempConfigDir();
  await writeCredentials(
    'default',
    { accessToken: 'first', authPath: 'fb-login', appId: 'app', appSecret: APP_SECRET },
    { configDir },
  );
  const res = await writeCredentials(
    'default',
    { accessToken: 'second', authPath: 'fb-login', appId: 'app', appSecret: APP_SECRET },
    { configDir },
  );
  const env = await parseEnvFile(res.path);
  assert.equal(env.IG_ACCESS_TOKEN, 'second');
  assert.equal(env.IG_APP_ID, 'app');
});

// --- Value formatting round-trips ------------------------------------------

test('a value with spaces/quotes is escaped and parses back verbatim', async () => {
  const configDir = await tempConfigDir();
  const tricky = 'has "quotes" and spaces = signs';
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: tricky },
    { configDir },
  );
  const env = await parseEnvFile(res.path);
  assert.equal(env.IG_ACCOUNT_ID, tricky);
});

// --- Secret safety ---------------------------------------------------------

test('writeCredentials never emits token characters to stdout', async () => {
  const configDir = await tempConfigDir();
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // Capture anything the call might print.
  (process.stdout as { write: unknown }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'fb-login', appId: 'a', appSecret: APP_SECRET },
      { configDir },
    );
  } finally {
    (process.stdout as { write: unknown }).write = original;
  }
  const printed = chunks.join('');
  assert.ok(!printed.includes(LONG_TOKEN), 'no token on stdout');
  assert.ok(!printed.includes(APP_SECRET), 'no app secret on stdout');
});

test('the env file is chmod 0600 on POSIX', async () => {
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  if (process.platform !== 'win32') {
    const mode = (await stat(res.path)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got 0o${mode.toString(8)}`);
  }
});

// --- Validation ------------------------------------------------------------

test('a blank access token is rejected with a validation error', async () => {
  const configDir = await tempConfigDir();
  await assert.rejects(
    () => writeCredentials('default', { accessToken: '   ', authPath: 'ig-login' }, { configDir }),
    (err: unknown) => isInstagramError(err) && err.kind === 'validation',
  );
});
