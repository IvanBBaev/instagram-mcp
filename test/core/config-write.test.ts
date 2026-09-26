/**
 * Unit tests for credential persistence (src/core/config-write.ts).
 *
 * Every test writes to a throwaway temp directory — via the `configDir`
 * injection point, or (for the resolution tests) via an `env` map built by
 * `test/helpers/config-home.ts`, which sets the variable the RUNNING platform
 * reads. The real config home is never touched. The central guarantee is a
 * round-trip: what {@link writeCredentials} writes must parse back through the
 * same dotenv + {@link loadProfiles} scheme `core/config.ts` reads, for both the
 * default (`IG_*`) and named (`IG_PROFILE_<NAME>_*`) key layouts. Secret safety
 * (no token to stdout, chmod 0600 on POSIX) and the comment-preserving, atomic
 * rewrite are asserted directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import dotenv from 'dotenv';

import { namedEnvFile, resolveConfigHome, writeCredentials } from '../../src/core/config-write.js';
import { loadProfiles, tokenFingerprint } from '../../src/core/config.js';
import { isInstagramError } from '../../src/core/types.js';
import type { InstagramError } from '../../src/core/types.js';
import {
  SERVER_DIR,
  configHomeEnv,
  envFileIn,
  makeTempConfigHome,
} from '../helpers/config-home.js';

/** A distinctive, token-shaped secret so redaction assertions are meaningful. */
const LONG_TOKEN = 'EAAlongLIVEDtokenVALUE0123456789abcXYZsecretZZ';
const APP_SECRET = 'app-secret-value-0123456789abcdef';

/** The writer's lock is the store path plus this suffix. */
const LOCK_SUFFIX = '.lock';

/**
 * A token padded to a few hundred KiB.
 *
 * Only the mid-write sampling tests use it: the padding makes the single
 * `writeFile` span many event-loop turns, so the sampler below is guaranteed
 * several looks at the temp file instead of racing a sub-millisecond write.
 */
const PADDED_TOKEN = `${LONG_TOKEN}${'x'.repeat(256 * 1024)}`;

/**
 * Sample the credential store on every event-loop turn while `run()` is in
 * flight, and report every mode each file name was seen at.
 *
 * `writeCredentials` awaits each fs step, so control returns to the loop
 * between them and a `setImmediate` chain lands inside every window — including
 * the one where the temp sibling exists, fully populated with the live token,
 * which no assertion on the finished file can reach.
 */
async function sampleStoreDuring(
  storeDir: string,
  run: () => Promise<void>,
): Promise<Map<string, Set<number>>> {
  const seen = new Map<string, Set<number>>();
  let sampling = true;
  const sample = (): void => {
    for (const name of readdirSync(storeDir)) {
      // `throwIfNoEntry: false` covers the file vanishing under us (the rename).
      const stats = statSync(path.join(storeDir, name), { throwIfNoEntry: false });
      const modes = seen.get(name) ?? new Set<number>();
      seen.set(name, modes);
      if (stats !== undefined) modes.add(stats.mode & 0o777);
    }
    if (sampling) setImmediate(sample);
  };
  setImmediate(sample);
  try {
    await run();
  } finally {
    sampling = false;
  }
  return seen;
}

/** Fresh temp config-home base for one test. */
async function tempConfigDir(): Promise<string> {
  return makeTempConfigHome('igmcp-cfgwrite-');
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
  // Keys are the bare IG_* scheme for the default profile, and the exact SET and
  // ORDER are pinned. The set matters because an extra key here means a value the
  // caller never supplied was written (clobbering whatever was on disk); the order
  // matters because these keys are appended to a fresh file in this order and the
  // access token — the one field that is always present — must lead the block.
  assert.deepEqual(res.keys, [
    'IG_ACCESS_TOKEN',
    'IG_AUTH_PATH',
    'IG_ACCOUNT_ID',
    'IG_APP_ID',
    'IG_APP_SECRET',
  ]);

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

// --- expiresAtSec metadata round-trips into the profile --------------------

test('expiresAtSec is persisted and reads back as the profile expiry', async () => {
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', expiresAtSec: 1893456000 },
    { configDir },
  );
  const env = await parseEnvFile(res.path);
  // The metadata key is present in the file, bound to the token it describes...
  assert.equal(env.IG_TOKEN_EXPIRES_AT, `1893456000:${tokenFingerprint(LONG_TOKEN)}`);
  assert.ok(res.keys.includes('IG_TOKEN_EXPIRES_AT'));
  // ...and config.ts reads it back, without creating a second profile.
  const { profiles } = loadProfiles(env);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.accessToken, LONG_TOKEN);
  assert.equal(profiles[0]?.tokenExpiresAtSec, 1893456000);
});

test('expiresAtSec = 0 (never expires) is written verbatim', async () => {
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', expiresAtSec: 0 },
    { configDir },
  );
  const env = await parseEnvFile(res.path);
  assert.equal(env.IG_TOKEN_EXPIRES_AT, `0:${tokenFingerprint(LONG_TOKEN)}`);
});

test("a write without expiresAtSec removes the old expiry, and only that profile's", async () => {
  // The expiry is read back into token_status and doctor, so a record left
  // behind by the previous token would be reported as the NEW token's expiry.
  // A refresh whose response carried no `expires_in` must leave it unknown.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    [
      'IG_ACCESS_TOKEN=stale-token',
      'IG_TOKEN_EXPIRES_AT=1700000000',
      'IG_PROFILE_BRAND_ACCESS_TOKEN=brand-token',
      'IG_PROFILE_BRAND_TOKEN_EXPIRES_AT=1893456000',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );

  const env = await parseEnvFile(filePath);
  assert.equal(env.IG_TOKEN_EXPIRES_AT, undefined, 'stale expiry removed');
  assert.equal(env.IG_PROFILE_BRAND_TOKEN_EXPIRES_AT, '1893456000', 'other profile untouched');
  const { profiles } = loadProfiles(env);
  assert.equal(profiles.find((p) => p.name === 'default')?.tokenExpiresAtSec, undefined);
});

test('an expiresAtSec the reader would refuse is not written, and the old record is removed', async () => {
  // The writer and the reader share one definition of a recordable expiry: 0,
  // or a whole second from 1 to the last second of year 9999. A value outside
  // it used to be written as a signed, fractional or millisecond record that
  // the next start either dropped or read as a date in year 58692. It is now
  // treated like no lifetime, so the stale record goes too (CC-AUTH-65).
  for (const expiresAtSec of [-5, 1.5, 1_790_000_000_000, 253_402_300_800, Number.NaN]) {
    const configDir = await tempConfigDir();
    const filePath = envFileIn(configDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'IG_TOKEN_EXPIRES_AT=1700000000\n', 'utf8');

    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login', expiresAtSec },
      { configDir },
    );

    const env = await parseEnvFile(filePath);
    assert.equal(env.IG_TOKEN_EXPIRES_AT, undefined, `expiresAtSec ${expiresAtSec}`);
    assert.equal(res.keys.includes('IG_TOKEN_EXPIRES_AT'), false, `expiresAtSec ${expiresAtSec}`);
  }
  // The ceiling itself is still written.
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', expiresAtSec: 253_402_300_799 },
    { configDir },
  );
  const env = await parseEnvFile(res.path);
  assert.equal(env.IG_TOKEN_EXPIRES_AT, `253402300799:${tokenFingerprint(LONG_TOKEN)}`);
});

test('a write with expiresAtSec updates the recorded expiry in place', async () => {
  // Only a write WITHOUT a lifetime removes the record; one with a lifetime
  // rewrites the existing line where it stands, like every other key.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    ['IG_TOKEN_EXPIRES_AT=1700000000', '# trailing comment', ''].join('\n'),
    'utf8',
  );

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', expiresAtSec: 1893456000 },
    { configDir },
  );

  const lines = (await readFile(filePath, 'utf8')).split('\n');
  assert.equal(lines[0], `IG_TOKEN_EXPIRES_AT=1893456000:${tokenFingerprint(LONG_TOKEN)}`);
  assert.equal(lines[1], '# trailing comment');
});

test('a token replaced by hand after a write does not inherit the recorded expiry (CC-AUTH-59)', async () => {
  // The record `login`/`refresh` write is bound to the token they stored. An
  // operator who pastes a new token over the old one in the same file leaves
  // the old record behind, which used to be reported as the new token's expiry.
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', expiresAtSec: 1893456000 },
    { configDir },
  );
  const env = await parseEnvFile(res.path);

  const pasted = loadProfiles({ ...env, IG_ACCESS_TOKEN: 'IGAA-pasted-by-hand' });
  assert.equal('tokenExpiresAtSec' in (pasted.profiles[0] ?? {}), false);
  // The token the record was written for still reads it back.
  assert.equal(loadProfiles(env).profiles[0]?.tokenExpiresAtSec, 1893456000);
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

test('an `export KEY=` assignment is recognised, so no stale secret survives the rewrite', async () => {
  // `export IG_ACCESS_TOKEN=...` is how a hand-written env file gets used with
  // `source`, so it is a shape real operators have on disk. If the merge does not
  // recognise it, the revoked token STAYS in the file and a second assignment is
  // appended below it — the file now carries a secret nobody thinks is there, and
  // whether the old or new one wins depends on the reader's last-key-wins rule.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    ['# hand-written', 'export IG_ACCESS_TOKEN=stale-token', '  export IG_APP_ID=old-app', ''].join(
      '\n',
    ),
    'utf8',
  );

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'fb-login', appId: '55500', appSecret: APP_SECRET },
    { configDir },
  );

  const text = await readFile(filePath, 'utf8');
  assert.equal(text.includes('stale-token'), false, 'the revoked token is gone from disk');
  assert.equal(text.includes('old-app'), false, 'the stale app id is gone from disk');
  const assignments = text.split('\n').filter((l) => /IG_ACCESS_TOKEN\s*=/.test(l));
  assert.equal(
    assignments.length,
    1,
    `expected one token assignment, got ${assignments.join(' | ')}`,
  );
});

test('`export` is the shell keyword only when whitespace follows it', async () => {
  // The optional `export ` prefix is stripped so `export IG_ACCESS_TOKEN=` is
  // recognised as OUR assignment. The whitespace is what makes it a keyword:
  // without it, `exportIG_ACCESS_TOKEN` is simply a DIFFERENT variable name.
  // Treating it as ours renames the operator's variable and overwrites its value
  // in place — silent data loss in a file this module promises to preserve, and
  // the kind of near-miss name a shell profile genuinely produces.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'exportIG_ACCESS_TOKEN=keep-me\n', 'utf8');

  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  const text = await readFile(res.path, 'utf8');
  assert.ok(
    text.split('\n').includes('exportIG_ACCESS_TOKEN=keep-me'),
    `the unrelated variable was rewritten:\n${text}`,
  );
  const env = await parseEnvFile(res.path);
  assert.equal(env.exportIG_ACCESS_TOKEN, 'keep-me');
  assert.equal(env.IG_ACCESS_TOKEN, LONG_TOKEN, 'our own key is still appended');
});

test('a sourced env file keeps its `export` keyword across a credential rewrite', async () => {
  // `assignmentOn` goes out of its way to RECOGNISE `export IG_ACCESS_TOKEN=` — the two
  // tests above both depend on it. Recognising the shape and then not writing it
  // back is the worst of the two outcomes: the merge finds the assignment, replaces
  // the whole LINE rather than the value, and silently downgrades an exported
  // variable to a local one. The operator's `source ~/.config/instagram-mcp-ai/.env`
  // then sets nothing in any child process, while `cat` shows a perfectly fresh
  // token — the file looks repaired and the server starts with no credential.
  // Leading indentation rides along for the same reason: what this module replaces
  // is a VALUE, and every other byte of the line is the operator's.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    [
      '# sourced from .zprofile',
      'export IG_ACCESS_TOKEN=stale-token',
      '  export IG_APP_ID=old-app',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'fb-login', appId: '55500', appSecret: APP_SECRET },
    { configDir },
  );

  const lines = (await readFile(filePath, 'utf8')).split('\n');
  assert.deepEqual(
    lines.filter((l) => /IG_ACCESS_TOKEN|IG_APP_ID/.test(l)),
    [`export IG_ACCESS_TOKEN=${LONG_TOKEN}`, '  export IG_APP_ID=55500'],
    'the merge rewrote the whole line instead of the value',
  );
});

test('a commented-out example line is not mistaken for the assignment to update', async () => {
  // Sample env files ship with the real keys commented out — `# IG_ACCESS_TOKEN=…`
  // is the single most common line in one. Only a line that STARTS with the key is
  // an assignment: matching the key anywhere on the line rewrites the comment into
  // a live assignment (silently un-commenting a placeholder) AND consumes the
  // update, so the genuine line below keeps the revoked token. The file then holds
  // two assignments for the same key and the operator's dead credential is still
  // on disk.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    [
      '# example: IG_ACCESS_TOKEN=EXAMPLE-PLACEHOLDER',
      '#   IG_APP_ID=123 (uncomment for fb-login)',
      'IG_ACCESS_TOKEN=stale-token',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );

  const text = await readFile(filePath, 'utf8');
  assert.equal(text.includes('stale-token'), false, 'the revoked token is gone from disk');
  assert.ok(
    text.includes('# example: IG_ACCESS_TOKEN=EXAMPLE-PLACEHOLDER'),
    'the commented example is preserved verbatim',
  );
  const live = text.split('\n').filter((l) => /^\s*IG_ACCESS_TOKEN\s*=/.test(l));
  assert.equal(live.length, 1, `expected one live token assignment, got ${live.join(' | ')}`);
  const env = await parseEnvFile(filePath);
  assert.equal(env.IG_ACCESS_TOKEN, LONG_TOKEN);
  assert.equal(env.IG_APP_ID, undefined, 'a commented key stays commented');
});

test('a newline inside a stored value cannot forge an assignment on a later rewrite', async () => {
  // Values reach this module from Graph responses and CLI flags, so a newline is
  // attacker-influenced input. Escaping it keeps the value on ONE physical line.
  // Left literal, the value looks like a multi-line quoted string to dotenv today
  // — but the NEXT rewrite splits the file on newlines, replaces the first half in
  // place, and leaves the second half stranded as a real, unquoted assignment.
  const configDir = await tempConfigDir();
  const injected = 'benign\nIG_TRANSPORT=http';

  const first = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: injected },
    { configDir },
  );
  const afterFirst = await parseEnvFile(first.path);
  assert.equal(afterFirst.IG_ACCOUNT_ID, injected);
  assert.equal(afterFirst.IG_TRANSPORT, undefined, 'no forged key after the first write');

  const second = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: 'plain' },
    { configDir },
  );
  const afterSecond = await parseEnvFile(second.path);
  assert.equal(afterSecond.IG_ACCOUNT_ID, 'plain');
  assert.equal(afterSecond.IG_TRANSPORT, undefined, 'no forged key after the rewrite');
});

test('EVERY newline in a stored value is escaped, not just the first', async () => {
  // Escaping only the FIRST newline still round-trips: dotenv accepts a multi-line
  // double-quoted value and hands the same string back, so the test above passes
  // unchanged. The damage surfaces on the next rewrite, which splits the file on
  // newlines — the tail of the value becomes its own physical line, and a merge
  // that finds an assignment there preserves it as a real one. Putting the forged
  // assignment after the SECOND newline is what separates "all escaped" from
  // "the first escaped".
  const configDir = await tempConfigDir();
  const injected = 'benign\npadding\nIG_TRANSPORT=http';

  const first = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: injected },
    { configDir },
  );
  const afterFirst = await parseEnvFile(first.path);
  assert.equal(afterFirst.IG_ACCOUNT_ID, injected);
  assert.equal(afterFirst.IG_TRANSPORT, undefined, 'no forged key after the first write');

  const second = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: 'plain' },
    { configDir },
  );
  const text = await readFile(second.path, 'utf8');
  const afterSecond = await parseEnvFile(second.path);
  assert.equal(afterSecond.IG_ACCOUNT_ID, 'plain');
  assert.equal(
    afterSecond.IG_TRANSPORT,
    undefined,
    `no forged key after the rewrite, got:\n${text}`,
  );
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

test('a token-only refresh leaves the stored app secret and account id intact', async () => {
  // This is the `refresh` flow: it resolves a new long-lived token and nothing
  // else, so `accountId`/`appId`/`appSecret` arrive as undefined. Writing them as
  // empty strings would silently destroy the Path B credentials the operator
  // logged in with — the next fb-login call would fail to build `appsecret_proof`
  // and read as "invalid credentials" with no clue that a refresh caused it.
  const configDir = await tempConfigDir();
  await writeCredentials(
    'default',
    {
      accessToken: 'first',
      authPath: 'fb-login',
      accountId: '178414',
      appId: '55500',
      appSecret: APP_SECRET,
    },
    { configDir },
  );

  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'fb-login' },
    { configDir },
  );

  // Only the two supplied keys are touched — the omitted ones are not in the result.
  assert.deepEqual(res.keys, ['IG_ACCESS_TOKEN', 'IG_AUTH_PATH']);
  const { profiles } = loadProfiles(await parseEnvFile(res.path));
  assert.deepEqual(profiles[0], {
    name: 'default',
    authPath: 'fb-login',
    accessToken: LONG_TOKEN,
    accountId: '178414',
    appId: '55500',
    appSecret: APP_SECRET,
  });
});

test('rewriting the same credentials is byte-for-byte idempotent', async () => {
  // `refresh` runs on a schedule, so this file is rewritten indefinitely. Anything
  // the merge appends unconditionally — a trailing blank line, a second copy of
  // the header — grows without bound over the life of the install. Comparing the
  // full text (not a parse) is the only way to see growth that dotenv ignores.
  const configDir = await tempConfigDir();
  const creds = { accessToken: LONG_TOKEN, authPath: 'ig-login' } as const;

  const res = await writeCredentials('default', creds, { configDir });
  const first = await readFile(res.path, 'utf8');
  await writeCredentials('default', creds, { configDir });
  const second = await readFile(res.path, 'utf8');
  await writeCredentials('default', creds, { configDir });
  const third = await readFile(res.path, 'utf8');

  assert.equal(second, first);
  assert.equal(third, first);
  assert.equal(first.endsWith('\n'), true, 'the file ends with exactly one newline');
  assert.equal(first.endsWith('\n\n'), false);
});

test('a fresh file gets the "keep private" header exactly once, ever', async () => {
  // The header is the only place the file says "do not commit this". It belongs on
  // the file the CLI creates, and a rewrite must not stack another copy: the
  // headers would end up interleaved with credential lines after the first merge.
  const configDir = await tempConfigDir();
  const marker = '# Keep private (chmod 0600); never commit this file.';
  const creds = { accessToken: LONG_TOKEN, authPath: 'ig-login' } as const;

  const res = await writeCredentials('default', creds, { configDir });
  const fresh = await readFile(res.path, 'utf8');
  assert.equal(fresh.split('\n').filter((l) => l === marker).length, 1, 'header on a fresh file');

  await writeCredentials('default', creds, { configDir });
  const rewritten = await readFile(res.path, 'utf8');
  assert.equal(rewritten.split('\n').filter((l) => l === marker).length, 1, 'not duplicated');
});

