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
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

import { resolveConfigHome, writeCredentials } from '../../src/core/config-write.js';
import { loadProfiles } from '../../src/core/config.js';
import { isInstagramError } from '../../src/core/types.js';
import {
  SERVER_DIR,
  configHomeEnv,
  envFileIn,
  makeTempConfigHome,
} from '../helpers/config-home.js';

/** A distinctive, token-shaped secret so redaction assertions are meaningful. */
const LONG_TOKEN = 'EAAlongLIVEDtokenVALUE0123456789abcXYZsecretZZ';
const APP_SECRET = 'app-secret-value-0123456789abcdef';

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
  // string and read as "invalid credentials" at the first tool call.
  const cases = ["it's a token", 'line1\nline2', 'carriage\r\nreturn', `mixed ' and "quotes"`];
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

test('a read failure other than ENOENT propagates instead of silently overwriting', async () => {
  // Only "the file is not there yet" may be treated as empty content. Any other
  // read error (EISDIR, EACCES) means we cannot see what is already on disk —
  // continuing would replace an unread file, dropping the operator's other keys.
  const configDir = await tempConfigDir();
  const envPath = envFileIn(configDir);
  await mkdir(envPath, { recursive: true }); // the env "file" is a directory → EISDIR

  await assert.rejects(
    () =>
      writeCredentials('default', { accessToken: LONG_TOKEN, authPath: 'ig-login' }, { configDir }),
    (err: unknown) => (err as NodeJS.ErrnoException).code === 'EISDIR',
  );
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
    await assert.rejects(
      () =>
        writeCredentials(
          'default',
          { accessToken: LONG_TOKEN, authPath: 'ig-login' },
          { configDir },
        ),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'EACCES',
    );
    await chmod(envPath, 0o600);
    assert.equal(await readFile(envPath, 'utf8'), existing, 'the unread file is left untouched');
  } finally {
    await chmod(envPath, 0o600).catch(() => undefined);
  }
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
  // NON-OBSERVABLE SIBLINGS: `atomicWrite` narrows the mode THREE times — the
  // `writeFile` mode argument, the chmod on the temp file, and the chmod after the
  // rename — and any ONE of them alone is unobservable from outside. `rename`
  // preserves the inode, so all three land on the same file; chmod (unlike the
  // create mode) is not umask-masked, so whichever one runs last decides the end
  // state, and no assertion on the finished file can tell which of the other two
  // ran. Only the width of the window between `writeFile` and `rename` differs,
  // and observing that would need an `fs` seam this module deliberately does not
  // have — mocking the ESM builtin, failing the rename, a read-only parent, a
  // symlink/FIFO at the target, and fs watching were all tried and all observe
  // only the same end state. Removing TWO of the three IS observable, and the
  // umask-0o400 drive below is what catches it. They stay as defence in depth —
  // the final file is never momentarily group/world-readable.
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
  const home = await makeTempConfigHome('igmcp-blankdir-');
  const res = await writeCredentials(
    'default',
    { accessToken: LONG_TOKEN, authPath: 'ig-login' },
    { configDir: '   ', env: configHomeEnv(home) },
  );

  assert.equal(path.isAbsolute(res.path), true, 'a relative credential path is never acceptable');
  assert.equal(res.path, envFileIn(home));
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
      // It must name the missing field, not just say the input was bad.
      /access token is required/.test(err.message),
  );
});
