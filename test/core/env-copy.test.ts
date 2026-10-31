import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config as dotenvConfig } from 'dotenv';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyEnv } from '../../src/core/env-copy.js';

test('off Windows the copy is an exact, case-sensitive spread', () => {
  const source: NodeJS.ProcessEnv = { ig_access_token: 'tok-lower', IG_HTTP_PORT: '8080' };
  const env = copyEnv(source, 'linux');
  assert.deepEqual(env, source);
  assert.equal(env.IG_ACCESS_TOKEN, undefined);
  env.IG_LOG_LEVEL = 'debug';
  assert.equal('IG_LOG_LEVEL' in source, false, 'the source is never written');
});

test('the default platform is the running one', () => {
  const env = copyEnv({ Mixed_Name: 'x' });
  assert.equal(env.MIXED_NAME === 'x', process.platform === 'win32');
});

test('on Windows a name matches in any case, as process.env does there', () => {
  const source = { ig_access_token: 'tok-lower', Path: 'C:\\bin' };
  const env = copyEnv(source, 'win32');
  assert.equal(env.IG_ACCESS_TOKEN, 'tok-lower');
  assert.equal(env.Ig_Access_Token, 'tok-lower');
  assert.equal('IG_ACCESS_TOKEN' in env, true);
  assert.equal(Object.hasOwn(env, 'iG_aCcEsS_tOkEn'), true);
  assert.deepEqual(Object.keys(env), ['IG_ACCESS_TOKEN', 'PATH']);
  assert.deepEqual({ ...env }, { IG_ACCESS_TOKEN: 'tok-lower', PATH: 'C:\\bin' });

  env.ig_log_level = 'debug';
  assert.equal(env.IG_LOG_LEVEL, 'debug');
  Object.defineProperty(env, 'ig_http_port', {
    value: '9',
    enumerable: true,
    configurable: true,
    writable: true,
  });
  assert.equal(env.IG_HTTP_PORT, '9');
  delete env.Ig_Access_Token;
  assert.equal(env.IG_ACCESS_TOKEN, undefined);
  assert.equal('ig_access_token' in env, false);
  assert.deepEqual(Object.keys(source), ['ig_access_token', 'Path'], 'the source is never written');

  const tag = Symbol('tag');
  (env as Record<symbol, unknown>)[tag] = 1;
  assert.equal((env as Record<symbol, unknown>)[tag], 1, 'a symbol key is not folded');
});

test('on Windows two spellings of one name keep the first value', () => {
  const env = copyEnv({ IG_ACCESS_TOKEN: 'first', ig_access_token: 'second' }, 'win32');
  assert.deepEqual({ ...env }, { IG_ACCESS_TOKEN: 'first' });
});

test('on Windows dotenv neither overrides a client name in another case nor hides a lower-case file key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-copy-'));
  try {
    const file = join(dir, '.env');
    writeFileSync(file, 'ig_access_token=tok-file\nig_app_id=55500\n');
    const env = copyEnv({ IG_ACCESS_TOKEN: 'tok-client' }, 'win32');
    dotenvConfig({ path: file, processEnv: env, override: false, quiet: true });
    assert.equal(env.IG_ACCESS_TOKEN, 'tok-client', 'the client value still wins');
    assert.equal(env.IG_APP_ID, '55500', 'a lower-case file key is read under the canonical name');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