test('a key assigned twice has EVERY assignment rewritten, so no revoked value survives', async () => {
  // Duplicates are ordinary in a hand-edited file: an operator who cannot find the
  // line they set last time appends another one below it. Rewriting only the FIRST
  // occurrence leaves the second holding the revoked token — and dotenv resolves a
  // repeated key to the LAST assignment, so the dead credential is not merely
  // still on disk, it is the one every reader gets. The symptom is a login that
  // reports success and a server that keeps failing auth, with the fresh token
  // plainly visible in the file the operator inspects.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    [
      'IG_ACCESS_TOKEN=stale-first',
      '# re-added by hand after the token expired',
      'IG_ACCESS_TOKEN=stale-second',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );

  const text = await readFile(filePath, 'utf8');
  assert.equal(text.includes('stale-first'), false, 'the first revoked value is gone');
  assert.equal(text.includes('stale-second'), false, 'the duplicate revoked value is gone too');
  assert.ok(text.includes('# re-added by hand after the token expired'), 'the comment survives');
  const env = await parseEnvFile(filePath);
  assert.equal(env.IG_ACCESS_TOKEN, LONG_TOKEN, 'the reader resolves the fresh token');
});

test('an assignment padded with whitespace around `=` is recognised, not left behind', async () => {
  // `KEY = value` is a live assignment to dotenv (it trims both sides), not a
  // typo. A merge that insists on `KEY=` treats the line as unrelated text: the
  // revoked token stays exactly where it is and a second assignment is appended
  // below it, so the file carries a secret nobody believes is there and only the
  // reader's last-one-wins rule keeps the fresh value winning.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'IG_ACCESS_TOKEN = stale-token\nIG_APP_ID\t=  old-app\n', 'utf8');

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'fb-login', appId: '55500', appSecret: APP_SECRET },
    { configDir },
  );

  const text = await readFile(filePath, 'utf8');
  assert.equal(text.includes('stale-token'), false, 'the revoked token is gone from disk');
  assert.equal(text.includes('old-app'), false, 'the stale app id is gone from disk');
  const env = await parseEnvFile(filePath);
  assert.equal(env.IG_ACCESS_TOKEN, LONG_TOKEN);
  assert.equal(env.IG_APP_ID, '55500');
});

test('a CRLF file is rewritten as LF, so no stray CR is left inside a value', async () => {
  // A file edited on Windows — or moved through a tool that converts line endings
  // — arrives CRLF. Splitting on `\n` alone keeps the CR as the last character of
  // every line the merge does not rewrite, so an unrelated value silently gains a
  // trailing control character and the file ends up mixing both endings. Only the
  // raw bytes show it: dotenv trims the CR, so no parse-level assertion can see it.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    '# windows-edited\r\nIG_TRANSPORT=http\r\nIG_ACCESS_TOKEN=stale\r\n',
    'utf8',
  );

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );

  const text = await readFile(filePath, 'utf8');
  assert.equal(text.includes('\r'), false, `expected no CR, got ${JSON.stringify(text)}`);
  assert.ok(text.includes('# windows-edited'), 'the comment survives the normalisation');
  assert.equal(text.includes('stale'), false, 'the CRLF assignment was still recognised');
  assert.equal((await parseEnvFile(filePath)).IG_TRANSPORT, 'http');
});

test('a blank optional credential is skipped, not written as an empty assignment', async () => {
  // A refresh that resolved nothing for a field passes `undefined`; a CLI that read
  // an unset flag passes `''`. Both mean "I have nothing to say about this field",
  // and only the first is obviously harmless. Writing the blank one through
  // REPLACES the stored value with an empty assignment — and an empty value is not
  // an absent one to look at, but it is to `loadProfiles`, so an fb-login profile
  // quietly loses the app credentials it needs for `appsecret_proof` and the file
  // no longer records what the operator logged in with.
  const configDir = await tempConfigDir();
  await writeCredentials(
    'default',
    {
      accessToken: 'first',
      authPath: 'fb-login',
      accountId: '178414',
      appId: '55500',
      appSecret: APP_SECRET,
    },
    { configDir },
  );

  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'fb-login', accountId: '   ', appId: '', appSecret: '\t' },
    { configDir },
  );

  assert.deepEqual(res.keys, ['IG_ACCESS_TOKEN', 'IG_AUTH_PATH']);
  const text = await readFile(res.path, 'utf8');
  assert.equal(/^IG_ACCOUNT_ID=\s*$/m.test(text), false, 'no empty assignment was written');
  const { profiles } = loadProfiles(await parseEnvFile(res.path));
  assert.deepEqual(profiles[0], {
    name: 'default',
    authPath: 'fb-login',
    accessToken: LONG_TOKEN,
    accountId: '178414',
    appId: '55500',
    appSecret: APP_SECRET,
  });
});

test('an existing file with no trailing newline keeps its last line', async () => {
  // The merge drops the empty element `split` leaves behind so the file does not
  // grow a blank line per write. That element exists only when the file ENDS with
  // a newline — a file saved without one has a real last line in that slot, and
  // popping it unconditionally deletes an operator's variable (or, from the second
  // write on, one of our own assignments) with nothing to show for it.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '# operator header\nKEEP_ME=1', 'utf8');

  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  const text = await readFile(res.path, 'utf8');
  const env = await parseEnvFile(res.path);
  assert.equal(env.KEEP_ME, '1', `the unterminated last line was dropped:\n${text}`);
  assert.equal(env.IG_ACCESS_TOKEN, LONG_TOKEN);
  assert.ok(text.startsWith('# operator header\n'), 'the header is still first');
  assert.ok(text.endsWith('\n'), 'the rewrite always terminates the last line');
});

test('keys not already present are appended after the existing content', async () => {
  // Order is not cosmetic in a last-one-wins format. Appending the new block after
  // everything already in the file is what keeps the fresh value the one a reader
  // resolves even when an assignment of the same key survives above it in a shape
  // `assignmentOn` does not recognise. Prepending would put the new value exactly where
  // any stale line overrides it.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '# operator header\nIG_TRANSPORT=http\n', 'utf8');

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );

  const lines = (await readFile(filePath, 'utf8')).split('\n');
  assert.deepEqual(lines.slice(0, 2), ['# operator header', 'IG_TRANSPORT=http']);
  assert.deepEqual(lines.slice(2, 4), [`IG_ACCESS_TOKEN=${LONG_TOKEN}`, 'IG_AUTH_PATH=ig-login']);
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

test('a value containing a single quote or a newline round-trips via the double-quoted form', async () => {
  // The single-quoted form cannot carry either character, so `formatValue` falls
  // back to double quotes with `\n`/`\r` escapes — the one form dotenv un-escapes.
  // A secret that failed to round-trip here would authenticate as a DIFFERENT
  // string and read as "invalid credentials" at the first tool call. (A single
  // quote beside a `"`, `$`, backtick or backslash is refused instead —
  // CC-CFG-59.)
  const cases = ["it's a token", 'line1\nline2', 'carriage\r\nreturn', "mixed ' and #hash"];
  for (const value of cases) {
    const configDir = await tempConfigDir();
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: value },
      { configDir },
    );
    const env = await parseEnvFile(res.path);
    assert.equal(env.IG_ACCOUNT_ID, value, `round-trip failed for ${JSON.stringify(value)}`);
  }
});

test('a value containing "#" is quoted, so dotenv does not truncate it at a comment', async () => {
  // An unquoted `#` starts a comment for dotenv, so emitting such a value bare
  // stores a PREFIX of it — silently, and with no way to tell from the file that
  // anything was lost. For a token that is an "invalid credentials" failure whose
  // cause is invisible. The last case needs BOTH quote forms to be considered: it
  // contains a single quote (so the single-quoted form cannot carry it) AND a `#`
  // (so the bare form would truncate it) — only double quotes survive.
  const cases = ['abc#def', '#leading', 'trailing #', "it's #1 secret"];
  for (const value of cases) {
    const configDir = await tempConfigDir();
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: value },
      { configDir },
    );
    const env = await parseEnvFile(res.path);
    assert.equal(env.IG_ACCOUNT_ID, value, `round-trip failed for ${JSON.stringify(value)}`);
  }
});

test('a value carrying a literal backslash escape is stored raw, not un-escaped on read-back', async () => {
  // The two quoting forms are NOT interchangeable: dotenv reverses `\n` / `\r`
  // inside DOUBLE quotes and treats a SINGLE-quoted value as a literal. A value
  // that contains the two characters `\` + `n` — which an app secret or a caption
  // template genuinely can — therefore round-trips only through the single-quoted
  // form. Emitted double-quoted it comes back with a real newline in place of the
  // escape: a secret that is one character shorter and authenticates as a
  // different string, and (for a multi-line result) a value that the NEXT rewrite
  // splits across two physical lines.
  const cases = ['secret\\nnot-a-newline', 'a\\rb', 'C:\\path\\to\\file', 'trailing\\'];
  for (const value of cases) {
    const configDir = await tempConfigDir();
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: value },
      { configDir },
    );
    const env = await parseEnvFile(res.path);
    assert.equal(env.IG_ACCOUNT_ID, value, `round-trip failed for ${JSON.stringify(value)}`);
    assert.equal(
      env.IG_ACCOUNT_ID?.includes('\n'),
      false,
      'the escape must not be turned into a real newline',
    );
  }
});

test('a value wrapped in single quotes is not emitted bare', async () => {
  // The bare form is only safe for characters that mean nothing to a `.env`
  // reader. A quote means plenty: dotenv strips a surrounding pair, so a value
  // stored as `IG_ACCOUNT_ID='quoted'` reads back two characters shorter than it
  // was written. For a secret that is a silent corruption that surfaces only as
  // "invalid credentials" at the first API call.
  const cases = ["'quoted'", "''", "'both' 'pairs'"];
  for (const value of cases) {
    const configDir = await tempConfigDir();
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: value },
      { configDir },
    );
    const env = await parseEnvFile(res.path);
    assert.equal(env.IG_ACCOUNT_ID, value, `round-trip failed for ${JSON.stringify(value)}`);
  }
});

test('a value containing a space is quoted, so the line survives a shell `source`', async () => {
  // dotenv reads `IG_X=has a space` back intact, so a round-trip alone cannot pin
  // this and the assertion is on the emitted text. dotenv is not the only reader:
  // this module recognises the `export KEY=value` spelling precisely because
  // operators `source` the file from a shell, and `docker run --env-file` and
  // systemd's `EnvironmentFile=` consume it too. Unquoted, `IG_ACCESS_TOKEN=has a
  // space` exports a TRUNCATED token and then tries to run `space` as a command.
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: 'has a space' },
    { configDir },
  );
  const text = await readFile(res.path, 'utf8');
  assert.ok(
    text.split('\n').includes("IG_ACCOUNT_ID='has a space'"),
    `expected a quoted assignment, got:\n${text}`,
  );
  const env = await parseEnvFile(res.path);
  assert.equal(env.IG_ACCOUNT_ID, 'has a space');
});

test('every carriage return is escaped, even without a newline beside it', async () => {
  // A lone `\r` is the other character the single-quoted form cannot carry:
  // dotenv normalises every CR in the file to LF before parsing, so a raw one
  // inside a quoted value comes back as a NEWLINE. The value then authenticates as
  // a different string and — now spanning two physical lines — can have its tail
  // stranded as a real assignment by the next rewrite. The `carriage\r\nreturn`
  // case above does not pin either half: the LF alone forces the escaped form, and
  // one CR cannot tell a first-occurrence escape from an all-occurrence one.
  const cases = ['carriage\rreturn', 'a\rb\rc'];
  for (const value of cases) {
    const configDir = await tempConfigDir();
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: value },
      { configDir },
    );
    const env = await parseEnvFile(res.path);
    assert.equal(env.IG_ACCOUNT_ID, value, `round-trip failed for ${JSON.stringify(value)}`);
  }
});

test('a blank profile name falls back to the default, unprefixed key scheme', async () => {
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    '   ',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  assert.ok(res.keys.includes('IG_ACCESS_TOKEN'), `got ${res.keys.join(',')}`);
  assert.equal(
    res.keys.some((k) => k.startsWith('IG_PROFILE_')),
    false,
    'a blank name must not produce an IG_PROFILE__* scheme',
  );
});

test("a differently-cased 'Default' writes the bare IG_* keys, not a named block", async () => {
  // `config.ts` lowercases profile names on read, so `--profile Default` and
  // `--profile default` are the same account. If the writer does not lowercase
  // too, `Default` lands in an `IG_PROFILE_DEFAULT_*` block: the credentials are
  // on disk, the login reports success, and every later run still reports "no
  // profile configured" because the default profile reads the bare keys.
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'Default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );

  assert.deepEqual(res.keys, ['IG_ACCESS_TOKEN', 'IG_AUTH_PATH']);
  const { profiles } = loadProfiles(await parseEnvFile(res.path));
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.name, 'default');
  assert.equal(profiles[0]?.accessToken, LONG_TOKEN);
});

/*
 * CC-CFG-12, the "error surface" half. Before the wrapper, every `node:fs`
 * failure in this module escaped `writeCredentials` as the raw error — for a
 * read, `EISDIR: illegal operation on a directory, read`, and for a write the
 * `ENOSPC`/`EACCES` from whichever of `mkdir`/`chmod`/`writeFile`/`rename`
 * broke, naming a `.env.<hex>.tmp` sibling the operator has never heard of. It
 * was the one path on which the `login` CLI printed Node's wording instead of an
 * `InstagramError`. The tests below pin the whole message (path, code, remedy),
 * the kind, and that the raw error is kept as `cause` — measured by the
 * deterministic, root-independent failures a temp directory can stage.
 */

/** The wrapped store failure `writeCredentials` produced for `configDir`. */
async function storeFailureFor(configDir: string): Promise<InstagramError> {
  try {
    await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir },
    );
  } catch (err) {
    assert.ok(isInstagramError(err), 'a raw node:fs error must not escape writeCredentials');
    assert.equal(err.kind, 'validation', 'a store failure is a validation error');
    assert.ok(err.cause instanceof Error, 'the raw node:fs error is kept as `cause`');
    return err;
  }
  return assert.fail('writeCredentials succeeded against a store it cannot read or write');
}

test('a read failure other than ENOENT is wrapped, naming the store, the code and the remedy', async () => {
  // Only "the file is not there yet" may be treated as empty content. Any other
  // read error means we cannot see what is already on disk — continuing would
  // replace an unread file, dropping the operator's other keys. Three shapes a
  // temp directory can stage without privileges, each carrying its own code so
  // the code in the message is proven to come from the raw error and not from a
  // constant: the env "file" is a directory (EISDIR), the server directory is a
  // regular file (ENOTDIR), and the env file is a symlink to itself (ELOOP).
  const cases: Array<[code: string, stage: (configDir: string) => Promise<void>]> = [
    [
      'EISDIR',
      async (configDir) => {
        await mkdir(envFileIn(configDir), { recursive: true });
      },
    ],
    [
      'ENOTDIR',
      async (configDir) => {
        await writeFile(path.join(configDir, SERVER_DIR), 'not a directory', 'utf8');
      },
    ],
    [
      'ELOOP',
      async (configDir) => {
        await mkdir(path.join(configDir, SERVER_DIR), { recursive: true });
        await symlink('.env', envFileIn(configDir));
      },
    ],
  ];
  for (const [code, stage] of cases) {
    const configDir = await tempConfigDir();
    await stage(configDir);
    const err = await storeFailureFor(configDir);
    assert.equal(
      err.message,
      `Cannot read the credential store at ${envFileIn(configDir)} (${code}): check the permissions on the file and its directory`,
      `${code}: the message names the store path, the code and the read-side remedy`,
    );
    assert.equal(
      (err.cause as NodeJS.ErrnoException).code,
      code,
      `${code}: cause is the raw error`,
    );
  }
});

test('an unreadable existing file aborts the write instead of being replaced', async () => {
  // The EISDIR case above cannot tell a genuine propagation apart from a swallowed
  // one, because the write that follows a swallow also fails (you cannot rename
  // over a directory). EACCES can: the file is perfectly renamable, so if the read
  // error is treated as "no file yet", the operator's unread credentials are
  // destroyed and the failure looks like a success. Root bypasses the permission
  // check, so the test only means something as an unprivileged user.
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  const existing = [
    '# hand-written header',
    'IG_TRANSPORT=http',
    'IG_ACCESS_TOKEN=keep-me',
    '',
  ].join('\n');
  await mkdir(path.dirname(envPath), { recursive: true });
  await writeFile(envPath, existing, 'utf8');
  await chmod(envPath, 0o000);

  try {
    const err = await storeFailureFor(configDir);
    assert.equal(
      err.message,
      `Cannot read the credential store at ${envPath} (EACCES): check the permissions on the file and its directory`,
    );
    assert.equal((err.cause as NodeJS.ErrnoException).code, 'EACCES');
    await chmod(envPath, 0o600);
    assert.equal(await readFile(envPath, 'utf8'), existing, 'the unread file is left untouched');
  } finally {
    await chmod(envPath, 0o600).catch(() => undefined);
  }
});

test('ENOENT on read still means an empty store, so a first login creates the file', async () => {
  // The one read failure the wrapper must NOT touch: a store that does not exist
  // yet is the normal state of a first `login`, not an error. Everything else in
  // this file relies on it implicitly; this pins it by name, so a wrapper widened
  // to "every read failure" fails a test that says why.
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  assert.equal(res.path, envFileIn(configDir));
  assert.deepEqual(await parseEnvFile(res.path), {
    IG_ACCESS_TOKEN: LONG_TOKEN,
    IG_AUTH_PATH: 'ig-login',
  });
});

test('a write failure is wrapped, naming the store, the code and the remedy, with no temp sibling', async () => {
  // The write side, staged so that it fails at `mkdir` without privileges: a
  // dangling symlink where the server directory belongs. The read passes (the
  // link resolves to nothing, so `readFile` reports ENOENT and the store is
  // "empty"), and `mkdir` then fails ENOENT trying to create through it. The
  // message names the store path — never the temp sibling — and, because the
  // failure precedes `writeFile`, no `.env.<hex>.tmp` exists anywhere: the temp
  // sibling is created only once there is a directory to hold it.
  const configDir = await tempConfigDir();
  const root = path.dirname(configDir);
  await symlink(path.join(root, 'nowhere-to-be-found'), path.join(configDir, SERVER_DIR));

  const err = await storeFailureFor(configDir);
  assert.equal(
    err.message,
    `Cannot write the credential store at ${envFileIn(configDir)} (ENOENT): check free space and the permissions on its directory`,
  );
  const cause = err.cause as NodeJS.ErrnoException;
  assert.equal(cause.code, 'ENOENT');
  assert.equal(cause.syscall, 'mkdir', 'it was the directory creation that failed, not the read');
  assert.deepEqual(
    await readdir(configDir),
    [SERVER_DIR],
    'nothing but the staged link exists: no temp sibling was created',
  );
});

