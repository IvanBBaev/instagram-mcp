import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, loadSettings } from '../../src/core/settings.js';
import { InstagramError } from '../../src/core/types.js';

/** A validation `InstagramError` naming `variable` is thrown. */
function assertValidationError(fn: () => unknown, variable: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof InstagramError, 'expected an InstagramError');
    assert.equal(err.kind, 'validation');
    assert.match(err.message, new RegExp(variable));
    return true;
  });
}

test('empty env yields the canonical §12 defaults', () => {
  const s = loadSettings({});
  assert.deepEqual(s, {
    maxConcurrent: 4,
    maxItems: 200,
    refreshAfterDays: 45,
    timeoutMs: 30000,
    logLevel: 'info',
    prettyJson: false,
    writeMode: 'preview',
    allowDestructive: false,
    transport: 'stdio',
    httpHost: '127.0.0.1',
    httpPort: 3000,
  });
  // DEFAULT_SETTINGS mirrors the resolved defaults.
  assert.deepEqual(s, DEFAULT_SETTINGS);
});

test('blank / whitespace values fall back to defaults', () => {
  const s = loadSettings({
    IG_MAX_CONCURRENT: '',
    IG_LOG_LEVEL: '   ',
    IG_HTTP_HOST: '',
  });
  assert.equal(s.maxConcurrent, 4);
  assert.equal(s.logLevel, 'info');
  assert.equal(s.httpHost, '127.0.0.1');
});

test('numeric knobs are coerced and trimmed', () => {
  const s = loadSettings({
    IG_MAX_CONCURRENT: '8',
    IG_MAX_ITEMS: ' 500 ',
    IG_REFRESH_AFTER_DAYS: '30',
    IG_TIMEOUT_MS: '15000',
    IG_PORT: '8080',
  });
  assert.equal(s.maxConcurrent, 8);
  assert.equal(s.maxItems, 500);
  assert.equal(s.refreshAfterDays, 30);
  assert.equal(s.timeoutMs, 15000);
  assert.equal(s.httpPort, 8080);
});

test('the HTTP port comes from IG_PORT (not IG_HTTP_PORT)', () => {
  const fromCanonical = loadSettings({ IG_PORT: '4100' });
  assert.equal(fromCanonical.httpPort, 4100);
  // A non-canonical IG_HTTP_PORT is ignored — default stands.
  const ignored = loadSettings({ IG_HTTP_PORT: '4100' });
  assert.equal(ignored.httpPort, 3000);
});

test('boolean knobs accept true/false/1/0/yes/no/on/off (case-insensitive)', () => {
  assert.equal(loadSettings({ IG_PRETTY_JSON: 'true' }).prettyJson, true);
  assert.equal(loadSettings({ IG_PRETTY_JSON: 'TRUE' }).prettyJson, true);
  assert.equal(loadSettings({ IG_PRETTY_JSON: '1' }).prettyJson, true);
  assert.equal(loadSettings({ IG_PRETTY_JSON: 'yes' }).prettyJson, true);
  assert.equal(loadSettings({ IG_PRETTY_JSON: 'on' }).prettyJson, true);
  assert.equal(loadSettings({ IG_ALLOW_DESTRUCTIVE: 'false' }).allowDestructive, false);
  assert.equal(loadSettings({ IG_ALLOW_DESTRUCTIVE: '0' }).allowDestructive, false);
  assert.equal(loadSettings({ IG_ALLOW_DESTRUCTIVE: 'Off' }).allowDestructive, false);
});

test('enum knobs are validated against their allowed sets', () => {
  assert.equal(loadSettings({ IG_LOG_LEVEL: 'debug' }).logLevel, 'debug');
  assert.equal(loadSettings({ IG_WRITE_MODE: 'apply' }).writeMode, 'apply');
  assert.equal(loadSettings({ IG_TRANSPORT: 'http' }).transport, 'http');
});

test('httpHost is passed through verbatim (trimmed)', () => {
  assert.equal(loadSettings({ IG_HTTP_HOST: '0.0.0.0' }).httpHost, '0.0.0.0');
  assert.equal(loadSettings({ IG_HTTP_HOST: ' localhost ' }).httpHost, 'localhost');
});

test('non-numeric numeric input is rejected', () => {
  assertValidationError(() => loadSettings({ IG_MAX_ITEMS: 'abc' }), 'IG_MAX_ITEMS');
  assertValidationError(() => loadSettings({ IG_TIMEOUT_MS: '3.5' }), 'IG_TIMEOUT_MS');
  assertValidationError(() => loadSettings({ IG_MAX_CONCURRENT: '1e3' }), 'IG_MAX_CONCURRENT');
});

test('out-of-range numeric input is rejected', () => {
  assertValidationError(() => loadSettings({ IG_MAX_CONCURRENT: '0' }), 'IG_MAX_CONCURRENT');
  assertValidationError(() => loadSettings({ IG_MAX_CONCURRENT: '65' }), 'IG_MAX_CONCURRENT');
  assertValidationError(
    () => loadSettings({ IG_REFRESH_AFTER_DAYS: '61' }),
    'IG_REFRESH_AFTER_DAYS',
  );
  assertValidationError(() => loadSettings({ IG_PORT: '0' }), 'IG_PORT');
  assertValidationError(() => loadSettings({ IG_PORT: '70000' }), 'IG_PORT');
  assertValidationError(() => loadSettings({ IG_MAX_ITEMS: '-5' }), 'IG_MAX_ITEMS');
});

test('invalid enum input is rejected', () => {
  assertValidationError(() => loadSettings({ IG_LOG_LEVEL: 'trace' }), 'IG_LOG_LEVEL');
  assertValidationError(() => loadSettings({ IG_WRITE_MODE: 'force' }), 'IG_WRITE_MODE');
  assertValidationError(() => loadSettings({ IG_TRANSPORT: 'ws' }), 'IG_TRANSPORT');
});

test('invalid boolean input is rejected', () => {
  assertValidationError(() => loadSettings({ IG_PRETTY_JSON: 'maybe' }), 'IG_PRETTY_JSON');
  assertValidationError(() => loadSettings({ IG_ALLOW_DESTRUCTIVE: '2' }), 'IG_ALLOW_DESTRUCTIVE');
});

test('DEFAULT_SETTINGS is frozen', () => {
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
});