test('a directory the user cannot create the store under is a wrapped EACCES', async () => {
  // The write-side code an operator actually meets: a config home they own but
  // cannot write to (a read-only dotfiles checkout, say). The parent is 0500 and
  // the server directory absent, so `mkdir` is the call that fails. Root bypasses
  // the permission check, so the test only means something as an unprivileged
  // user; the ENOENT case above covers the wrapper itself on every runner.
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const configDir = await tempConfigDir();
  await chmod(configDir, 0o500);
  try {
    const err = await storeFailureFor(configDir);
    assert.equal(
      err.message,
      `Cannot write the credential store at ${envFileIn(configDir)} (EACCES): check free space and the permissions on its directory`,
    );
    assert.equal((err.cause as NodeJS.ErrnoException).code, 'EACCES');
    assert.deepEqual(await readdir(configDir), [], 'nothing was created');
  } finally {
    await chmod(configDir, 0o700).catch(() => undefined);
  }
});

/**
 * An absolute path under `root` of exactly `length` characters, spelled out of
 * 200-character components (well under every NAME_MAX, so only the TOTAL length
 * is ever what a syscall objects to). Nothing is created — this is a string.
 */
function pathOfLength(root: string, length: number): string {
  let built = root;
  while (length - built.length > 202) built = path.join(built, 'x'.repeat(200));
  const last = length - built.length - 1;
  assert.ok(last >= 1, `a ${length}-character path does not fit under ${root}`);
  return path.join(built, 'x'.repeat(last));
}

/**
 * The longest path the running filesystem will resolve, MEASURED rather than
 * assumed: the limit is 1024 characters on macOS and 4096 on Linux, so a test
 * that hard-coded either would stage nothing at all on the other runner.
 *
 * `readFile` is the probe because it creates nothing: a path within the limit
 * reports `ENOENT` (it simply is not there), one beyond it `ENAMETOOLONG` —
 * which makes the property monotonic and the search a plain bisection that
 * leaves no directories behind.
 */
async function maxResolvablePathLength(root: string): Promise<number> {
  const errnoFor = async (length: number): Promise<string | undefined> => {
    try {
      await readFile(pathOfLength(root, length), 'utf8');
      return assert.fail(`the probe path of ${length} characters exists`);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code;
    }
  };
  // 8192 is above every limit in play (Linux's 4096 is the largest), and a path
  // three characters longer than the temp root is below every one of them.
  let lo = root.length + 3;
  let hi = 8192;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((await errnoFor(mid)) === 'ENOENT') lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

test('a failure at the temp write, after the directory calls, is wrapped exactly as one at mkdir', async () => {
  // Both write cases above fail at `mkdir`, the FIRST call in the sequence. A
  // wrapper that covered only the directory half — `mkdir` and the directory
  // `chmod` inside the `try`, the temp write and the rename outside it — passes
  // both of them, while the write failure an operator actually meets (a full
  // disk at `writeFile`) escapes raw again as it did before CC-CFG-12. That
  // mutant survived the whole suite until this test existed.
  //
  // Staging a failure PAST `mkdir` without privileges takes the one lever the
  // filesystem hands out for free: path length. The temp sibling's name is
  // exactly 17 characters longer than the store's (`.` + 12 hex + `.tmp`) and the
  // writer's lock 5 longer (`.lock`), so a store path sitting exactly 5 under the
  // limit is readable, its directory creatable and its lock takeable while the
  // temp sibling's path is not: `readFile` answers ENOENT (an empty store, the
  // normal first-login state), `mkdir`, the directory `chmod` and the lock
  // succeed, and `writeFile` is the call that fails, with ENAMETOOLONG.
  // Windows is skipped — its path limits are a different rule (`\\?\` prefixes,
  // per-drive maxima) and it is also the platform on which this module skips
  // the chmods, so the sequence under test is not the same one.
  if (process.platform === 'win32') return;
  const root = await tempConfigDir();
  const limit = await maxResolvablePathLength(root);
  // The fixed tail every store path carries: `/instagram-mcp-ai/.env`.
  const tail = envFileIn('x').length - 1;
  const configDir = pathOfLength(root, limit - tail - LOCK_SUFFIX.length);
  const store = envFileIn(configDir);
  assert.equal(
    `${store}${LOCK_SUFFIX}`.length,
    limit,
    'premise: the lock path is exactly at the limit, so the lock can be taken',
  );

  const err = await storeFailureFor(configDir);
  assert.equal(
    err.message,
    `Cannot write the credential store at ${store} (ENAMETOOLONG): check free space and the permissions on its directory`,
  );
  const cause = err.cause as NodeJS.ErrnoException;
  assert.equal(cause.code, 'ENAMETOOLONG');
  assert.equal(
    cause.syscall,
    'open',
    'the premise: it was the temp write that failed, not a directory call',
  );
  assert.ok(
    String(cause.path).endsWith('.tmp'),
    'the premise: the path that failed is the temp sibling, not the lock',
  );
  assert.deepEqual(
    await readdir(path.dirname(store)),
    [],
    'the directory was created and left empty: the temp sibling never came into being',
  );
});

test('a lock that waiting cannot help create fails at once, wrapped', async () => {
  // Only EEXIST (another writer holds the lock) is worth waiting on. Any other
  // failure to create the lock would retry to the deadline and then blame a
  // writer that does not exist. A store path exactly at the limit stages one:
  // the store reads as ENOENT and its directory is created, while the lock
  // path, 5 characters longer, fails with ENAMETOOLONG.
  if (process.platform === 'win32') return;
  const root = await tempConfigDir();
  const limit = await maxResolvablePathLength(root);
  const tail = envFileIn('x').length - 1;
  const configDir = pathOfLength(root, limit - tail);
  const store = envFileIn(configDir);
  assert.equal(store.length, limit, 'premise: the store path itself is exactly at the limit');

  const started = Date.now();
  const err = await storeFailureFor(configDir);
  assert.ok(Date.now() - started < 5000, 'the failure is immediate, not a lock timeout');
  assert.equal(
    err.message,
    `Cannot write the credential store at ${store} (ENAMETOOLONG): check free space and the permissions on its directory`,
  );
  const cause = err.cause as NodeJS.ErrnoException;
  assert.equal(cause.code, 'ENAMETOOLONG');
  assert.equal(cause.path, `${store}${LOCK_SUFFIX}`, 'the premise: it was the lock that failed');
  assert.deepEqual(await readdir(path.dirname(store)), [], 'nothing was written');
});

// --- Secret safety ---------------------------------------------------------

// The old name of this test was its whole claim — it asserted that the token and
// the app secret do not appear WHOLE in what `writeCredentials` prints. A leak is
// not obliged to be the whole string: a prefix, a tail, a length, or any other
// fingerprint of the token passes `!printed.includes(LONG_TOKEN)` and still hands
// an observer material they did not have. The property worth pinning is stronger
// and simpler, and it is the one the transport actually needs — this function
// writes NOTHING to stdout, because a single byte there corrupts the JSON-RPC
// framing of a server running on `stdio`. Until 2026-09-23 the only thing pinning
// that was `test/index.test.ts`'s `assert.equal(run.stdout, '')` inside the refresh
// test: a backstop for one process-level path that happens to reach this function,
// not a pin on the function (CC-PROC-127).
test('writeCredentials writes nothing to stdout', async () => {
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
  assert.equal(
    printed,
    '',
    `writeCredentials wrote ${JSON.stringify(printed)} to stdout; on the stdio transport ` +
      'that is protocol corruption, and any of it may be a fingerprint of the secret it ' +
      'was handed',
  );
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

test('the containing directory is created owner-only (0700)', async () => {
  // The file mode alone is not the whole story: a 0755 directory lets any local
  // account list and traverse the credential store, and — worse — a group- or
  // world-writable one lets it rename our file out from under us. CC-CFG-8 asks
  // for 0700 on the directory as well. The umask is pinned so the assertion
  // measures the mode this module REQUESTS, not the one the runner happens to
  // allow (a tight ambient umask would mask the bug on CI and expose it locally).
  if (process.platform === 'win32') return;
  const configDir = await tempConfigDir();
  const previousMask = process.umask(0o022);
  try {
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir },
    );
    const mode = (await stat(path.dirname(res.path))).mode & 0o777;
    assert.equal(mode, 0o700, `expected 0700, got 0o${mode.toString(8)}`);
  } finally {
    process.umask(previousMask);
  }
});

test('the 0600 mode is applied explicitly, not inherited from the process umask', async () => {
  // `writeFile(..., { mode })` is only a REQUEST — the kernel masks it with the
  // process umask, so the create mode alone cannot promise 0600. The explicit
  // chmod is what makes it a guarantee. Driving the write under a umask that
  // strips owner-read (0400) is the only way to tell the two apart: without the
  // chmod the file lands at 0200 and the operator cannot read back their own
  // credentials — a login that "succeeds" and then never works.
  //
  // SIBLING NARROWINGS: `atomicWrite` narrows the mode THREE times — the
  // `writeFile` mode argument, the chmod on the temp file, and the chmod after the
  // rename. This comment claimed until 2026-09-23 that any ONE of them alone was
  // unobservable from outside; measured that day, only the LAST one is. The create
  // mode is pinned by "no file in the store is group- or world-accessible, not
  // even mid-write", which samples the directory every event-loop turn and sees
  // the temp while it still carries the umask-widened create mode; the chmod on
  // the temp is pinned by "the temp file is brought to 0600 whatever the ambient
  // umask". The post-rename chmod is the one no assertion on the finished file can
  // reach — `rename` preserves the inode and carries the temp's mode over, so the
  // file is already 0600 before it runs, and chmod (unlike a create mode) is not
  // umask-masked either way. It stays as defence in depth: whichever of the three
  // a future edit breaks, the finished store is still never group- or
  // world-readable.
  if (process.platform === 'win32') return;
  const configDir = await tempConfigDir();
  const previousMask = process.umask(0o400);
  try {
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir },
    );
    const mode = (await stat(res.path)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got 0o${mode.toString(8)}`);
  } finally {
    process.umask(previousMask);
  }
});

/**
 * Whether a name the sampler saw is the write's temp sibling — not the store
 * itself, and not the writer's lock (`.env.lock`), which is a fixed name by
 * design: its whole job is to be the one path every writer contends for.
 */
function isTempSibling(name: string): boolean {
  return name !== '.env' && name !== `.env${LOCK_SUFFIX}`;
}

test('no file in the store is group- or world-accessible, not even mid-write', async () => {
  // `stat` on the finished file cannot see the window in which the temp sibling
  // exists — and that window is where a create-mode regression bites. The temp
  // holds the complete live token, so anything sampling the directory while it
  // exists (a backup agent, an indexer, another local account) reads whatever mode
  // the CREATE used; the chmod after the rename comes far too late to help it.
  // Sampling every event-loop turn is what makes that window observable at all.
  // The umask is pinned WIDE OPEN (0022) on purpose: the create mode is masked by
  // it, so a tight ambient umask would hide exactly the bug being looked for.
  if (process.platform === 'win32') return;
  const configDir = await tempConfigDir();
  const storeDir = path.join(configDir, SERVER_DIR);
  await mkdir(storeDir, { recursive: true, mode: 0o700 });

  const previousMask = process.umask(0o022);
  let observed: Map<string, Set<number>>;
  try {
    observed = await sampleStoreDuring(storeDir, async () => {
      await writeCredentials(
        'default',
        { accessToken: PADDED_TOKEN, authPath: 'ig-login' },
        { configDir },
      );
    });
  } finally {
    process.umask(previousMask);
  }

  const temps = [...observed.keys()].filter(isTempSibling);
  assert.ok(
    temps.length > 0,
    `the sampler never caught a temp file: ${[...observed.keys()].join(', ')}`,
  );
  for (const [name, modes] of observed) {
    for (const mode of modes) {
      assert.equal(mode & 0o077, 0, `${name} was readable by others at 0o${mode.toString(8)}`);
    }
  }
});

test('a rename that fails after the temp write leaves no credential-bearing temp sibling (CC-CFG-48)', async () => {
  // Every other failure test stops BEFORE the temp file exists, so none of them
  // can see what a failure after it leaves behind: until 2026-09-23, a full
  // `.env.<hex>.tmp` holding the live token and app secret, which no later write
  // replaces (each picks a fresh random name) and nothing cleans up. Staged
  // without privileges: once the sampler sees the temp sibling appear — the read
  // of the store is already done by then — a non-empty directory is planted
  // where the store belongs, so the rename over it fails.
  if (process.platform === 'win32') return;
  const configDir = await tempConfigDir();
  const storeDir = path.join(configDir, SERVER_DIR);
  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  const store = envFileIn(configDir);

  let planted = false;
  let failure: unknown;
  await sampleStoreDuring(storeDir, async () => {
    const plant = (): void => {
      if (readdirSync(storeDir).some(isTempSibling)) {
        mkdirSync(path.join(store, 'occupied'), { recursive: true });
        planted = true;
        return;
      }
      setImmediate(plant);
    };
    setImmediate(plant);
    try {
      await writeCredentials(
        'default',
        { accessToken: PADDED_TOKEN, authPath: 'ig-login', appSecret: APP_SECRET },
        { configDir },
      );
    } catch (err) {
      failure = err;
    }
  });

  assert.ok(planted, 'premise: the temp sibling was seen, and the store path occupied');
  assert.ok(isInstagramError(failure), 'the rename failure is wrapped');
  assert.equal((failure.cause as NodeJS.ErrnoException).syscall, 'rename');
  const left = await readdir(storeDir);
  assert.deepEqual(
    left.filter(isTempSibling),
    [],
    `a temp sibling holding the credentials was left behind: ${left.join(', ')}`,
  );
});

test('a temp sibling that cannot be removed never masks the write failure that stranded it (CC-CFG-48)', async () => {
  // The cleanup is best-effort: when the directory itself refuses the removal
  // (here it turns read-only once the temp file exists, so the rename AND the
  // `rm` both fail with EACCES), the caller must still see the rename failure,
  // not the cleanup's.
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const configDir = await tempConfigDir();
  const storeDir = path.join(configDir, SERVER_DIR);
  await mkdir(storeDir, { recursive: true, mode: 0o700 });

  let locked = false;
  let failure: unknown;
  await sampleStoreDuring(storeDir, async () => {
    const lock = (): void => {
      if (readdirSync(storeDir).some(isTempSibling)) {
        chmodSync(storeDir, 0o500);
        locked = true;
        return;
      }
      setImmediate(lock);
    };
    setImmediate(lock);
    try {
      await writeCredentials(
        'default',
        { accessToken: PADDED_TOKEN, authPath: 'ig-login', appSecret: APP_SECRET },
        { configDir },
      );
    } catch (err) {
      failure = err;
    } finally {
      await chmod(storeDir, 0o700);
    }
  });

  assert.ok(locked, 'premise: the temp sibling was seen, and the directory locked');
  assert.ok(isInstagramError(failure), 'the rename failure is wrapped');
  assert.equal((failure.cause as NodeJS.ErrnoException).syscall, 'rename');
});

test('the temp sibling is named with enough entropy that two writes cannot collide', async () => {
  // The name exists only mid-write, so sampling is the only way to see it. The
  // collision test below proves the name is not a FIXED one; this proves it is not
  // a near-fixed one. Two writes can genuinely overlap — a `login` while a token
  // refresh is persisting — and if they pick the same temp path the loser's
  // half-written file is renamed over the winner's credentials.
  if (process.platform === 'win32') return;
  const configDir = await tempConfigDir();
  const storeDir = path.join(configDir, SERVER_DIR);
  await mkdir(storeDir, { recursive: true, mode: 0o700 });

  const observed = await sampleStoreDuring(storeDir, async () => {
    await writeCredentials(
      'default',
      { accessToken: PADDED_TOKEN, authPath: 'ig-login' },
      { configDir },
    );
  });

  const temps = [...observed.keys()].filter(isTempSibling);
  assert.ok(
    temps.length > 0,
    `the sampler never caught a temp file: ${[...observed.keys()].join(', ')}`,
  );
  for (const name of temps) {
    assert.match(name, /^\.env\.[0-9a-f]{12,}\.tmp$/, 'at least 48 bits of temp-name entropy');
  }
});

test('the temp file is brought to 0600 whatever the ambient umask', async () => {
  // The create mode is a REQUEST the umask masks; the chmod is not masked. Under a
  // umask that strips owner bits the two come apart on the temp file exactly as
  // they do on the finished one: without the chmod the temp sits at 0200 for its
  // whole life, so the write depends on the operator's shell settings for a mode
  // it claims to guarantee. This is the same argument as the umask test above,
  // aimed at the one file that is gone before any `stat` can reach it.
  if (process.platform === 'win32') return;
  const configDir = await tempConfigDir();
  const storeDir = path.join(configDir, SERVER_DIR);
  await mkdir(storeDir, { recursive: true, mode: 0o700 });

  const previousMask = process.umask(0o400);
  let observed: Map<string, Set<number>>;
  try {
    observed = await sampleStoreDuring(storeDir, async () => {
      await writeCredentials(
        'default',
        { accessToken: PADDED_TOKEN, authPath: 'ig-login' },
        { configDir },
      );
    });
  } finally {
    process.umask(previousMask);
  }

  const temps = [...observed.keys()].filter(isTempSibling);
  assert.ok(
    temps.length > 0,
    `the sampler never caught a temp file: ${[...observed.keys()].join(', ')}`,
  );
  for (const name of temps) {
    const modes = [...(observed.get(name) ?? [])];
    assert.ok(
      modes.includes(0o600),
      `${name} was never observed at 0600 (saw ${modes.map((m) => m.toString(8)).join(', ')})`,
    );
  }
});

test('the temp sibling gets a unique name, so a stale one cannot wedge the write', async () => {
  // The write is temp-sibling → rename. With a fixed suffix, two logins racing —
  // or one leftover from a crashed run — collide on the same path. Occupying that
  // predictable name with a DIRECTORY makes the collision loud: a fixed-name
  // implementation fails EISDIR and the credentials never reach disk, while a
  // randomised one is unaffected. BOTH plausible fixed spellings are occupied —
  // `<file>.tmp` and the `<file>.<suffix>.tmp` shape with an empty suffix — so the
  // test cannot be satisfied by merely changing which constant name is used.
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  await mkdir(path.dirname(envPath), { recursive: true });
  await mkdir(`${envPath}.tmp`, { recursive: true });
  await mkdir(`${envPath}..tmp`, { recursive: true });

  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  const env = await parseEnvFile(res.path);
  assert.equal(env.IG_ACCESS_TOKEN, LONG_TOKEN);
});

test('the file is replaced by a rename, never truncated and rewritten in place', async () => {
  // The atomicity claim in this module's header is exactly this: a reader sees the
  // whole old file or the whole new one, never a half-written one, and a crash
  // mid-write cannot leave the credential store truncated. Only a `rename` over a
  // fully written sibling gives that — writing straight to the target produces the
  // same end state and satisfies every content assertion in this file, so nothing
  // else here would notice the swap. Two artefacts of the rename are visible from
  // outside: the path gets a NEW inode on every write, and a hard link taken
  // beforehand still holds the old bytes afterwards, which is what "replaced
  // rather than overwritten in place" means concretely.
  if (process.platform === 'win32') return;
  const configDir = await tempConfigDir();
  const first = await writeCredentials(
    'default',
    { accessToken: 'first-token', authPath: 'ig-login' },
    { configDir },
  );
  const before = await stat(first.path);
  const linkPath = `${first.path}.link`;
  await link(first.path, linkPath);

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );

  const after = await stat(first.path);
  assert.notEqual(after.ino, before.ino, 'the path points at a new file after the write');
  assert.equal((await stat(linkPath)).ino, before.ino);
  assert.ok(
    (await readFile(linkPath, 'utf8')).includes('first-token'),
    'the previous file was left intact, not truncated in place',
  );
  assert.ok((await readFile(first.path, 'utf8')).includes(LONG_TOKEN));
});

test('a config directory that already exists at a looser mode is tightened to 0700', async () => {
  // `mkdir(..., { mode })` applies the mode only to directories it CREATES, so a
  // store that is already there keeps whatever mode it has — from a version of
  // this tool that predates the rule, an operator's own `mkdir -p` under a default
  // umask, or a restore that dropped modes. 0600 on the file does not make up for
  // it: write permission on the DIRECTORY is what lets another local account
  // rename our .env away and leave its own behind, and the next login then writes
  // a fresh token into a file somebody else controls.
  if (process.platform === 'win32') return;
  const configDir = await tempConfigDir();
  const storeDir = path.dirname(envFileIn(configDir));
  await mkdir(storeDir, { recursive: true });
  await chmod(storeDir, 0o777);

  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );

  const mode = (await stat(path.dirname(res.path))).mode & 0o777;
  assert.equal(mode, 0o700, `expected 0700, got 0o${mode.toString(8)}`);
});

test('every directory created on the way to the store is owner-only (0700)', async () => {
  // The chmod above covers the final directory; the ones ABOVE it are covered only
  // by the mode `mkdir` is asked for. Those are real directories this module
  // brings into being — `configDir` is operator-supplied and an XDG home may not
  // exist yet — and a 0755 parent leaves the credential store listable by every
  // local account. The umask is pinned so the assertion measures the mode this
  // module REQUESTS, not the one the runner happens to allow.
  if (process.platform === 'win32') return;
  const base = await tempConfigDir();
  const configDir = path.join(base, 'state', 'igmcp');
  const previousMask = process.umask(0o022);
  try {
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir },
    );
    for (const dir of [path.join(base, 'state'), configDir, path.dirname(res.path)]) {
      const mode = (await stat(dir)).mode & 0o777;
      assert.equal(mode, 0o700, `expected 0700 on ${dir}, got 0o${mode.toString(8)}`);
    }
  } finally {
    process.umask(previousMask);
  }
});

// --- Config-home resolution (the path taken with NO configDir override) ----

test('without a configDir override the env file lands under the platform config home', async () => {
  const home = await makeTempConfigHome('igmcp-cfghome-');
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { env: configHomeEnv(home) },
  );

  assert.equal(res.path, envFileIn(home), 'the write must stay inside the injected config home');
  const { profiles } = loadProfiles(await parseEnvFile(res.path));
  assert.equal(profiles[0]?.accessToken, LONG_TOKEN);
});

test('a blank configDir override falls back to the platform config home', async () => {
  // `configDir` comes from a CLI flag, so `--config-dir ""` (or an unset shell
  // variable that expanded to nothing) is a shape users hit. Honouring it would
  // path.join a RELATIVE directory: the credentials land under whatever cwd the
  // server happened to be started from, and the next run — started elsewhere —
  // reports no profile configured while a live token sits in a forgotten folder.
  //
  // It runs in a throwaway cwd (CC-CFG-69). This is the test a mutant of
  // `clean()` fails, and it fails AFTER the write: run from the repository, the
  // unguarded `'   '` put a live 0600 store at `<repo>/   /instagram-mcp-ai/.env`,
  // a directory name `ls` shows as blank, which outlived the run that made it.
  const home = await makeTempConfigHome('igmcp-blankdir-');
  const cwd = await makeTempConfigHome('igmcp-blankdir-cwd-');
  const savedCwd = process.cwd();
  process.chdir(cwd);
  try {
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir: '   ', env: configHomeEnv(home) },
    );

    assert.equal(path.isAbsolute(res.path), true, 'a relative credential path is never acceptable');
    assert.equal(res.path, envFileIn(home));
    assert.deepEqual(await readdir(cwd), [], 'nothing was written relative to the cwd');
  } finally {
    process.chdir(savedCwd);
  }
});

test('a relative configDir override still produces an absolute credential path', async () => {
  // `configDir` is the caller's own choice, so a relative one is obeyed rather
  // than ignored — but it is resolved before use. The returned path is what the
  // CLI prints for the operator to inspect afterwards, and `./instagram-mcp-ai/
  // .env` names a different file the moment they have changed directory. The
  // relative form here points AT the temp home, so the bytes land in the same
  // place either way and only the reported path is under test.
  const home = await makeTempConfigHome('igmcp-reldir-');
  const relative = path.relative(process.cwd(), home);
  assert.equal(path.isAbsolute(relative), false, 'the fixture must actually be relative');

  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir: relative },
  );

  assert.equal(path.isAbsolute(res.path), true, 'a relative credential path is never acceptable');
  assert.equal(res.path, envFileIn(home));
  const { profiles } = loadProfiles(await parseEnvFile(res.path));
  assert.equal(profiles[0]?.accessToken, LONG_TOKEN);
});

test('resolveConfigHome reads APPDATA on win32 and XDG_CONFIG_HOME elsewhere', () => {
  const dir = path.join(tmpdir(), 'igmcp-resolve-home');
  const onWindows = process.platform === 'win32';
  // The documented per-platform default when the variable is absent or blank.
  const fallback = onWindows
    ? path.join(homedir(), 'AppData', 'Roaming')
    : path.join(homedir(), '.config');

  assert.equal(resolveConfigHome(configHomeEnv(dir)), dir, "the platform's own variable wins");
  assert.equal(resolveConfigHome(configHomeEnv('   ')), fallback, 'a blank value is ignored');
  assert.equal(resolveConfigHome({}), fallback, 'an empty env falls back to the default');

  // The OTHER platform's variable must NOT be honored: a resolver that read it
  // would send credentials into the real user config home on that platform.
  const otherPlatformOnly: NodeJS.ProcessEnv = onWindows
    ? { XDG_CONFIG_HOME: dir }
    : { APPDATA: dir };
  assert.equal(
    resolveConfigHome(otherPlatformOnly),
    fallback,
    "the other platform's variable is ignored",
  );
});

test('the win32 branch of resolveConfigHome is exercised even on a POSIX runner', () => {
  // Only one of the two branches can run natively, so CI would never see the
  // other. `%APPDATA%` is the branch that decides where a Windows `login` writes
  // its credentials — an untested one could silently diverge from where
  // `src/index.ts` reads them back.
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real, 'process.platform must be redefinable to drive this branch');
  const dir = path.join(tmpdir(), 'igmcp-win32-home');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    assert.equal(resolveConfigHome({ APPDATA: dir }), dir, 'APPDATA wins on win32');
    assert.equal(
      resolveConfigHome({ APPDATA: '  ' }),
      path.join(homedir(), 'AppData', 'Roaming'),
      'a blank APPDATA falls back to the documented default',
    );
    assert.equal(
      resolveConfigHome({ XDG_CONFIG_HOME: dir }),
      path.join(homedir(), 'AppData', 'Roaming'),
      'XDG_CONFIG_HOME must not be honored on win32',
    );
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
});

test('a RELATIVE config home is ignored, because it would follow the process cwd', () => {
  // The XDG base-directory spec requires these variables to be absolute and says
  // a relative one must be treated as invalid. For this server the consequence is
  // concrete: an MCP client spawns it in whatever directory it likes, so an
  // `XDG_CONFIG_HOME=.` inherited from a shell profile would drop a 0600
  // credentials file into the user's current project — and the next start, from
  // another directory, would read a different file and report the account as
  // unconfigured while a live token sat in a forgotten folder (CC-CFG-24).
  const onWindows = process.platform === 'win32';
  const fallback = onWindows
    ? path.join(homedir(), 'AppData', 'Roaming')
    : path.join(homedir(), '.config');
  // Built inline rather than through `configHomeEnv`: that helper now REFUSES a
  // relative directory, precisely so no writing test can reach this shape by
  // accident. This test only resolves a string — nothing touches disk — so it is
  // the one place allowed to name the input the helper exists to block.
  const homeEnv = (value: string): NodeJS.ProcessEnv =>
    onWindows ? { APPDATA: value } : { XDG_CONFIG_HOME: value };

  for (const relative of ['.', 'config', './config', '../config', 'a/b']) {
    assert.equal(
      resolveConfigHome(homeEnv(relative)),
      fallback,
      `a relative config home (${JSON.stringify(relative)}) must not be honored`,
    );
  }

  // Trimming still runs first, so a padded ABSOLUTE value is used as before.
  const dir = path.join(tmpdir(), 'igmcp-padded-home');
  assert.equal(resolveConfigHome(homeEnv(`  ${dir}  `)), dir);

  // The same rule on the other platform's branch: `%APPDATA%` is absolute by
  // construction, so a relative value there is equally a misconfiguration.
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real, 'process.platform must be redefinable to drive this branch');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    assert.equal(
      resolveConfigHome({ APPDATA: 'AppData/Roaming' }),
      path.join(homedir(), 'AppData', 'Roaming'),
      'a relative APPDATA falls back to the documented default',
    );
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
});

/**
 * Run `run` with the home directory (`$HOME`, `%USERPROFILE%`) and the cwd moved
 * into a fresh temp directory, so a `~` or a relative path resolves somewhere
 * disposable — including under the original code, where a `~/…` override became
 * a folder named `~` in the cwd — and never into the developer's real home.
 */
async function withTempHomeAndCwd(run: (home: string) => Promise<void>): Promise<void> {
  const base = await makeTempConfigHome('igmcp-tilde-');
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'cwd');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const savedCwd = process.cwd();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(cwd);
  try {
    assert.equal(homedir(), home, 'premise: the home directory follows the environment');
    await run(home);
    assert.deepEqual(await readdir(cwd), [], 'nothing was written relative to the cwd');
  } finally {
    process.chdir(savedCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(base, { recursive: true, force: true });
  }
}

test('a ~ config home is the home directory, for the reader and the writer alike (CC-CFG-60)', async () => {
  // A shell expands `XDG_CONFIG_HOME=~/cfg` before `login` sees it; an MCP
  // client's JSON `env` block does not. The server used to ignore the literal
  // `~/cfg` as relative (CC-CFG-24) and read `~/.config`, while the `login` run
  // in a terminal had written `$HOME/cfg` — the new token where nothing read it.
  // Both sides resolve through `resolveConfigHome`, so expanding it there puts
  // them on the same directory whichever one received the unexpanded text.
  const onWindows = process.platform === 'win32';
  const homeEnv = (value: string): NodeJS.ProcessEnv =>
    onWindows ? { APPDATA: value } : { XDG_CONFIG_HOME: value };
  await withTempHomeAndCwd(async (home) => {
    assert.equal(resolveConfigHome(homeEnv('~')), home, '`~` alone is the home directory');
    assert.equal(resolveConfigHome(homeEnv(' ~/cfg ')), path.join(home, 'cfg'), 'trimmed first');

    // The writer, handed the same unexpanded variable, lands on that directory.
    const viaEnv = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { env: homeEnv('~/cfg') },
    );
    assert.equal(viaEnv.path, envFileIn(path.join(home, 'cfg')));

    // An explicit `configDir` of `~/…` is the home directory too, not a folder
    // literally named `~` under the cwd.
    const viaDir = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir: '~/explicit' },
    );
    assert.equal(viaDir.path, envFileIn(path.join(home, 'explicit')));
    const { profiles } = loadProfiles(await parseEnvFile(viaDir.path));
    assert.equal(profiles[0]?.accessToken, LONG_TOKEN);
  });

  // A backslash separates only where it is a separator: on win32 `~\x` is the
  // home directory's `x`, while on POSIX a backslash is part of a name, so
  // `~\x` is a `~user`-style spelling and refused (CC-CFG-61).
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real, 'process.platform must be redefinable to drive this branch');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    assert.equal(resolveConfigHome({ APPDATA: '~' }), homedir());
    assert.equal(resolveConfigHome({ APPDATA: '~\\Roaming' }), path.join(homedir(), '\\Roaming'));
    // The refusal names the variable the Windows branch actually read.
    assert.throws(
      () => resolveConfigHome({ APPDATA: '$HOME/cfg' }),
      (err: unknown) => isInstagramError(err) && err.message.startsWith('APPDATA is '),
    );
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    assert.throws(
      () => resolveConfigHome({ XDG_CONFIG_HOME: '~\\cfg' }),
      (err: unknown) => isInstagramError(err) && err.message.startsWith('XDG_CONFIG_HOME is '),
    );
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
});

test('a config home only a shell could expand is refused, naming where it came from (CC-CFG-61)', async () => {
  // `~user`, `$HOME` and `%APPDATA%` are expanded by a shell and by nothing else.
  // Ignored like a relative path, `XDG_CONFIG_HOME=$HOME/cfg` in a client's JSON
  // would send the server to the default home while a terminal `login` wrote to
  // the expanded one; as a `configDir` it became a folder named `$HOME` in the
  // cwd. Neither side can honour it, so both refuse it before touching disk.
  const onWindows = process.platform === 'win32';
  const variable = onWindows ? 'APPDATA' : 'XDG_CONFIG_HOME';
  const refusal = (source: string, value: string): string =>
    `${source} is ${JSON.stringify(value)}, which only a shell can expand — it is not a path ` +
    'this server can use to find the credential store; set it to an absolute path';
  const refusedWith =
    (message: string) =>
    (err: unknown): boolean => {
      assert.ok(isInstagramError(err), `expected an InstagramError, got ${String(err)}`);
      assert.equal(err.kind, 'validation');
      assert.equal(err.message, message);
      return true;
    };
  await withTempHomeAndCwd(async () => {
    for (const value of ['~root/cfg', '~+', '$HOME/cfg', '${HOME}/cfg', '%APPDATA%\\cfg']) {
      assert.throws(
        () => resolveConfigHome({ [variable]: value }),
        refusedWith(refusal(variable, value)),
        value,
      );
      await assert.rejects(
        writeCredentials(
          'default',
          { accessToken: LONG_TOKEN, authPath: 'ig-login' },
          { env: { [variable]: value } },
        ),
        refusedWith(refusal(variable, value)),
        `${value} (env)`,
      );
      await assert.rejects(
        writeCredentials(
          'default',
          { accessToken: LONG_TOKEN, authPath: 'ig-login' },
          { configDir: ` ${value} ` },
        ),
        refusedWith(refusal('configDir', value)),
        `${value} (configDir)`,
      );
    }
    // A shell character past the start is part of an ordinary name: a relative
    // value is still ignored (CC-CFG-24), an absolute one still honoured.
    assert.equal(resolveConfigHome({ [variable]: 'cfg$1' }), resolveConfigHome({}));
    const absolute = path.join(tmpdir(), '$literal');
    assert.equal(resolveConfigHome({ [variable]: absolute }), absolute);
  });
});

// --- Validation ------------------------------------------------------------

test('a blank access token is rejected with a validation error', async () => {
  const configDir = await tempConfigDir();
  await assert.rejects(
    () => writeCredentials('default', { accessToken: '   ', authPath: 'ig-login' }, { configDir }),
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'validation' &&
      // The message is the whole diagnostic a CLI user gets — the call is rejected
      // before anything touches disk, so there is no file to inspect afterwards.
      // It must name the missing field, not just say the input was bad — and it
      // is pinned whole: a fragment match let a mutant drop the `writeCredentials:`
      // prefix that tells the reader which call refused (CC-PROC-54).
      err.message === 'writeCredentials: an access token is required.',
  );
});

test('the credentials-file header is a two-line block, in order, and only on a fresh file', async () => {
  // The neighbouring test above counts one of these two lines and calls the result
  // "the header". It is the wrong half to count alone. Deleting the provenance
  // line, swapping the two lines, or making it name a different CLI all leave the
  // whole suite green, because nothing anywhere asserts that the line exists.
  //
  // The line is the only thing on disk that says what created this file. The
  // operator who reads it is not the one who ran `login`: it is whoever finds an
  // unexplained dotfile holding a long-lived Instagram token on a machine, months
  // later, and has to decide whether deleting it breaks something. "Written by the
  // `login` CLI" answers both halves of that — what put it here, and what puts it
  // back. A line naming the wrong CLI sends them to run a command that does not
  // recreate the file; no line at all leaves a bare secret with no provenance, and
  // the usual response to a secret of unknown origin is to leave it in place.
  //
  // Order is behaviour too, not formatting: the first line says what the file is,
  // and the second says what to do about it. Read the other way round, "keep this
  // private" arrives before the reader knows what "this" is.
  //
  // Neither line has a second audience. No branch in this module or any other
  // reads them back — dotenv skips `#` lines — so nothing in the suite runs
  // differently when they change (CC-PROC-81).
  const configDir = await tempConfigDir();
  const header = [
    '# instagram-mcp-ai credentials — written by the `login` CLI.',
    '# Keep private (chmod 0600); never commit this file.',
  ];
  const creds = { accessToken: LONG_TOKEN, authPath: 'ig-login' } as const;

  const res = await writeCredentials('default', creds, { configDir });
  const fresh = (await readFile(res.path, 'utf8')).split('\n');
  assert.deepEqual(
    fresh.slice(0, 2),
    header,
    'a fresh file opens with both header lines, in order',
  );

  await writeCredentials('default', creds, { configDir });
  const rewritten = (await readFile(res.path, 'utf8')).split('\n');
  assert.deepEqual(rewritten.slice(0, 2), header, 'a rewrite leaves the block where it was');
  assert.deepEqual(
    rewritten.filter((l) => l.startsWith('#')),
    header,
    'and adds no second copy of either line, nor any other comment',
  );
});

test('a file that already had content is never given the header', async () => {
  // The header states where the file came from. A file the operator wrote by hand
  // did not come from the `login` CLI, and stamping that claim onto their file
  // would be false at exactly the moment it is read as authoritative. The merge
  // therefore writes the block only when it creates the file itself.
  const configDir = await tempConfigDir();
  const filePath = envFileIn(configDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'IG_PROFILE_LABEL=hand-written\n', 'utf8');

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  const merged = await readFile(filePath, 'utf8');

  assert.equal(merged.includes('written by the `login` CLI'), false, 'no provenance claim');
  assert.equal(merged.includes('# Keep private'), false, 'and no second line of the block');
  assert.equal(
    merged.startsWith('IG_PROFILE_LABEL=hand-written\n'),
    true,
    'their line stays first',
  );
});

// --- Profile names the env scheme cannot read back ---------------------------

test('a profile name that cannot read back is refused, and nothing is written', async () => {
  // `envVarFor` upper-cases the name and `config.ts` lower-cases it back, through
  // dotenv's `[\w.-]` key class. `my brand` yields a key dotenv never reads, so the
  // token used to land on disk while the profile did not exist; `straße` upper-cases
  // to `STRASSE` and came back as a DIFFERENT profile, `strasse`. Either way the
  // login reported success for an account the server then could not find.
  const cases = ['my brand', 'Straße', 'brand=x', 'brand#x', 'brand/x'];
  for (const profile of cases) {
    const configDir = await tempConfigDir();
    await assert.rejects(
      writeCredentials(profile, { accessToken: LONG_TOKEN, authPath: 'ig-login' }, { configDir }),
      (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(err.kind, 'validation');
        assert.equal(
          err.message,
          `Profile name ${JSON.stringify(profile.toLowerCase())} cannot be stored: use only ` +
            'letters, digits, "_", "." and "-"',
        );
        assert.ok(!err.message.includes(LONG_TOKEN), 'the token is never echoed');
        return true;
      },
    );
    await assert.rejects(stat(envFileIn(configDir)), { code: 'ENOENT' }, `${profile}: no store`);
  }
});

test('a hyphenated or dotted profile is updated in place, no stale token left', async () => {
  // Hyphenated names are supported on purpose (CC-AUTH-18), and dotenv reads the
  // key. The merge's own key pattern did not, so it never recognised the line it
  // had written: a second login appended a new assignment and kept the old one,
  // leaving the superseded token in the file in plaintext.
  for (const profile of ['Second-Studio', 'eu.brand']) {
    const configDir = await tempConfigDir();
    await writeCredentials(
      'default',
      { accessToken: 'default-token', authPath: 'ig-login' },
      { configDir },
    );
    const creds = { authPath: 'ig-login' as const, accountId: '17841400000000001' };
    await writeCredentials(profile, { ...creds, accessToken: 'first-token' }, { configDir });
    const res = await writeCredentials(
      profile,
      { ...creds, accessToken: LONG_TOKEN },
      { configDir },
    );

    const text = await readFile(res.path, 'utf8');
    assert.ok(!text.includes('first-token'), `${profile}: the superseded token is gone`);
    const key = `IG_PROFILE_${profile.toUpperCase()}_ACCESS_TOKEN`;
    assert.equal(text.split('\n').filter((line) => line.startsWith(`${key}=`)).length, 1);
    const loaded = loadProfiles(await parseEnvFile(res.path)).profiles;
    const named = loaded.find((p) => p.name === profile.toLowerCase());
    assert.equal(named?.accessToken, LONG_TOKEN, `${profile}: reads back as itself`);
  }
});

// --- Concurrent writers --------------------------------------------------------

test('two concurrent writes for different profiles both survive', async () => {
  // One file holds every profile, and each write is read-modify-write. Without a
  // lock both writers read the same old text and the second rename discards the
  // first writer's keys — a `login` for one account silently undoing a `refresh`
  // of another.
  const configDir = await tempConfigDir();
  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  await Promise.all(
    ['alpha', 'beta', 'gamma'].map((profile) =>
      writeCredentials(
        profile,
        { accessToken: `${profile}-token`, authPath: 'ig-login' },
        { configDir },
      ),
    ),
  );
  const envPath = envFileIn(configDir);
  const env = await parseEnvFile(envPath);
  assert.equal(env.IG_ACCESS_TOKEN, LONG_TOKEN);
  assert.equal(env.IG_PROFILE_ALPHA_ACCESS_TOKEN, 'alpha-token');
  assert.equal(env.IG_PROFILE_BETA_ACCESS_TOKEN, 'beta-token');
  assert.equal(env.IG_PROFILE_GAMMA_ACCESS_TOKEN, 'gamma-token');
  assert.deepEqual(await readdir(path.dirname(envPath)), ['.env'], 'the lock is released');
});

test('a held lock is waited on, then times out naming the lock, store untouched', async () => {
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: 'first-token', authPath: 'ig-login' },
    { configDir },
  );
  const before = await readFile(res.path, 'utf8');
  const lockPath = `${res.path}.lock`;
  await writeFile(lockPath, '', { mode: 0o600 });

  const started = Date.now();
  await assert.rejects(
    writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir, lockTimeoutMs: 60 },
    ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(err.kind, 'validation');
      assert.equal(
        err.message,
        `Cannot write the credential store at ${res.path}: its lock ${lockPath} is held by ` +
          'another writer and was not released within 60 ms; retry once any other login or ' +
          'refresh has finished, or delete the lock file if none is running',
      );
      return true;
    },
  );
  assert.ok(Date.now() - started >= 60, 'the writer waited for the lock');
  assert.equal(await readFile(res.path, 'utf8'), before, 'the store is untouched');
  assert.ok((await stat(lockPath)).isFile(), "another writer's lock is not removed");
});

test('a writer blocked on a lock proceeds once the holder releases it', async () => {
  const configDir = await tempConfigDir();
  const res = await writeCredentials(
    'default',
    { accessToken: 'first-token', authPath: 'ig-login' },
    { configDir },
  );
  const lockPath = `${res.path}.lock`;
  await writeFile(lockPath, '', { mode: 0o600 });

  const pending = writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(
    (await readFile(res.path, 'utf8')).includes('first-token'),
    'nothing is written while the lock is held',
  );
  await rm(lockPath);
  await pending;
  assert.equal((await parseEnvFile(res.path)).IG_ACCESS_TOKEN, LONG_TOKEN);
});

test('a stale lock from a crashed writer is cleared, not left to wedge logins', async () => {
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  await mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  const lockPath = `${envPath}.lock`;
  await writeFile(lockPath, '', { mode: 0o600 });
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(lockPath, anHourAgo, anHourAgo);

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir, lockTimeoutMs: 2000 },
  );
  assert.equal((await parseEnvFile(envPath)).IG_ACCESS_TOKEN, LONG_TOKEN);
  assert.deepEqual(await readdir(path.dirname(envPath)), ['.env'], 'the stale lock is gone');
});

test('a dangling lock link, which nothing could ever release, is cleared as stale', async () => {
  // `wx` refuses a dangling symlink (the NAME exists), while `stat` follows it and
  // finds nothing, so it has no age. Treating that as "held" would wedge every
  // write until the operator found the link by hand.
  if (process.platform === 'win32') return;
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  await mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  await symlink('no-such-target', `${envPath}.lock`);

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir, lockTimeoutMs: 2000 },
  );
  assert.equal((await parseEnvFile(envPath)).IG_ACCESS_TOKEN, LONG_TOKEN);
  assert.deepEqual(await readdir(path.dirname(envPath)), ['.env']);
});

/** A lock record naming `pid` on `host`, as a writer before CC-CFG-62 recorded itself. */
function lockRecord(pid: number, host: string): string {
  return `${pid}@${host}\n`;
}

/** A lock record naming `pid` on `host` with a nonce, as a writer records itself now. */
function noncedRecord(pid: number, host: string): string {
  return `${pid}@${host}@${crypto.randomBytes(16).toString('hex')}\n`;
}

/** The shape of the record THIS process writes into a lock it takes (CC-CFG-62). */
function ownRecordShape(): RegExp {
  const host = hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${process.pid}@${host}@[0-9a-f]{32}\\n$`);
}

/** The pid of a process that has already exited, so it names no live owner. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.ok(child.pid !== undefined && child.pid > 0, 'premise: the child ran');
  return child.pid;
}

/** Create the store directory and put `content` at its lock, `ageMs` old. */
async function plantLock(configDir: string, content: string, ageMs: number): Promise<string> {
  const envPath = envFileIn(configDir);
  await mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  const lockPath = `${envPath}${LOCK_SUFFIX}`;
  await writeFile(lockPath, content, { mode: 0o600 });
  const then = new Date(Date.now() - ageMs);
  await utimes(lockPath, then, then);
  return lockPath;
}

const AN_HOUR_MS = 60 * 60 * 1000;

test('a live writer slower than the stale age keeps its lock, and no profile is lost (CC-CFG-58)', async (t) => {
  // The lock used to be judged by age alone: a writer stalled past 30 s (a hung
  // fsync, a debugger pause) had it cleared under it, the next writer read the
  // store without the slow one's keys, and the slow one's rename then discarded
  // the next writer's token. Writer A is held inside its temp-file fsync while
  // its lock is aged an hour; writer B must wait for A, not take the lock.
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  const lockPath = `${envPath}${LOCK_SUFFIX}`;
  const proto = await fileHandlePrototype();
  const original = proto.sync;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  t.mock.method(proto, 'sync', async function (this: unknown): Promise<void> {
    calls += 1;
    if (calls === 1) {
      entered();
      await gate;
    }
    return original.call(this);
  });

  const a = writeCredentials(
    'alpha',
    { accessToken: 'TEST_TOKEN_ALPHA', authPath: 'ig-login' },
    { configDir },
  );
  await inside;
  const record = await readFile(lockPath, 'utf8');
  const anHourAgo = new Date(Date.now() - AN_HOUR_MS);
  await utimes(lockPath, anHourAgo, anHourAgo);
  let bDone = false;
  const b = writeCredentials(
    'beta',
    { accessToken: 'TEST_TOKEN_BETA', authPath: 'ig-login' },
    { configDir },
  ).then((res) => {
    bDone = true;
    return res;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const bFinishedWhileAHeldTheLock = bDone;
  release();
  await Promise.all([a, b]);
  t.mock.restoreAll();

  const env = await parseEnvFile(envPath);
  assert.equal(env.IG_PROFILE_ALPHA_ACCESS_TOKEN, 'TEST_TOKEN_ALPHA');
  assert.equal(
    env.IG_PROFILE_BETA_ACCESS_TOKEN,
    'TEST_TOKEN_BETA',
    "B's token survives the slow writer",
  );
  assert.equal(bFinishedWhileAHeldTheLock, false, 'B waited for the live owner');
  assert.match(record, ownRecordShape(), 'the owner is recorded in the lock');
  assert.deepEqual(await readdir(path.dirname(envPath)), ['.env'], 'the lock is released');
});

test('a fresh lock whose owner has exited on this host is cleared at once (CC-CFG-58)', async () => {
  // Crash recovery no longer has to wait out the stale age: the owner's pid is
  // asked directly, and a pid the kernel no longer knows (ESRCH) frees the lock.
  const configDir = await tempConfigDir();
  const lockPath = await plantLock(configDir, lockRecord(deadPid(), hostname()), 0);
  const started = Date.now();
  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir, lockTimeoutMs: 2000 },
  );
  assert.ok(Date.now() - started < 1500, 'cleared at once, not after a timeout');
  assert.equal((await parseEnvFile(envFileIn(configDir))).IG_ACCESS_TOKEN, LONG_TOKEN);
  assert.equal(existsSync(lockPath), false);
});

test('an old lock whose owner still runs on this host is waited on, not stolen (CC-CFG-58)', async (t) => {
  // A running child is a live owner; pid 1 (init/launchd) is a live one we may
  // not signal (EPERM), which is alive all the same.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  assert.ok(child.pid !== undefined, 'premise: the child runs');
  const owners = process.platform === 'win32' ? [child.pid] : [child.pid, 1];
  for (const pid of owners) {
    const configDir = await tempConfigDir();
    const lockPath = await plantLock(configDir, lockRecord(pid, hostname()), AN_HOUR_MS);
    await assert.rejects(
      writeCredentials(
        'default',
        { accessToken: LONG_TOKEN, authPath: 'ig-login' },
        { configDir, lockTimeoutMs: 60 },
      ),
      (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.ok(
          err.message.includes(`its lock ${lockPath} is held by another writer`),
          err.message,
        );
        return true;
      },
    );
    assert.equal(await readFile(lockPath, 'utf8'), lockRecord(pid, hostname()), `pid ${pid}: kept`);
  }
});

test('a lock this process holds no longer is cleared even though its pid is alive (CC-CFG-58)', async () => {
  // A release that failed (CC-CFG-56), or a crashed predecessor that ran under
  // the same pid (a container's pid 1), leaves a record naming THIS process. The
  // pid check alone would call it live until the process exits; the process
  // knows which locks it holds, so it is judged stale — at any age.
  const configDir = await tempConfigDir();
  const lockPath = await plantLock(configDir, lockRecord(process.pid, hostname()), 0);
  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir, lockTimeoutMs: 2000 },
  );
  assert.equal((await parseEnvFile(envFileIn(configDir))).IG_ACCESS_TOKEN, LONG_TOKEN);
  assert.equal(existsSync(lockPath), false);
});

/**
 * Run `run` with every `rm` of a lock file failing (EACCES) and every other `rm`
 * passed through, so a release leaves this process's own record behind.
 */
async function withLockReleaseFailing(
  t: {
    mock: { method: (obj: object, name: string, impl: unknown) => unknown; restoreAll: () => void };
  },
  run: () => Promise<void>,
): Promise<void> {
  const original = fsPromises.rm;
  t.mock.method(fsPromises, 'rm', async (target: string, opts?: object): Promise<void> => {
    if (String(target).endsWith(LOCK_SUFFIX)) {
      throw Object.assign(new Error('EACCES: permission denied, rm'), { code: 'EACCES' });
    }
    return original(target, opts);
  });
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

test('a lock whose release failed is no longer held, so the next write clears it at once (CC-CFG-58)', async (t) => {
  // The writer forgets a lock BEFORE releasing it, on the success path and on
  // the failure path alike. Otherwise a release that fails (CC-CFG-56) leaves a
  // record naming this live process that the process still believes it holds:
  // every later write in it would wait out its timeout on its own ghost.
  for (const failWrite of [false, true]) {
    const label = failWrite ? 'after a failed write' : 'after a successful write';
    const configDir = await tempConfigDir();
    const lockPath = `${envFileIn(configDir)}${LOCK_SUFFIX}`;
    await withLockReleaseFailing(t, async () => {
      if (!failWrite) {
        await writeCredentials(
          'default',
          { accessToken: LONG_TOKEN, authPath: 'ig-login' },
          { configDir },
        );
        return;
      }
      const proto = await fileHandlePrototype();
      t.mock.method(proto, 'sync', async (): Promise<void> => {
        throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
      });
      await assert.rejects(
        writeCredentials(
          'default',
          { accessToken: LONG_TOKEN, authPath: 'ig-login' },
          { configDir },
        ),
        (err: unknown) => isInstagramError(err),
      );
    });
    assert.match(
      await readFile(lockPath, 'utf8'),
      ownRecordShape(),
      `${label}: premise: the release failed and left this process's record`,
    );
    const started = Date.now();
    await writeCredentials(
      'second',
      { accessToken: 'TEST_TOKEN_SECOND', authPath: 'ig-login' },
      { configDir, lockTimeoutMs: 1500 },
    );
    assert.ok(Date.now() - started < 1000, `${label}: cleared at once, not after a timeout`);
    assert.equal(existsSync(lockPath), false, `${label}: the ghost lock is gone`);
  }
});

test('an old record naming a process group is cleared by age, never taken for a live owner (CC-CFG-58)', async () => {
  // `kill(0, 0)` and `kill(-1, 0)` succeed whenever the caller has a group (or
  // any process) to signal, so a record parsed as pid 0 or -1 would be "alive"
  // forever and wedge every writer. Unparsed, it falls back to the age.
  const host = hostname();
  for (const record of [`0@${host}\n`, `-1@${host}\n`, `00@${host}\n`]) {
    const configDir = await tempConfigDir();
    const lockPath = await plantLock(configDir, record, AN_HOUR_MS);
    await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir, lockTimeoutMs: 1500 },
    );
    assert.equal(existsSync(lockPath), false, `${JSON.stringify(record)}: cleared by age`);
  }
});

test('a lock recorded on another host is judged by its age alone (CC-CFG-58)', async () => {
  // A pid from another machine that shares the store means nothing here: a dead
  // pid there does not free a fresh lock, and a live pid does not pin an old one.
  const foreign = `not-${hostname()}`;
  const fresh = await tempConfigDir();
  const freshLock = await plantLock(fresh, lockRecord(deadPid(), foreign), 0);
  await assert.rejects(
    writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir: fresh, lockTimeoutMs: 60 },
    ),
    (err: unknown) => isInstagramError(err) && err.message.includes('is held by another writer'),
  );
  assert.ok(existsSync(freshLock), 'a fresh foreign lock is kept');

  const old = await tempConfigDir();
  const oldLock = await plantLock(old, lockRecord(process.pid, foreign), AN_HOUR_MS);
  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir: old, lockTimeoutMs: 2000 },
  );
  assert.equal(existsSync(oldLock), false, 'an old foreign lock is cleared');
});

test('a malformed or group-addressing record falls back to the age (CC-CFG-58)', async () => {
  // `kill(0)` and `kill(-n)` signal process GROUPS, which always exist, so such a
  // record must not be parsed as an owner; nor may a record missing its newline.
  const host = hostname();
  for (const record of [`0@${host}\n`, `-1@${host}\n`, `${deadPid()}@${host}`, 'garbage\n']) {
    const label = JSON.stringify(record);
    const configDir = await tempConfigDir();
    const lockPath = await plantLock(configDir, record, 0);
    await assert.rejects(
      writeCredentials(
        'default',
        { accessToken: LONG_TOKEN, authPath: 'ig-login' },
        { configDir, lockTimeoutMs: 60 },
      ),
      (err: unknown) => isInstagramError(err) && err.message.includes('is held by another writer'),
      label,
    );
    assert.ok(existsSync(lockPath), `${label}: a fresh lock is kept`);
  }
});

test('a lock whose owner record cannot be written is given back, the failure wrapped (CC-CFG-58)', async (t) => {
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  const proto = (await fileHandlePrototype()) as unknown as { writeFile: () => Promise<void> };
  t.mock.method(proto, 'writeFile', async (): Promise<void> => {
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  });
  await assert.rejects(
    writeCredentials('default', { accessToken: LONG_TOKEN, authPath: 'ig-login' }, { configDir }),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(err.kind, 'validation');
      assert.ok(
        err.message.startsWith(`Cannot write the credential store at ${envPath} (ENOSPC)`),
        err.message,
      );
      return true;
    },
  );
  t.mock.restoreAll();
  assert.deepEqual(await readdir(path.dirname(envPath)), [], 'no lock or store left behind');
});

test('a nonced lock record names its owner exactly as a bare one does (CC-CFG-62)', async (t) => {
  // The nonce must not blind the liveness check: read as part of the host name,
  // `pid@host@nonce` would be "another host" — a crashed writer's fresh lock
  // waited out, a live writer's old lock stolen, and a ghost of this process
  // (same pid, a nonce it no longer holds) left to time every write out.
  const host = hostname();
  const dead = await tempConfigDir();
  const deadLock = await plantLock(dead, noncedRecord(deadPid(), host), 0);
  const started = Date.now();
  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir: dead, lockTimeoutMs: 2000 },
  );
  assert.ok(Date.now() - started < 1500, 'a dead owner: cleared at once, not after a timeout');
  assert.equal(existsSync(deadLock), false, 'a dead owner: cleared');

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  assert.ok(child.pid !== undefined, 'premise: the child runs');
  const live = await tempConfigDir();
  const liveRecord = noncedRecord(child.pid, host);
  const liveLock = await plantLock(live, liveRecord, AN_HOUR_MS);
  await assert.rejects(
    writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir: live, lockTimeoutMs: 60 },
    ),
    (err: unknown) => isInstagramError(err) && err.message.includes('is held by another writer'),
  );
  assert.equal(await readFile(liveLock, 'utf8'), liveRecord, 'a live owner: waited on, kept');

  const ghost = await tempConfigDir();
  const ghostLock = await plantLock(ghost, noncedRecord(process.pid, host), 0);
  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir: ghost, lockTimeoutMs: 2000 },
  );
  assert.equal(existsSync(ghostLock), false, 'this pid with a nonce it does not hold: stale');
});

test("a writer whose lock was taken over does not release the new owner's lock (CC-CFG-62)", async (t) => {
  // Writer A stalls past the stale age; another writer judges A's lock stale
  // (another host, by age), clears it and takes its own. When A finishes it
  // used to `rm` the lock path blindly — deleting the new owner's lock and
  // letting a third writer in beside it. The release now removes only a lock
  // that still carries A's own record.
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  const lockPath = `${envPath}${LOCK_SUFFIX}`;
  const proto = await fileHandlePrototype();
  const original = proto.sync;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  t.mock.method(proto, 'sync', async function (this: unknown): Promise<void> {
    calls += 1;
    if (calls === 1) {
      entered();
      await gate;
    }
    return original.call(this);
  });

  const a = writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  await inside;
  const taker = noncedRecord(process.pid + 1, `not-${hostname()}`);
  await rm(lockPath);
  await writeFile(lockPath, taker, { mode: 0o600 });
  release();
  await a;
  t.mock.restoreAll();

  assert.equal((await parseEnvFile(envPath)).IG_ACCESS_TOKEN, LONG_TOKEN, 'A still wrote');
  assert.equal(await readFile(lockPath, 'utf8'), taker, "the new owner's lock survives");
});

test('a stale lock replaced between the judgement and the clear is not cleared (CC-CFG-62)', async (t) => {
  // Two writers judge the same old lock stale. The first clears it and takes a
  // fresh one; the second, already past its judgement, used to `rm` the path
  // anyway — deleting the first one's live lock, so both went on to write. The
  // clear now re-reads the record and removes the lock only if it is unchanged.
  const configDir = await tempConfigDir();
  const foreign = `not-${hostname()}`;
  const lockPath = await plantLock(configDir, lockRecord(process.pid, foreign), AN_HOUR_MS);
  const successor = noncedRecord(process.pid + 1, foreign);
  const realStat = fsPromises.stat;
  let swapped = false;
  t.mock.method(fsPromises, 'stat', async (target: string, opts?: object) => {
    const result = await realStat(target, opts as undefined);
    if (!swapped && String(target) === lockPath) {
      // The judgement sees the old lock; by the time it acts, it is replaced.
      swapped = true;
      await writeFile(lockPath, successor, { mode: 0o600 });
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      writeCredentials(
        'default',
        { accessToken: LONG_TOKEN, authPath: 'ig-login' },
        { configDir, lockTimeoutMs: 150 },
      ),
      (err: unknown) => isInstagramError(err) && err.message.includes('is held by another writer'),
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.ok(swapped, 'premise: the lock was replaced mid-judgement');
  assert.equal(await readFile(lockPath, 'utf8'), successor, "the successor's lock survives");
  assert.equal(existsSync(envFileIn(configDir)), false, 'nothing was written beside it');
});

// --- Value round-trip property, durability and lock release (CC-CFG-53..56) ---

/**
 * Values a credential field can plausibly receive from a CLI flag or a Graph
 * response, chosen for the characters dotenv and a shell treat specially: both
 * quote kinds, backticks, backslash escapes (`\n`, `\r`, trailing `\`), `#`, `=`,
 * `$`, tabs, non-ASCII, and CR/LF. Every one of them must read back verbatim
 * through dotenv + `loadProfiles`, in a store that already holds other keys.
 * {@link REFUSED_VALUES} holds the ones no quoting can carry for both readers.
 */
const ROUND_TRIP_VALUES = [
  "it's #1 = a; touch x",
  "line1\nline2 it's",
  'x $HOME ${USER} $(whoami) y',
  'back`tick # and $',
  'a = b == c',
  'C:\\dir\\sub\\',
  '#',
  '"double"',
  "'single'",
  '`tick`',
  'tab\there',
  'ünïcødé ✓ ключ',
  "cr\ronly and it's",
];

/**
 * Values holding a `'` or a CR/LF — which only dotenv's double-quoted form can
 * carry — together with one of `$`, `` ` ``, `"` or `\`, which a shell acts on
 * inside double quotes and dotenv cannot escape there (CC-CFG-59).
 */
const REFUSED_VALUES = [
  `it's "a" #1`,
  "it's\\n not a newline",
  `it's\\r and "q"`,
  `a'b"c#d`,
  "it's\\",
  "it's $HOME",
  "it's `touch x`",
  'line1\nline2 "q"',
  '\\\nbackslash then newline',
  'it\'s `x` "y" #1',
  'a\nb\\n',
  'a\n$b',
];

test('every tricky value round-trips through dotenv + loadProfiles, other keys untouched (CC-CFG-53)', async () => {
  for (const value of ROUND_TRIP_VALUES) {
    const configDir = await tempConfigDir();
    const envPath = envFileIn(configDir);
    await mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
    await writeFile(
      envPath,
      "# hand-edited\nIG_PROFILE_OTHER_ACCESS_TOKEN=TEST_TOKEN_OTHER\nIG_PROFILE_OTHER_APP_SECRET='keep me'\n",
      { mode: 0o600 },
    );
    await writeCredentials(
      'default',
      {
        accessToken: LONG_TOKEN,
        authPath: 'fb-login',
        accountId: value,
        appId: '1',
        appSecret: value,
      },
      { configDir },
    );
    const env = await parseEnvFile(envPath);
    const label = JSON.stringify(value);
    assert.equal(env.IG_ACCOUNT_ID, value, `account id round-trip failed for ${label}`);
    assert.equal(env.IG_APP_SECRET, value, `app secret round-trip failed for ${label}`);
    assert.equal(
      env.IG_PROFILE_OTHER_ACCESS_TOKEN,
      'TEST_TOKEN_OTHER',
      `${label}: other token kept`,
    );
    assert.equal(env.IG_PROFILE_OTHER_APP_SECRET, 'keep me', `${label}: other secret kept`);
    const loaded = loadProfiles(env).profiles.find((p) => p.name === 'default');
    assert.equal(loaded?.appSecret, value, `loadProfiles read-back failed for ${label}`);
  }
});

/** The refusal {@link writeCredentials} raises for {@link REFUSED_VALUES}. */
function unquotableMessage(filePath: string, keys: string): string {
  return (
    `Cannot write the credential store at ${filePath}: ${keys} holds a single quote or a ` +
    'line break together with one of $ ` " \\, which no env-file quoting keeps literal ' +
    'for both dotenv and a shell that sources the file, so nothing was written'
  );
}

test('a value no quoting keeps literal for dotenv and a shell is refused, key named, nothing written (CC-CFG-59)', async () => {
  // Every one of these was written before: in backticks (command substitution to
  // a shell that sources the store) or in double quotes (where `$`, a backtick
  // and `\` still act), or not at all when dotenv could not read it back either
  // (CC-CFG-53). The write now stops, naming the key and never the value.
  for (const value of REFUSED_VALUES) {
    const label = JSON.stringify(value);
    const configDir = await tempConfigDir();
    const first = await writeCredentials(
      'default',
      { accessToken: 'TEST_TOKEN_FIRST', authPath: 'ig-login' },
      { configDir },
    );
    const before = await readFile(first.path, 'utf8');
    await assert.rejects(
      writeCredentials(
        'default',
        { accessToken: LONG_TOKEN, authPath: 'ig-login', appSecret: value },
        { configDir },
      ),
      (err: unknown) => {
        assert.ok(isInstagramError(err), label);
        assert.equal(err.kind, 'validation');
        assert.equal(err.message, unquotableMessage(first.path, 'IG_APP_SECRET'), label);
        assert.ok(!err.message.includes(LONG_TOKEN), 'no secret in the message');
        return true;
      },
    );
    assert.equal(await readFile(first.path, 'utf8'), before, `${label}: untouched`);
    assert.deepEqual(await readdir(path.dirname(first.path)), ['.env'], 'no temp or lock left');
  }
});

test('every refused key is named, and the store directory is not even created (CC-CFG-59)', async () => {
  const configDir = await tempConfigDir();
  const storeDir = path.join(configDir, SERVER_DIR);
  await assert.rejects(
    writeCredentials(
      'brand',
      {
        accessToken: LONG_TOKEN,
        authPath: 'fb-login',
        accountId: "it's $HOME",
        appId: '1',
        appSecret: "it's `touch x`",
      },
      { configDir },
    ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(
        err.message,
        unquotableMessage(
          envFileIn(configDir),
          'IG_PROFILE_BRAND_ACCOUNT_ID, IG_PROFILE_BRAND_APP_SECRET',
        ),
      );
      return true;
    },
  );
  assert.equal(existsSync(storeDir), false, 'refused before the directory or lock is touched');
});

test('a sourced store assigns every accepted value literally and runs none of it (CC-CFG-59)', async () => {
  // `mergeEnv` keeps `export` because operators `source` the store (CC-PROC-176).
  // A value that went out in backticks, or in double quotes beside a backtick,
  // executed on that `source`: `'x'; touch f` became `` `'x'; touch f` ``. Every
  // accepted value is sourced by a real shell here, next to a canary file that
  // any executed text in the values would create.
  if (process.platform === 'win32') return;
  const values = ["'x'; touch CANARY", "a'b; touch CANARY #", ...ROUND_TRIP_VALUES];
  for (const value of values) {
    const label = JSON.stringify(value);
    const configDir = await tempConfigDir();
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'fb-login', appId: '1', appSecret: value },
      { configDir },
    );
    const out = execFileSync(
      '/bin/sh',
      ['-c', 'set -a; . "$1"; printf %s "$IG_APP_SECRET"', 'sh', res.path],
      {
        cwd: configDir,
        encoding: 'utf8',
      },
    );
    assert.equal(existsSync(path.join(configDir, 'CANARY')), false, `${label}: nothing ran`);
    // A CR/LF travels as the escape `\n` / `\r`, which a shell keeps as two
    // characters: a different value, never a command.
    const expected = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    assert.equal(out, expected, `${label}: the shell read a different value`);
    assert.equal((await parseEnvFile(res.path)).IG_APP_SECRET, value, `${label}: dotenv`);
  }
});

test('a quoted value that would swallow a later line is refused, not written corrupt (CC-CFG-53)', async () => {
  // dotenv's quoted forms skip a backslash-escaped quote, so `'trailing\'` does
  // not end at its own closing quote when a LATER line holds a `'` at its end: the
  // value runs on through that line, and the key behind it disappears. Judged line
  // by line the value is fine, which is why the check parses the whole file.
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  await mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  const original = "IG_ACCOUNT_ID=old\nIG_PROFILE_B_ACCESS_TOKEN=TEST_TOKEN_B'\n";
  await writeFile(envPath, original, { mode: 0o600 });

  await assert.rejects(
    writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: 'trailing\\' },
      { configDir },
    ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(err.kind, 'validation');
      assert.equal(
        err.message,
        `Cannot write the credential store at ${envPath}: IG_ACCOUNT_ID, ` +
          'IG_PROFILE_B_ACCESS_TOKEN would not read back as written, so nothing was ' +
          'written; a value holds characters the env-file format cannot carry, or a ' +
          'hand-edited line in the file runs into it',
      );
      return true;
    },
  );
  assert.equal(await readFile(envPath, 'utf8'), original, 'the store is untouched');
});

test('a key the merge brings to light is refused, even one this write never names (CC-CFG-53)', async () => {
  // The merge replaces a value on its line; a hand-quoted value that spans lines
  // leaves its tail behind as a line of its own. `FOO=bar"` was part of
  // IG_ACCOUNT_ID's value before and is a key of its own after — a key neither
  // in the old file nor in this write, which only the parsed-after side can show.
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  await mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  const original = 'IG_ACCOUNT_ID="old\nFOO=bar"\n';
  await writeFile(envPath, original, { mode: 0o600 });

  await assert.rejects(
    writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login', accountId: 'new' },
      { configDir },
    ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.ok(err.message.includes(`${envPath}: FOO would not read back`), err.message);
      return true;
    },
  );
  assert.equal(await readFile(envPath, 'utf8'), original, 'the store is untouched');
});

test('an entry already at the temp name is refused, not followed (CC-CFG-54)', async (t) => {
  // The temp sibling is created with `wx`. Opened with plain `w`, a symlink
  // planted at that name is followed and the whole credential set lands in its
  // target. The name is random, so `randomBytes` is pinned to predict it.
  if (process.platform === 'win32') return;
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  await mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  const bait = path.join(configDir, 'bait');
  await writeFile(bait, 'untouched\n');
  const fixed = Buffer.alloc(6, 0xab);
  await symlink(bait, `${envPath}.${fixed.toString('hex')}.tmp`);
  t.mock.method(crypto, 'randomBytes', () => fixed);
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      writeCredentials('default', { accessToken: LONG_TOKEN, authPath: 'ig-login' }, { configDir }),
      (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.ok(
          err.message.startsWith(`Cannot write the credential store at ${envPath} (EEXIST)`),
        );
        return true;
      },
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(
    await readFile(bait, 'utf8'),
    'untouched\n',
    'the symlink target never got the secrets',
  );
  assert.equal(existsSync(envPath), false, 'nothing was written');
});

/** The `FileHandle` prototype, whose `sync` the durability tests observe. */
async function fileHandlePrototype(): Promise<{ sync: () => Promise<void> }> {
  const handle = await open(import.meta.filename ?? process.argv[1] ?? '.', 'r');
  await handle.close();
  return Object.getPrototypeOf(handle) as { sync: () => Promise<void> };
}

test('the temp file is fsynced before the rename, and the directory after it (CC-CFG-54)', async (t) => {
  // A rename without a prior fsync can survive a power loss while the data it
  // points at does not: the store comes back zero-length, and every profile's
  // credentials are gone. Sampled inside `sync` itself: the first flush must see
  // the store still holding the OLD token, i.e. it happened before the rename.
  const configDir = await tempConfigDir();
  const first = await writeCredentials(
    'default',
    { accessToken: 'TEST_TOKEN_FIRST', authPath: 'ig-login' },
    { configDir },
  );
  const proto = await fileHandlePrototype();
  const original = proto.sync;
  const storeAtSync: string[] = [];
  t.mock.method(proto, 'sync', async function (this: unknown): Promise<void> {
    storeAtSync.push(readFileSync(first.path, 'utf8'));
    return original.call(this);
  });

  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  t.mock.restoreAll();

  const expected = process.platform === 'win32' ? 1 : 2;
  assert.equal(storeAtSync.length, expected, 'the file (and on POSIX the directory) is flushed');
  assert.ok(storeAtSync[0]?.includes('TEST_TOKEN_FIRST'), 'the file flush precedes the rename');
  if (expected === 2) assert.ok(storeAtSync[1]?.includes(LONG_TOKEN), 'the dir flush follows it');
  assert.equal((await parseEnvFile(first.path)).IG_ACCESS_TOKEN, LONG_TOKEN);
});

test('a failed file fsync aborts the write, wrapped, with the store and directory untouched (CC-CFG-54)', async (t) => {
  const configDir = await tempConfigDir();
  const first = await writeCredentials(
    'default',
    { accessToken: 'TEST_TOKEN_FIRST', authPath: 'ig-login' },
    { configDir },
  );
  const before = await readFile(first.path, 'utf8');
  const proto = await fileHandlePrototype();
  t.mock.method(proto, 'sync', async (): Promise<void> => {
    throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO', syscall: 'fsync' });
  });

  await assert.rejects(
    writeCredentials('default', { accessToken: LONG_TOKEN, authPath: 'ig-login' }, { configDir }),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(
        err.message,
        `Cannot write the credential store at ${first.path} (EIO): ` +
          'check free space and the permissions on its directory',
      );
      return true;
    },
  );
  t.mock.restoreAll();
  assert.equal(await readFile(first.path, 'utf8'), before, 'the store is untouched');
  assert.deepEqual(await readdir(path.dirname(first.path)), ['.env'], 'no temp or lock left');
});

test('a directory fsync the filesystem refuses does not fail a completed write (CC-CFG-54)', async (t) => {
  // The directory flush runs after the rename; some mounts answer it with EINVAL.
  if (process.platform === 'win32') return;
  const configDir = await tempConfigDir();
  const proto = await fileHandlePrototype();
  const original = proto.sync;
  let calls = 0;
  t.mock.method(proto, 'sync', async function (this: unknown): Promise<void> {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    return original.call(this);
  });

  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir },
  );
  t.mock.restoreAll();
  assert.equal(calls, 2, 'premise: the directory flush was attempted and refused');
  assert.equal((await parseEnvFile(res.path)).IG_ACCESS_TOKEN, LONG_TOKEN);
});

test('a stale lock that cannot be cleared fails at once, wrapped, not as a raw fs error (CC-CFG-55)', async () => {
  // A directory at the lock's name is refused by `wx` (EEXIST) and has an age, so
  // it is judged stale — but `rm` without `recursive` cannot remove it. That raw
  // ERR_FS_EISDIR used to escape `writeCredentials` unwrapped.
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  const lockPath = `${envPath}${LOCK_SUFFIX}`;
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lockPath, 'occupant'), '');
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(lockPath, anHourAgo, anHourAgo);

  const started = Date.now();
  await assert.rejects(
    writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir, lockTimeoutMs: 5000 },
    ),
    (err: unknown) => {
      assert.ok(isInstagramError(err), `expected an InstagramError, got ${String(err)}`);
      assert.equal(err.kind, 'validation');
      assert.ok(err.message.startsWith(`Cannot write the credential store at ${envPath} (`));
      return true;
    },
  );
  assert.ok(Date.now() - started < 4000, 'the failure is immediate, not a lock timeout');
  assert.equal(existsSync(envPath), false, 'nothing was written');
});

test('a lock that cannot be released after a successful write does not fail the write (CC-CFG-56)', async () => {
  // The store has already been replaced when the release runs. Reporting that
  // as a failure makes the operator retry a `login` whose token is on disk. The
  // lock is swapped for a non-empty directory mid-write so its `rm` must fail.
  const configDir = await tempConfigDir();
  const storeDir = path.join(configDir, SERVER_DIR);
  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(storeDir, `.env${LOCK_SUFFIX}`);

  let swapped = false;
  let res: Awaited<ReturnType<typeof writeCredentials>> | undefined;
  await sampleStoreDuring(storeDir, async () => {
    const swap = (): void => {
      if (readdirSync(storeDir).some(isTempSibling)) {
        rmSync(lockPath, { force: true });
        mkdirSync(lockPath);
        writeFileSync(path.join(lockPath, 'occupant'), '');
        swapped = true;
        return;
      }
      setImmediate(swap);
    };
    setImmediate(swap);
    res = await writeCredentials(
      'default',
      { accessToken: PADDED_TOKEN, authPath: 'ig-login' },
      { configDir },
    );
  });

  assert.ok(swapped, 'premise: the lock was replaced while the write was in flight');
  assert.ok(res !== undefined);
  assert.equal((await parseEnvFile(res.path)).IG_ACCESS_TOKEN, PADDED_TOKEN, 'the save stands');
  assert.ok(statSync(lockPath).isDirectory(), 'premise: the release really failed');
});

// --- IG_ENV_FILE names the write target (CC-CFG-63) ------------------------
//
// With IG_ENV_FILE set, the server loads that file ALONE (src/index.ts), so it
// is the only place a written token is ever read from. Every test below also
// injects the platform's config-home variable at a temp directory: a writer that
// ignored IG_ENV_FILE lands there, never in the developer's real config home.

test('a non-blank absolute IG_ENV_FILE is the file written, and the config home is untouched', async () => {
  const home = await tempConfigDir();
  const named = path.join(home, 'elsewhere', 'named.env');
  await mkdir(path.dirname(named), { recursive: true });
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login', expiresAtSec: 1_900_000_000 },
    { env: { ...configHomeEnv(home), IG_ENV_FILE: ` ${named}\n` } },
  );
  assert.equal(res.path, named, 'trimmed, as the server trims it');
  const parsed = await parseEnvFile(named);
  assert.equal(loadProfiles(parsed).profiles[0]?.accessToken, LONG_TOKEN);
  assert.equal(existsSync(envFileIn(home)), false, 'the config-home store was not written');
  assert.equal(existsSync(path.join(home, SERVER_DIR)), false, 'nor its directory created');
  if (process.platform !== 'win32') assert.equal(statSync(named).mode & 0o777, 0o600);
});

test('IG_ENV_FILE: the named file is merged in place, keeping what the operator put there', async () => {
  const home = await tempConfigDir();
  const named = path.join(home, 'named.env');
  await writeFile(named, '# mine\nIG_WRITE_MODE=enabled\nIG_ACCESS_TOKEN=old-fake-token\n');
  await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { env: { ...configHomeEnv(home), IG_ENV_FILE: named } },
  );
  const text = await readFile(named, 'utf8');
  assert.ok(text.startsWith('# mine\nIG_WRITE_MODE=enabled\n'), text);
  assert.equal(dotenv.parse(text).IG_ACCESS_TOKEN, LONG_TOKEN);
});

test('IG_ENV_FILE: the directory holding the named file is neither created nor re-permissioned', async () => {
  const home = await tempConfigDir();
  // A missing directory is the operator's to create: the write fails, wrapped,
  // instead of inventing a 0700 directory at a path the operator may have typoed.
  const missing = path.join(home, 'no-such-dir', 'named.env');
  await assert.rejects(
    () =>
      writeCredentials(
        'default',
        { accessToken: LONG_TOKEN, authPath: 'ig-login' },
        { env: { ...configHomeEnv(home), IG_ENV_FILE: missing } },
      ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.ok(err.message.includes(missing), err.message);
      assert.ok(!err.message.includes(LONG_TOKEN));
      return true;
    },
  );
  assert.equal(existsSync(path.dirname(missing)), false);
  assert.equal(existsSync(path.join(home, SERVER_DIR)), false);

  if (process.platform !== 'win32') {
    // A shared directory the operator chose keeps its mode: tightening it to
    // 0700 would lock out whatever else lives there.
    const shared = path.join(home, 'shared');
    await mkdir(shared);
    await chmod(shared, 0o755);
    await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { env: { ...configHomeEnv(home), IG_ENV_FILE: path.join(shared, 'named.env') } },
    );
    assert.equal(statSync(shared).mode & 0o777, 0o755);
    assert.equal(statSync(path.join(shared, 'named.env')).mode & 0o777, 0o600);
  }
});

test('a relative IG_ENV_FILE is refused before anything is written', async () => {
  // The server resolves IG_ENV_FILE against its client's cwd, not this shell's,
  // so a relative value names no file both sides agree on. A `~` inside a name
  // is an ordinary character, so `a~/x` is relative too; a LEADING `~` is the
  // home directory, which both sides now expand (CC-CFG-66).
  //
  // It runs in a throwaway cwd (CC-CFG-70): a mutant that drops the refusal
  // writes a live 0600 `relative.env` into whatever directory the suite runs
  // from, and that file outlives the run — measured, in the repository root.
  const home = await tempConfigDir();
  const cwd = await tempConfigDir();
  const savedCwd = process.cwd();
  process.chdir(cwd);
  try {
    for (const value of ['relative.env', './relative.env', 'a~/relative.env']) {
      await assert.rejects(
        () =>
          writeCredentials(
            'default',
            { accessToken: LONG_TOKEN, authPath: 'ig-login' },
            { env: { ...configHomeEnv(home), IG_ENV_FILE: value } },
          ),
        (err: unknown) => {
          assert.ok(isInstagramError(err), value);
          assert.equal(err.kind, 'validation', value);
          assert.equal(err.message, relativeEnvFileRefusal(value));
          return true;
        },
      );
    }
    assert.equal(existsSync(path.join(home, SERVER_DIR)), false);
    assert.deepEqual(await readdir(cwd), [], 'nothing was written relative to the cwd');
  } finally {
    process.chdir(savedCwd);
  }
});

/** The refusal `namedEnvFile` raises for a relative `IG_ENV_FILE` (CC-CFG-70). */
function relativeEnvFileRefusal(value: string): string {
  return (
    `IG_ENV_FILE is set to ${JSON.stringify(value)}, which is not an absolute file name. A ` +
    'relative name is resolved against the working directory of whichever process reads ' +
    'it — for the server, the directory its MCP client starts it in — so the server and ' +
    'login / refresh could each use a different file; set IG_ENV_FILE to an absolute file ' +
    'name (a leading "~" is the home directory) and try again.'
  );
}

test('a relative IG_ENV_FILE is refused by the one reading the server and the writer share (CC-CFG-70)', () => {
  // The entry used to hand a relative value to dotenv, which read it against the
  // cwd its MCP client chose, while the writer refused the same value: the
  // server started on a file `login` / `refresh` would never update. The refusal
  // now lives in `namedEnvFile`, so both sides stop on the same rule — and the
  // entry stops at start-up, before it serves anything from a file it cannot name.
  for (const value of ['relative.env', './relative.env', '../up.env', 'a~/relative.env']) {
    assert.throws(
      () => namedEnvFile({ IG_ENV_FILE: ` ${value}\n` }),
      (err: unknown) => {
        assert.ok(isInstagramError(err), value);
        assert.equal(err.kind, 'validation', value);
        assert.equal(err.message, relativeEnvFileRefusal(value));
        return true;
      },
    );
  }
  const absolute = path.join(tmpdir(), 'named.env');
  assert.equal(namedEnvFile({ IG_ENV_FILE: absolute }), absolute, 'an absolute name passes');
});

test('a blank IG_ENV_FILE is unset, as the server reads it: the config-home store is written', async () => {
  const home = await tempConfigDir();
  for (const blank of ['', '  \n']) {
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { env: { ...configHomeEnv(home), IG_ENV_FILE: blank } },
    );
    assert.equal(res.path, envFileIn(home));
  }
});

test('an explicit configDir wins over IG_ENV_FILE', async () => {
  const configDir = await tempConfigDir();
  const named = path.join(configDir, 'named.env');
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir, env: { IG_ENV_FILE: named } },
  );
  assert.equal(res.path, envFileIn(configDir));
  assert.equal(existsSync(named), false);
});

test('a blank configDir does not shadow IG_ENV_FILE', async () => {
  const home = await tempConfigDir();
  const named = path.join(home, 'named.env');
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir: ' ', env: { ...configHomeEnv(home), IG_ENV_FILE: named } },
  );
  assert.equal(res.path, named);
});

// --- IG_ENV_FILE home-directory spellings (CC-CFG-66, CC-CFG-67) -----
//
// An MCP client's JSON `env` hands `IG_ENV_FILE=~/x.env` over verbatim, where a
// shell would have expanded it. The entry read it as `<cwd>/~/x.env` and the
// writer refused it as relative, so the one variable that REPLACES the whole
// candidate list could not use the spelling every other store variable accepts
// (CC-CFG-60/64). Both sides now resolve it through `namedEnvFile`.

test('a ~ IG_ENV_FILE is the home directory’s file, for the reader and the writer alike (CC-CFG-66)', async () => {
  await withTempHomeAndCwd(async (home) => {
    const named = path.join(home, 'cfg', 'named.env');
    await mkdir(path.dirname(named));
    assert.equal(namedEnvFile({ IG_ENV_FILE: ' ~/cfg/named.env\n' }), named, 'trimmed first');
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { env: { ...configHomeEnv(home), IG_ENV_FILE: '~/cfg/named.env' } },
    );
    assert.equal(res.path, named);
    assert.equal(loadProfiles(await parseEnvFile(named)).profiles[0]?.accessToken, LONG_TOKEN);
    assert.equal(existsSync(path.join(home, SERVER_DIR)), false, 'the config home is untouched');
  });
  // Unset and blank name no file, exactly as the entry reads them.
  assert.equal(namedEnvFile({}), undefined);
  assert.equal(namedEnvFile({ IG_ENV_FILE: ' \n' }), undefined);
});

test('an IG_ENV_FILE only a shell could expand is refused, naming the variable (CC-CFG-67)', async () => {
  const home = await tempConfigDir();
  for (const value of [
    '~root/x.env',
    '~+/x.env',
    '$HOME/x.env',
    '${HOME}/x.env',
    '%APPDATA%\\x.env',
  ]) {
    const refusedWith = (err: unknown): boolean => {
      assert.ok(isInstagramError(err), value);
      assert.equal(err.kind, 'validation', value);
      assert.equal(
        err.message,
        `IG_ENV_FILE is ${JSON.stringify(value)}, which only a shell can expand — it is not a ` +
          'path this server can use to find the credential store; set it to an absolute path',
      );
      return true;
    };
    assert.throws(() => namedEnvFile({ IG_ENV_FILE: ` ${value} ` }), refusedWith);
    await assert.rejects(
      writeCredentials(
        'default',
        { accessToken: LONG_TOKEN, authPath: 'ig-login' },
        { env: { ...configHomeEnv(home), IG_ENV_FILE: value } },
      ),
      refusedWith,
    );
  }
  assert.deepEqual(await readdir(home), [], 'nothing was written anywhere');
});

// --- A symlinked store is written through the link (CC-CFG-68) ----------
//
// The reader (dotenv, `readExisting`) always followed a symlinked store, but the
// rename replaced the LINK with a regular file: a store kept in a dotfiles repo
// and linked into place stopped receiving tokens after the first `login`, and
// two links to one file each took their own lock. Symlinks need a privilege on
// Windows, so these run on POSIX only.

const posixOnly = { skip: process.platform === 'win32' };

/** A regular store file in its own 0755 directory, plus a directory to link from. */
async function linkedStore(): Promise<{ root: string; target: string }> {
  const root = await tempConfigDir();
  const dotfiles = path.join(root, 'dotfiles');
  await mkdir(dotfiles);
  await chmod(dotfiles, 0o755);
  const target = path.join(dotfiles, 'ig.env');
  await writeFile(target, '# kept in dotfiles\nIG_WRITE_MODE=enabled\n', { mode: 0o644 });
  return { root, target };
}

test(
  'a symlinked config-home store keeps its link: the target receives the write (CC-CFG-68)',
  posixOnly,
  async () => {
    const { root, target } = await linkedStore();
    const linkPath = envFileIn(root);
    await mkdir(path.dirname(linkPath), { mode: 0o755 });
    await symlink(target, linkPath);
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { configDir: root },
    );
    const real = await realpath(target);
    assert.equal(res.path, real, 'the file actually written is the one reported');
    assert.ok((await lstat(linkPath)).isSymbolicLink(), 'the link is still a link');
    const text = await readFile(target, 'utf8');
    assert.ok(text.startsWith('# kept in dotfiles\nIG_WRITE_MODE=enabled\n'), text);
    assert.equal(dotenv.parse(text).IG_ACCESS_TOKEN, LONG_TOKEN);
    assert.equal(statSync(target).mode & 0o777, 0o600, 'the target is tightened to 0600');
    // The config-home directory is still ours to secure; the target's is not.
    assert.equal(statSync(path.dirname(linkPath)).mode & 0o777, 0o700);
    assert.equal(statSync(path.dirname(target)).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(path.dirname(target)), ['ig.env'], 'no temp or lock left');
    assert.deepEqual(await readdir(path.dirname(linkPath)), ['.env']);
  },
);

test(
  'an IG_ENV_FILE that is a relative symlink is written through it too (CC-CFG-68)',
  posixOnly,
  async () => {
    const { root, target } = await linkedStore();
    const named = path.join(root, 'named.env');
    await symlink(path.join('dotfiles', 'ig.env'), named);
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { env: { ...configHomeEnv(root), IG_ENV_FILE: named } },
    );
    assert.equal(res.path, await realpath(target));
    assert.ok((await lstat(named)).isSymbolicLink());
    assert.equal((await parseEnvFile(named)).IG_ACCESS_TOKEN, LONG_TOKEN, 'read back via the link');
  },
);

test(
  'two links to one store share its lock, which sits beside the target (CC-CFG-68)',
  posixOnly,
  async () => {
    // A lock beside each LINK would let a writer through each name at once, and
    // the later rename would discard the other writer's profile.
    const { root, target } = await linkedStore();
    const named = path.join(root, 'named.env');
    await symlink(target, named);
    const real = await realpath(target);
    // A live owner (this test's parent process) holds the target's lock.
    await writeFile(`${real}${LOCK_SUFFIX}`, lockRecord(process.ppid, hostname()), { mode: 0o600 });
    await assert.rejects(
      writeCredentials(
        'default',
        { accessToken: LONG_TOKEN, authPath: 'ig-login' },
        { env: { ...configHomeEnv(root), IG_ENV_FILE: named }, lockTimeoutMs: 60 },
      ),
      (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.ok(err.message.includes(`its lock ${real}${LOCK_SUFFIX} is held`), err.message);
        return true;
      },
    );
    assert.equal(existsSync(`${named}${LOCK_SUFFIX}`), false, 'no second lock beside the link');
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, undefined);
  },
);

test(
  'a dangling store link is refused, and nothing is created where it points (CC-CFG-68)',
  posixOnly,
  async () => {
    const root = await tempConfigDir();
    const named = path.join(root, 'named.env');
    const nowhere = path.join(root, 'nowhere', 'ig.env');
    await symlink(nowhere, named);
    await assert.rejects(
      writeCredentials(
        'default',
        { accessToken: LONG_TOKEN, authPath: 'ig-login' },
        { env: { ...configHomeEnv(root), IG_ENV_FILE: named } },
      ),
      (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(err.kind, 'validation');
        assert.equal(
          err.message,
          `Cannot write the credential store at ${named}: it is a symbolic link whose target ` +
            'does not exist; create the target file, or replace the link with a regular file',
        );
        return true;
      },
    );
    assert.ok((await lstat(named)).isSymbolicLink(), 'the link is left as it was');
    assert.equal(existsSync(path.dirname(nowhere)), false);
  },
);

test(
  'a store link owned by another user is refused rather than followed (CC-CFG-68)',
  posixOnly,
  async (t) => {
    // Whoever can plant a link at the store's name would otherwise choose which of
    // our files receives the credentials. The owner cannot be changed without
    // privileges, so the current uid is moved instead.
    const { root, target } = await linkedStore();
    const named = path.join(root, 'named.env');
    await symlink(target, named);
    const ownUid = (await lstat(named)).uid;
    t.mock.property(process, 'getuid', () => ownUid + 1);
    await assert.rejects(
      writeCredentials(
        'default',
        { accessToken: LONG_TOKEN, authPath: 'ig-login' },
        { env: { ...configHomeEnv(root), IG_ENV_FILE: named } },
      ),
      (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(err.kind, 'validation');
        assert.equal(
          err.message,
          `Cannot write the credential store at ${named}: it is a symbolic link owned by ` +
            'another user, so it is not followed; replace it with a regular file or a link ' +
            'of your own',
        );
        return true;
      },
    );
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, undefined);
    assert.ok((await lstat(named)).isSymbolicLink());
  },
);

test(
  'where no uid exists (Windows) a store link is followed without the owner check (CC-CFG-68)',
  posixOnly,
  async (t) => {
    const { root, target } = await linkedStore();
    const named = path.join(root, 'named.env');
    await symlink(target, named);
    t.mock.property(process, 'getuid', undefined);
    await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { env: { ...configHomeEnv(root), IG_ENV_FILE: named } },
    );
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, LONG_TOKEN);
  },
);

// --- A home directory that is not absolute (CC-CFG-69) ---------------------
//
// `os.homedir()` returns `$HOME` (`%USERPROFILE%`) verbatim whenever it is set.
// Blank or relative, it made every home-derived store path RELATIVE: the default
// `~/.config` and every `~` spelling followed the cwd, so `HOME="   "` with a `~`
// config dir wrote `<cwd>/   /instagram-mcp-ai/.env`.

test('a home directory that is not absolute stops the write before anything lands under the cwd (CC-CFG-69)', async () => {
  const base = await makeTempConfigHome('igmcp-relhome-');
  const cwd = path.join(base, 'cwd');
  await mkdir(cwd);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const savedCwd = process.cwd();
  const variable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const homeVar = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
  process.chdir(cwd);
  try {
    for (const home of ['   ', 'rel']) {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      assert.equal(homedir(), home, 'premise: the home directory follows the environment');
      const refusedWith = (err: unknown): boolean => {
        assert.ok(isInstagramError(err), home);
        assert.equal(err.kind, 'validation', home);
        assert.equal(
          err.message,
          `the home directory is ${JSON.stringify(home)} (from ${variable}), which is not an ` +
            'absolute path, so a file under it would be looked for in whatever directory the ' +
            `process was started from; set ${variable} to an absolute path`,
        );
        return true;
      };
      for (const opts of [
        { configDir: '~' },
        { configDir: '~/cfg' },
        { env: {} },
        { env: { [homeVar]: '   ' } },
        { env: { [homeVar]: 'relative/cfg' } },
        { env: { [homeVar]: '~/cfg' } },
        { env: { IG_ENV_FILE: '~/ig.env' } },
      ]) {
        await assert.rejects(
          writeCredentials('default', { accessToken: LONG_TOKEN, authPath: 'ig-login' }, opts),
          refusedWith,
        );
      }
      assert.throws(() => resolveConfigHome({}), refusedWith);
      assert.throws(() => namedEnvFile({ IG_ENV_FILE: '~/ig.env' }), refusedWith);
      // The Windows fallback (`%USERPROFILE%\\AppData\\Roaming`) is guarded too,
      // and names the variable Windows reads the home from.
      const real = Object.getOwnPropertyDescriptor(process, 'platform');
      assert.ok(real);
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        assert.throws(
          () => resolveConfigHome({}),
          (err: unknown) => isInstagramError(err) && err.message.includes('(from USERPROFILE)'),
        );
      } finally {
        Object.defineProperty(process, 'platform', real);
      }
    }
    assert.deepEqual(await readdir(cwd), [], 'nothing was written relative to the cwd');
  } finally {
    process.chdir(savedCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(base, { recursive: true, force: true });
  }
});

test('an absolute config home or IG_ENV_FILE does not consult the home directory at all (CC-CFG-69)', async () => {
  // The refusal is for a path that would follow the cwd, not for an odd `$HOME`:
  // a store named without the home directory is still written under one.
  const root = await tempConfigDir();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = '   ';
  process.env.USERPROFILE = '   ';
  try {
    const viaHome = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { env: configHomeEnv(root) },
    );
    assert.equal(viaHome.path, envFileIn(root));
    const named = path.join(root, 'named.env');
    const viaFile = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { env: { IG_ENV_FILE: named } },
    );
    assert.equal(viaFile.path, named);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// --- A symlinked store: every link judged, and re-checked under the lock ------
// (CC-CFG-72, CC-CFG-73)

test(
  'a store link re-pointed while the write waits for the lock is refused, not written (CC-CFG-72)',
  posixOnly,
  async (t) => {
    // The link was resolved before the lock was taken. A link re-pointed in
    // between sent the write to the file it USED to name, under a lock on that
    // file, while the name now reads another one: the fresh token went where no
    // read would find it. The name is now resolved again under the lock.
    const { root, target } = await linkedStore();
    const other = path.join(root, 'dotfiles', 'other.env');
    await writeFile(other, '# the other store\n', { mode: 0o644 });
    const named = path.join(root, 'named.env');
    await symlink(target, named);
    const first = await realpath(target);
    const second = await realpath(other);
    const realOpen = fsPromises.open;
    let repointed = false;
    t.mock.method(fsPromises, 'open', async (file: string, ...rest: unknown[]) => {
      if (!repointed && String(file) === `${first}${LOCK_SUFFIX}`) {
        repointed = true;
        await rm(named);
        await symlink(other, named);
      }
      return (realOpen as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        writeCredentials(
          'default',
          { accessToken: LONG_TOKEN, authPath: 'ig-login' },
          { env: { ...configHomeEnv(root), IG_ENV_FILE: named } },
        ),
        (err: unknown) => {
          assert.ok(isInstagramError(err));
          assert.equal(err.kind, 'validation');
          assert.equal(
            err.message,
            `Cannot write the credential store at ${named}: it named ${first} when this write ` +
              `began and names ${second} now that the write holds the lock, so nothing was ` +
              'written; run the command again',
          );
          return true;
        },
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.ok(repointed, 'premise: the link moved between the resolution and the lock');
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, undefined);
    assert.equal(await readFile(other, 'utf8'), '# the other store\n');
    assert.deepEqual((await readdir(path.dirname(target))).sort(), ['ig.env', 'other.env']);
  },
);

test(
  'a chain of links is written through to its last target, with the lock beside it (CC-CFG-73)',
  posixOnly,
  async () => {
    // A dotfiles manager can link a link (GNU Stow folding, a relinked checkout):
    // each hop is resolved against the directory the link sits in, the way the
    // kernel resolves it, and every link is kept.
    const { root, target } = await linkedStore();
    const middle = path.join(root, 'middle.env');
    await symlink(path.join('dotfiles', 'ig.env'), middle);
    const named = path.join(root, 'named.env');
    await symlink('middle.env', named);
    const res = await writeCredentials(
      'default',
      { accessToken: LONG_TOKEN, authPath: 'ig-login' },
      { env: { ...configHomeEnv(root), IG_ENV_FILE: named } },
    );
    assert.equal(res.path, await realpath(target));
    for (const link of [named, middle]) assert.ok((await lstat(link)).isSymbolicLink(), link);
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, LONG_TOKEN);
    assert.deepEqual(await readdir(path.dirname(target)), ['ig.env'], 'no temp or lock left');
  },
);

test(
  'a link owned by another user anywhere in the chain is refused, not only the first (CC-CFG-73)',
  posixOnly,
  async (t) => {
    // Only the name's own link was judged; `realpath` then followed every further
    // hop blind. Whoever owns a link in the middle of the chain chooses the file
    // as surely as whoever owns the first one. The owner cannot be changed without
    // privileges, so the middle link's reported owner is moved instead.
    const { root, target } = await linkedStore();
    const middle = path.join(root, 'middle.env');
    await symlink(target, middle);
    const named = path.join(root, 'named.env');
    await symlink(middle, named);
    const realLstat = fsPromises.lstat;
    t.mock.method(fsPromises, 'lstat', async (file: string, opts?: object) => {
      const entry = await realLstat(file, opts as undefined);
      if (String(file) !== middle) return entry;
      return Object.assign(Object.create(Object.getPrototypeOf(entry) as object) as object, entry, {
        uid: entry.uid + 1,
      });
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        writeCredentials(
          'default',
          { accessToken: LONG_TOKEN, authPath: 'ig-login' },
          { env: { ...configHomeEnv(root), IG_ENV_FILE: named } },
        ),
        (err: unknown) => {
          assert.ok(isInstagramError(err));
          assert.equal(err.kind, 'validation');
          assert.equal(
            err.message,
            `Cannot write the credential store at ${named}: the symbolic link ${middle} on the ` +
              'way to it is owned by another user, so it is not followed; replace it with a ' +
              'regular file or a link of your own',
          );
          return true;
        },
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, undefined);
  },
);

test(
  'a chain whose last link dangles is refused like a dangling name (CC-CFG-73)',
  posixOnly,
  async () => {
    const root = await tempConfigDir();
    const middle = path.join(root, 'middle.env');
    await symlink(path.join(root, 'nowhere', 'ig.env'), middle);
    const named = path.join(root, 'named.env');
    await symlink(middle, named);
    await assert.rejects(
      writeCredentials(
        'default',
        { accessToken: LONG_TOKEN, authPath: 'ig-login' },
        { env: { ...configHomeEnv(root), IG_ENV_FILE: named } },
      ),
      (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(
          err.message,
          `Cannot write the credential store at ${named}: it is a symbolic link whose target ` +
            'does not exist; create the target file, or replace the link with a regular file',
        );
        return true;
      },
    );
    assert.equal(existsSync(path.join(root, 'nowhere')), false);
  },
);

// --- Every directory on the way to the store is owner-checked (CC-CFG-74) ---
//
// Only the store's own link chain was judged. A symlinked DIRECTORY on the way —
// or a plain directory owned by someone else — was followed by the kernel
// unchecked, and whoever owns it can swap what lies beneath it, so they chose
// the file the credentials went to as surely as the owner of a store link.
// Every component is now walked the way the kernel walks it: owned by this user
// or by root is accepted (`/`, `/private`, macOS's `/var` link, `/tmp`); owned
// by any other uid is refused. Owners cannot be changed without privileges, so
// the tests move the owner `lstat` reports for one component instead.

/**
 * Report `owner` (a function of the real owner) for the `lstat` of every path
 * in `paths`, for the rest of the test.
 */
function mockOwner(
  t: { mock: { method: typeof test.mock.method } },
  paths: readonly string[],
  owner: (uid: number) => number,
): void {
  const realLstat = fsPromises.lstat;
  t.mock.method(fsPromises, 'lstat', async (file: string, opts?: object) => {
    const entry = await realLstat(file, opts as undefined);
    if (!paths.includes(String(file))) return entry;
    return Object.assign(Object.create(Object.getPrototypeOf(entry) as object) as object, entry, {
      uid: owner(entry.uid),
    });
  });
  syncBuiltinESMExports();
}

/** Undo {@link mockOwner}. */
function restoreOwner(t: { mock: { restoreAll: () => void } }): void {
  t.mock.restoreAll();
  syncBuiltinESMExports();
}

/** The refusal for a component owned by neither this user nor root. */
function foreignComponentMessage(store: string, component: string): string {
  return (
    `Cannot write the credential store at ${store}: the path component ${component} on the ` +
    'way to it is owned by another user, so the store is not written through it; keep the ' +
    'store under directories owned by you or by root'
  );
}

/** Write the default profile to the store `IG_ENV_FILE` names under `root`. */
function writeNamed(root: string, named: string): Promise<unknown> {
  return writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { env: { ...configHomeEnv(root), IG_ENV_FILE: named } },
  );
}

test(
  'a directory on the way to the store owned by another user is refused (CC-CFG-74)',
  posixOnly,
  async (t) => {
    const { root, target } = await linkedStore();
    const dotfiles = await realpath(path.dirname(target));
    mockOwner(t, [dotfiles], (uid) => uid + 1);
    try {
      await assert.rejects(writeNamed(root, target), (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(err.kind, 'validation');
        assert.equal(err.message, foreignComponentMessage(target, dotfiles));
        return true;
      });
    } finally {
      restoreOwner(t);
    }
    assert.equal(
      await readFile(target, 'utf8'),
      '# kept in dotfiles\nIG_WRITE_MODE=enabled\n',
      'nothing was written',
    );
    assert.deepEqual(await readdir(dotfiles), ['ig.env'], 'no lock or temp sibling');
  },
);

test(
  'a symlinked directory on the way to the store owned by another user is refused (CC-CFG-74)',
  posixOnly,
  async (t) => {
    const { root, target } = await linkedStore();
    const viaLink = path.join(root, 'linked');
    await symlink('dotfiles', viaLink);
    const linkComponent = path.join(await realpath(root), 'linked');
    mockOwner(t, [linkComponent], (uid) => uid + 1);
    const named = path.join(viaLink, 'ig.env');
    try {
      await assert.rejects(writeNamed(root, named), (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(err.message, foreignComponentMessage(named, linkComponent));
        return true;
      });
    } finally {
      restoreOwner(t);
    }
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, undefined);
  },
);

test(
  "a symlinked directory is judged by its target's owner too, not only by its own (CC-CFG-74)",
  posixOnly,
  async (t) => {
    // The link is ours; the directory it leads to is not.
    const { root, target } = await linkedStore();
    const viaLink = path.join(root, 'linked');
    await symlink(path.join(root, 'dotfiles'), viaLink);
    const dotfiles = await realpath(path.dirname(target));
    mockOwner(t, [dotfiles], (uid) => uid + 1);
    const named = path.join(viaLink, 'ig.env');
    try {
      await assert.rejects(writeNamed(root, named), (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(err.message, foreignComponentMessage(named, dotfiles));
        return true;
      });
    } finally {
      restoreOwner(t);
    }
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, undefined);
  },
);

test(
  'a directory owned by root on the way to the store is accepted (CC-CFG-74)',
  posixOnly,
  async (t) => {
    // `/`, `/private`, `/var` → `private/var` and `/tmp` are root's: refusing them
    // would refuse every store there is.
    if (process.getuid?.() === 0) return;
    const { root, target } = await linkedStore();
    const dotfiles = await realpath(path.dirname(target));
    mockOwner(t, [dotfiles], () => 0);
    try {
      await writeNamed(root, target);
    } finally {
      restoreOwner(t);
    }
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, LONG_TOKEN);
  },
);

test(
  'a directory link whose target climbs with ".." resolves the way the kernel does (CC-CFG-74)',
  posixOnly,
  async () => {
    // `a/up` → `../dotfiles` is relative to `a`, the directory holding the link,
    // and the `..` is taken from there — not from the link's own path.
    const { root, target } = await linkedStore();
    await mkdir(path.join(root, 'a'));
    await symlink(path.join('..', 'dotfiles'), path.join(root, 'a', 'up'));
    const named = path.join(root, 'named.env');
    await symlink(path.join('a', 'up', 'ig.env'), named);
    const res = (await writeNamed(root, named)) as { path: string };
    assert.equal(res.path, await realpath(target));
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, LONG_TOKEN);
    assert.deepEqual(await readdir(path.dirname(target)), ['ig.env'], 'no temp or lock left');
  },
);

test(
  'a directory link loop on the way to the store is a wrapped ELOOP (CC-CFG-74)',
  posixOnly,
  async () => {
    const root = await tempConfigDir();
    const loop = path.join(root, 'loop');
    await symlink('loop', loop);
    const named = path.join(loop, 'ig.env');
    await assert.rejects(writeNamed(root, named), (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(
        err.message,
        `Cannot read the credential store at ${named} (ELOOP): check the permissions on the ` +
          'file and its directory',
      );
      return true;
    });
  },
);

test(
  'a store directory created for the write is owner-checked under the lock (CC-CFG-74)',
  posixOnly,
  async (t) => {
    // Before the lock the config home's own directory does not exist yet, so
    // there is nothing to judge; it is judged under the lock, once it does.
    const root = await tempConfigDir();
    const storeDir = path.join(await realpath(root), SERVER_DIR);
    mockOwner(t, [storeDir], (uid) => uid + 1);
    try {
      await assert.rejects(
        writeCredentials(
          'default',
          { accessToken: LONG_TOKEN, authPath: 'ig-login' },
          { configDir: root },
        ),
        (err: unknown) => {
          assert.ok(isInstagramError(err));
          assert.equal(
            err.message,
            foreignComponentMessage(path.join(root, SERVER_DIR, '.env'), storeDir),
          );
          return true;
        },
      );
    } finally {
      restoreOwner(t);
    }
    assert.deepEqual(await readdir(storeDir), [], 'no store, lock or temp sibling');
  },
);

test(
  'a ".." in a store link target is climbed from where a directory link led, not cancelled (CC-CFG-74)',
  posixOnly,
  async () => {
    // `named.env` → `a/up/../ig.env`, `a/up` → `../dotfiles`: the kernel reaches
    // `dotfiles`, climbs to `root` and opens `root/ig.env`. Cancelling `up/..` as
    // text lands on `root/a/ig.env` instead — a file no reader opens.
    const { root } = await linkedStore();
    await mkdir(path.join(root, 'a'));
    await symlink(path.join('..', 'dotfiles'), path.join(root, 'a', 'up'));
    await writeFile(path.join(root, 'ig.env'), '# the one readers open\n', { mode: 0o600 });
    await writeFile(path.join(root, 'a', 'ig.env'), '# a decoy\n', { mode: 0o600 });
    const named = path.join(root, 'named.env');
    await symlink('a/up/../ig.env', named);
    const res = (await writeNamed(root, named)) as { path: string };
    assert.equal(res.path, path.join(await realpath(root), 'ig.env'));
    assert.equal(dotenv.parse(await readFile(named, 'utf8')).IG_ACCESS_TOKEN, LONG_TOKEN);
    assert.equal(await readFile(path.join(root, 'a', 'ig.env'), 'utf8'), '# a decoy\n');
  },
);

test(
  'an IG_ENV_FILE whose ".." follows a directory link is written where the entry reads it (CC-CFG-76)',
  posixOnly,
  async () => {
    // The entry opens IG_ENV_FILE as given, and the kernel climbs the `..` from
    // `dotfiles`, where `a/up` led; `path.normalize` cancelled `up/..` as text
    // and sent the token to `a/ig.env`, a file the server never loads.
    const { root } = await linkedStore();
    await mkdir(path.join(root, 'a'));
    await symlink(path.join('..', 'dotfiles'), path.join(root, 'a', 'up'));
    await writeFile(path.join(root, 'ig.env'), '# the one the entry loads\n', { mode: 0o600 });
    await writeFile(path.join(root, 'a', 'ig.env'), '# a decoy\n', { mode: 0o600 });
    const named = `${root}/a/up/../ig.env`;
    await writeNamed(root, named);
    assert.equal(dotenv.parse(await readFile(named, 'utf8')).IG_ACCESS_TOKEN, LONG_TOKEN);
    assert.equal(await readFile(path.join(root, 'a', 'ig.env'), 'utf8'), '# a decoy\n');
  },
);

test(
  'forty directory links on the way are walked and a forty-first is a loop (CC-CFG-74)',
  posixOnly,
  async (t) => {
    // The walk's own hop limit, measured at its edge: behind forty links the
    // walk still reaches `dotfiles` (whose owner is then judged), behind
    // forty-one it stops with ELOOP before getting there.
    const { target } = await linkedStore();
    const dotfiles = await realpath(path.dirname(target));
    const root = path.dirname(dotfiles);
    for (let i = 1; i <= 41; i += 1) {
      await symlink(i === 41 ? 'dotfiles' : `l${i + 1}`, path.join(root, `l${i}`));
    }
    mockOwner(t, [dotfiles], (uid) => uid + 1);
    try {
      const forty = path.join(root, 'l2', 'ig.env');
      await assert.rejects(writeNamed(root, forty), (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(err.message, foreignComponentMessage(forty, dotfiles));
        return true;
      });
      const fortyOne = path.join(root, 'l1', 'ig.env');
      await assert.rejects(writeNamed(root, fortyOne), (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.match(err.message, /\(ELOOP\)/);
        return true;
      });
    } finally {
      restoreOwner(t);
    }
  },
);

test(
  "a store link into another user's directory is refused at the last hop (CC-CFG-74)",
  posixOnly,
  async (t) => {
    const { root, target } = await linkedStore();
    const dotfiles = await realpath(path.dirname(target));
    const named = path.join(root, 'named.env');
    await symlink(path.join('dotfiles', 'ig.env'), named);
    mockOwner(t, [dotfiles], (uid) => uid + 1);
    try {
      await assert.rejects(writeNamed(root, named), (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(err.message, foreignComponentMessage(named, dotfiles));
        return true;
      });
    } finally {
      restoreOwner(t);
    }
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, undefined);
  },
);

test(
  'a link in the middle of a chain is judged by the directory holding it (CC-CFG-74)',
  posixOnly,
  async (t) => {
    // named.env → dotfiles/mid.env → ../other/ig.env: the file lands in a
    // directory of ours, but the hop that chose it sits in another user's.
    const { root, target } = await linkedStore();
    const dotfiles = await realpath(path.dirname(target));
    await mkdir(path.join(root, 'other'));
    await writeFile(path.join(root, 'other', 'ig.env'), '# ours\n', { mode: 0o600 });
    // Absolute, so the path the chain ends at never passes through `dotfiles`:
    // only the hop's own directory can be refused.
    await symlink(path.join(root, 'other', 'ig.env'), path.join(dotfiles, 'mid.env'));
    const named = path.join(root, 'named.env');
    await symlink(path.join('dotfiles', 'mid.env'), named);
    mockOwner(t, [dotfiles], (uid) => uid + 1);
    try {
      await assert.rejects(writeNamed(root, named), (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(err.message, foreignComponentMessage(named, dotfiles));
        return true;
      });
    } finally {
      restoreOwner(t);
    }
    assert.equal(await readFile(path.join(root, 'other', 'ig.env'), 'utf8'), '# ours\n');
  },
);

test(
  'where no uid exists (Windows) directories on the way are resolved, not judged (CC-CFG-74)',
  posixOnly,
  async (t) => {
    const { root, target } = await linkedStore();
    await symlink(path.join(root, 'dotfiles'), path.join(root, 'linked'));
    const named = path.join(root, 'named.env');
    await symlink(path.join(root, 'linked', 'ig.env'), named);
    t.mock.property(process, 'getuid', undefined);
    const res = (await writeNamed(root, named)) as { path: string };
    assert.equal(res.path, await realpath(target));
    assert.equal(dotenv.parse(await readFile(target, 'utf8')).IG_ACCESS_TOKEN, LONG_TOKEN);
  },
);
