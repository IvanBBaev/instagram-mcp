import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_SETTINGS,
  SETTINGS_ENV_NAMES,
  isLoopbackHost,
  loadSettings,
} from '../../src/core/settings.js';
import { InstagramError, type Settings } from '../../src/core/types.js';

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
    // Spelled out rather than copied from DEFAULT_SETTINGS: this is the §12
    // default an operator gets with no XDG_STATE_HOME, and asserting it against
    // the same constant it is built from would prove nothing.
    writeJournal: join(homedir(), '.local', 'state', 'instagram-mcp-ai', 'writes.jsonl'),
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
  // `no` is the one falsy spelling the name promises that nothing else asserts —
  // and it is the one an operator reaches for when disabling a knob by hand. It
  // must not fall through to the "must be a boolean" error.
  assert.equal(loadSettings({ IG_ALLOW_DESTRUCTIVE: 'no' }).allowDestructive, false);
  assert.equal(loadSettings({ IG_ALLOW_DESTRUCTIVE: 'No' }).allowDestructive, false);
  assert.equal(loadSettings({ IG_ALLOW_DESTRUCTIVE: 'Off' }).allowDestructive, false);
});

test('enum knobs are validated against their allowed sets', () => {
  assert.equal(loadSettings({ IG_LOG_LEVEL: 'debug' }).logLevel, 'debug');
  assert.equal(loadSettings({ IG_WRITE_MODE: 'apply' }).writeMode, 'apply');
  assert.equal(loadSettings({ IG_TRANSPORT: 'http' }).transport, 'http');
});

test('a loopback httpHost is accepted (trimmed, verbatim)', () => {
  assert.equal(loadSettings({ IG_HTTP_HOST: ' localhost ' }).httpHost, 'localhost');
  assert.equal(loadSettings({ IG_HTTP_HOST: '127.0.0.1' }).httpHost, '127.0.0.1');
  assert.equal(loadSettings({ IG_HTTP_HOST: '127.0.0.53' }).httpHost, '127.0.0.53');
  assert.equal(loadSettings({ IG_HTTP_HOST: '::1' }).httpHost, '::1');
  assert.equal(loadSettings({ IG_HTTP_HOST: '[::1]' }).httpHost, '[::1]');
  // Verbatim means un-normalized, not merely un-rewritten: this exact string is
  // what the startup log and `doctor` echo back, so an operator can match the
  // line they read to the value they set. It is NOT what reaches `listen()` —
  // brackets are URL-authority grammar, not resolver input, and `[::1]` handed
  // straight to a bind raises `getaddrinfo ENOTFOUND [::1]`. Unwrapping belongs
  // to the transport, which needs both spellings anyway (CC-PROC-171): see
  // `bindAddressFor` and `allowedHostHeaders` in `src/mcp/transport.ts`.
  assert.equal(loadSettings({ IG_HTTP_HOST: 'LocalHost' }).httpHost, 'LocalHost');
});

test('a non-loopback IG_HTTP_HOST is rejected — the HTTP transport must not bind publicly', () => {
  // The whole write surface (post_image, delete_comment) rides this socket and
  // IG_HTTP_TOKEN is optional, so a public bind is refused at config load.
  for (const host of [
    '0.0.0.0',
    '::',
    '192.168.1.10',
    '10.0.0.7',
    'example.com',
    '127.0.0.1.evil.com',
  ]) {
    assertValidationError(() => loadSettings({ IG_HTTP_HOST: host }), 'IG_HTTP_HOST');
  }
});

test('isLoopbackHost accepts only loopback literals and 127.0.0.0/8', () => {
  for (const host of [
    'localhost',
    'LOCALHOST',
    ' 127.0.0.1 ',
    '127.255.255.254',
    '::1',
    '[::1]',
    // The expanded IPv6 loopback: what `getaddrinfo` and several container
    // runtimes hand back, and what an operator copying from `ss -ltn` pastes.
    // The literal set carries it precisely so those spellings are not a startup
    // refusal; nothing else asserts the two entries exist.
    '0:0:0:0:0:0:0:1',
    '[0:0:0:0:0:0:0:1]',
  ]) {
    assert.equal(isLoopbackHost(host), true, `${host} should be loopback`);
  }
  for (const host of [
    '0.0.0.0',
    '::',
    // The expanded wildcard — one character away from the expanded loopback
    // above, and the address that would publish the whole write surface.
    '0:0:0:0:0:0:0:0',
    '128.0.0.1',
    '127.0.0',
    // Five numeric octets: still all-digits and still `127.`-prefixed, so only
    // the exact-length check stands between it and "loopback". It is not an
    // address at all — accepting it turns a config typo into a bind-time crash
    // with no mention of IG_HTTP_HOST.
    '127.0.0.1.9',
    '127.0.0.256',
    // Refused by the octet-length rule, which accepts 1-3 digits: a four-digit
    // octet is not a dotted quad this checker will read. Note the rule is about
    // SHAPE, not range — `127.0.0.01` is accepted and this is not, though both
    // denote 127.0.0.1 under any reading a resolver would give them (CC-CFG-14).
    // That costs nothing today, because everything the rule does accept is
    // inside 127.0.0.0/8; it is recorded so the boundary stays a choice.
    '127.0.0.0001',
    'localhost.evil.com',
  ]) {
    assert.equal(isLoopbackHost(host), false, `${host} should NOT be loopback`);
  }
});

test('a numeric knob refuses every spelling `Number()` would coerce behind the operator’s back', () => {
  // Each of these coerces to an integer *inside* IG_MAX_ITEMS' 1–100000 range,
  // so nothing downstream would ever object: `1e3` would silently mean 1000,
  // `0x10` would mean 16, `1.0` would mean 1. The anchored digit shape is the
  // only thing standing between the operator and a limit they never typed —
  // unanchor it at either end, or drop it, and each of these becomes a quiet
  // acceptance instead of a startup refusal naming the variable.
  for (const raw of ['1e3', '2e2', '0x10', '0b101', '0o17', '1.0']) {
    assertValidationError(() => loadSettings({ IG_MAX_ITEMS: raw }), 'IG_MAX_ITEMS');
  }
});

test('the refusal names the real problem: a bad shape is not reported as a bad magnitude', () => {
  // Two diagnostics, and which one an operator reads decides what they do next.
  // "must be an integer" means *retype the value*; "must be a safe integer" is
  // reserved for a digit string past 2^53 and means *this number cannot be
  // represented exactly*. Telling someone who typed `IG_PORT=+` that their port
  // is too large to represent sends them hunting for a smaller number.
  for (const raw of ['+', '-', '++8', '+-8', 'abc', '3.5']) {
    assert.throws(
      () => loadSettings({ IG_PORT: raw }),
      (err: unknown) => {
        assert.ok(err instanceof InstagramError, 'expected an InstagramError');
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /^IG_PORT must be an integer, got /);
        return true;
      },
      `IG_PORT=${JSON.stringify(raw)} must be refused as a non-integer`,
    );
  }
  // The complement, so the two messages are pinned against each other instead of
  // one being asserted alone: only a genuinely oversized digit string earns the
  // "safe integer" wording.
  assert.throws(
    () => loadSettings({ IG_PORT: '99999999999999999999' }),
    (err: unknown) => {
      assert.ok(err instanceof InstagramError, 'expected an InstagramError');
      assert.match(err.message, /^IG_PORT must be a safe integer, got /);
      return true;
    },
  );
});

test('the 127. test is a prefix, not a substring — a routable address containing it stays public', () => {
  // `10.127.0.1` and `192.168.127.1` are ordinary routable addresses that happen
  // to carry the loopback prefix further along. Matching `127.` anywhere in the
  // string would call them loopback and bind the whole tool surface, writes
  // included, to an address every machine on the network can reach.
  for (const host of ['10.127.0.1', '192.168.127.1', '8.8.127.0', '1.127.0.1']) {
    assert.equal(isLoopbackHost(host), false, `${host} should NOT be loopback`);
    assertValidationError(() => loadSettings({ IG_HTTP_HOST: host }), 'IG_HTTP_HOST');
  }
});

test('non-numeric numeric input is rejected', () => {
  assertValidationError(() => loadSettings({ IG_MAX_ITEMS: 'abc' }), 'IG_MAX_ITEMS');
  assertValidationError(() => loadSettings({ IG_TIMEOUT_MS: '3.5' }), 'IG_TIMEOUT_MS');
  assertValidationError(() => loadSettings({ IG_MAX_CONCURRENT: '1e3' }), 'IG_MAX_CONCURRENT');
});

test('a digit string too large for an exact double is rejected as unsafe, not silently rounded', () => {
  // `/^[+-]?\d+$/` is happy with any number of digits, but `Number()` loses the
  // low bits past 2^53 — `IG_TIMEOUT_MS=99999999999999999999` would become
  // 1e20 and pass a naive range check as "just a big timeout". Rejecting keeps
  // the operator's typo a startup error rather than an effectively infinite one.
  assertValidationError(
    () => loadSettings({ IG_TIMEOUT_MS: '99999999999999999999' }),
    'IG_TIMEOUT_MS',
  );
  assertValidationError(() => loadSettings({ IG_MAX_ITEMS: '-99999999999999999999' }), 'safe');
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

test('every numeric knob accepts its documented range, and one step outside it is rejected', () => {
  // The bounds live only in `loadSettings` — architecture §12 documents the
  // defaults but not the ranges, so this table is the only place the contract is
  // written down twice. Both edges are asserted from *inside* as well as
  // outside: a range check with the wrong strictness (`<=` where `<` was meant)
  // still rejects everything an out-of-range-only test throws at it, so the
  // rejection cases above cannot tell 64 from 63 as the real ceiling.
  const RANGES = [
    { env: 'IG_MAX_CONCURRENT', field: 'maxConcurrent', min: 1, max: 64 },
    { env: 'IG_MAX_ITEMS', field: 'maxItems', min: 1, max: 100_000 },
    { env: 'IG_REFRESH_AFTER_DAYS', field: 'refreshAfterDays', min: 1, max: 60 },
    { env: 'IG_TIMEOUT_MS', field: 'timeoutMs', min: 1, max: 600_000 },
    { env: 'IG_PORT', field: 'httpPort', min: 1, max: 65535 },
  ] as const;

  for (const { env, field, min, max } of RANGES) {
    assert.equal(
      loadSettings({ [env]: String(min) })[field],
      min,
      `${env}=${min} must be accepted`,
    );
    assert.equal(
      loadSettings({ [env]: String(max) })[field],
      max,
      `${env}=${max} must be accepted`,
    );
    assertValidationError(() => loadSettings({ [env]: String(min - 1) }), env);
    assertValidationError(() => loadSettings({ [env]: String(max + 1) }), env);
  }
});

test('enum knobs are case-insensitive, like the boolean knobs, and yield the canonical spelling', () => {
  // One convention for both parsers (CC-CFG-13, applied 2026-09-19): until then
  // `IG_ALLOW_DESTRUCTIVE=TRUE` was honoured while `IG_TRANSPORT=HTTP` refused
  // to start. Both halves are pinned in one place so the symmetry is a stated
  // contract, and the value that comes back is the lower-case entry of the
  // allowed set — never the operator's casing, which nothing downstream
  // compares against.
  assert.equal(loadSettings({ IG_LOG_LEVEL: 'DEBUG' }).logLevel, 'debug');
  assert.equal(loadSettings({ IG_WRITE_MODE: 'Apply' }).writeMode, 'apply');
  assert.equal(loadSettings({ IG_TRANSPORT: ' HTTP ' }).transport, 'http');
  assert.equal(loadSettings({ IG_PRETTY_JSON: 'TRUE' }).prettyJson, true);
  // Folding case does not widen the set: a wrong value in any casing is still
  // refused, and the refusal echoes it as typed so the operator can find it.
  assert.throws(
    () => loadSettings({ IG_TRANSPORT: 'Ws' }),
    (err: unknown) =>
      err instanceof InstagramError &&
      err.message === 'IG_TRANSPORT must be one of stdio | http, got "Ws"',
  );
});

/**
 * `base` with every variable {@link loadSettings} reads removed.
 *
 * Two tests below run `loadSettings` against a REAL environment — a child
 * process's in one case, this process's in the other — and that is the property
 * they exist to pin, so it cannot be replaced with an injected map. It does mean
 * all twelve variables become inputs the DEVELOPER'S SHELL supplies: an ambient
 * `IG_LOG_LEVEL=trace` or `IG_MAX_ITEMS=200000` is a refusal, and the test then
 * fails on that machine while passing in CI. Nothing in `npm test` clears the
 * environment first — there is no `pretest` and no preload — so each of the two
 * clears it for itself (CC-PROC-177).
 *
 * The list is `SETTINGS_ENV_NAMES` rather than a local literal on purpose: the
 * test directly below pins it as EXACTLY the set `loadSettings` reads, so a knob
 * added later is cleared here without anyone remembering to come back.
 */
function withoutSettingsEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of SETTINGS_ENV_NAMES) delete env[name];
  return env;
}

test('SETTINGS_ENV_NAMES is exactly the IG_* set loadSettings reads', () => {
  // The composition root warns about every `IG_*` name nothing reads
  // (CC-CFG-13) and trusts this list for the settings half. Record every
  // property `loadSettings` touches on an empty env, so a knob added to the
  // loader without an entry here — which the entry would then report to the
  // operator as a typo — fails here first. Read in both directions: a stale
  // entry would silence the warning for a name that no longer does anything.
  const touched = new Set<string>();
  const recording = new Proxy<NodeJS.ProcessEnv>(
    {},
    {
      get: (_target, key) => {
        if (typeof key === 'string') touched.add(key);
        return undefined;
      },
    },
  );
  loadSettings(recording);
  const igNames = [...touched].filter((name) => name.startsWith('IG_')).sort();
  assert.deepEqual(igNames, [...SETTINGS_ENV_NAMES].sort());
  assert.equal(new Set(SETTINGS_ENV_NAMES).size, SETTINGS_ENV_NAMES.length, 'no duplicates');
});

test('SETTINGS_ENV_NAMES cannot be edited at runtime', () => {
  // The test above pins the list's CONTENTS against the names `loadSettings`
  // actually touches. It reads the array at the moment it runs and cannot see a
  // write that lands later — and the composition root reads this list on every
  // start to decide whether an `IG_*` variable is a knob or a typo (CC-CFG-13).
  // A push silences that warning for a name nothing reads; a pop reports a real
  // knob as a typo while it keeps working.
  assert.ok(Object.isFrozen(SETTINGS_ENV_NAMES), 'must be frozen, not merely readonly');
  const before = [...SETTINGS_ENV_NAMES];
  assert.throws(() => (SETTINGS_ENV_NAMES as string[]).push('IG_ANYTHING'), TypeError);
  assert.throws(() => (SETTINGS_ENV_NAMES as string[]).pop(), TypeError);
  assert.throws(() => {
    (SETTINGS_ENV_NAMES as string[])[0] = 'IG_ANYTHING';
  }, TypeError);
  assert.deepEqual(SETTINGS_ENV_NAMES, before, 'a write got through');
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
  // `Object.isFrozen` on its own is a claim about a flag, not about what the
  // value accepts — a frozen `Set` answers `true` and still deletes (CC-CFG-33)
  // — so the writes below are what measures it. This object is not a template
  // that gets copied per call either: `loadSettings` opens with
  // `const d = DEFAULT_SETTINGS` and reads every fallback straight off it, so a
  // single write here changes what every later call resolves. `writeMode` is
  // what the write gate reads to choose preview over apply, and
  // `allowDestructive` is the switch standing in front of the delete tool.
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  const mutable = DEFAULT_SETTINGS as Settings;
  assert.throws(() => {
    mutable.writeMode = 'apply';
  }, TypeError);
  assert.throws(() => {
    mutable.allowDestructive = true;
  }, TypeError);
  assert.throws(() => {
    mutable.writeJournal = '/nowhere/writes.jsonl';
  }, TypeError);
  assert.throws(() => {
    delete (DEFAULT_SETTINGS as Partial<Settings>).writeMode;
  }, TypeError);

  assert.equal(DEFAULT_SETTINGS.writeMode, 'preview', 'a write got through');
  assert.equal(DEFAULT_SETTINGS.allowDestructive, false, 'a write got through');
  const resolved = loadSettings({});
  assert.equal(resolved.writeMode, 'preview', 'the resolved default is no longer the safe one');
  assert.equal(resolved.allowDestructive, false, 'the resolved default is no longer the safe one');
});

// --- IG_WRITE_JOURNAL ------------------------------------------------------
//
// Exercised through `loadSettings` rather than the resolver behind it: the
// resolver is module-private, and `settings.writeJournal` is the only surface
// the write gate ever sees.

/** The resolved journal path for `env` — the field `mcp/write-mode.ts` reads. */
function journalFor(env: NodeJS.ProcessEnv): string {
  return loadSettings(env).writeJournal;
}

test('the write journal defaults to $XDG_STATE_HOME/instagram-mcp-ai/writes.jsonl', () => {
  assert.equal(
    journalFor({ XDG_STATE_HOME: '/var/state' }),
    join('/var/state', 'instagram-mcp-ai', 'writes.jsonl'),
  );
});

test('without XDG_STATE_HOME the journal falls back to ~/.local/state (XDG default)', () => {
  const expected = join(homedir(), '.local', 'state', 'instagram-mcp-ai', 'writes.jsonl');
  assert.equal(journalFor({}), expected);
  // A blank XDG_STATE_HOME means "unset", exactly like every other knob.
  assert.equal(journalFor({ XDG_STATE_HOME: '   ' }), expected);
});

test('an explicit IG_WRITE_JOURNAL wins over XDG_STATE_HOME and is trimmed', () => {
  assert.equal(
    journalFor({
      IG_WRITE_JOURNAL: '  /audit/writes.jsonl  ',
      XDG_STATE_HOME: '/ignored',
    }),
    '/audit/writes.jsonl',
  );
});

test('a blank IG_WRITE_JOURNAL means "use the default", it is not an empty path', () => {
  // Trailing `IG_WRITE_JOURNAL=` in a .env file must not send the audit trail to
  // the current working directory (or throw) — it means the knob is unset.
  for (const blank of ['', '   ', '\t\n']) {
    assert.equal(
      journalFor({ IG_WRITE_JOURNAL: blank, XDG_STATE_HOME: '/var/state' }),
      join('/var/state', 'instagram-mcp-ai', 'writes.jsonl'),
      `${JSON.stringify(blank)} should fall back to the default`,
    );
  }
});

test('a path knob is not validated — any ordinary non-blank path passes through verbatim', () => {
  // Deliberate: the journal is a best-effort audit sink, so an unusable path is
  // reported at warn on the first applied write, never as a refusal to start.
  assert.equal(journalFor({ IG_WRITE_JOURNAL: 'writes.jsonl' }), 'writes.jsonl');
  assert.equal(
    journalFor({ IG_WRITE_JOURNAL: '/no/such/mount/writes.jsonl' }),
    '/no/such/mount/writes.jsonl',
  );
});

test('a RELATIVE XDG_STATE_HOME is ignored, so the audit trail cannot follow the cwd', () => {
  // The XDG spec requires these variables to be absolute and says a relative one
  // must be ignored. This server has its own reason: the journal is the record of
  // every applied write, so a base that resolves against the cwd would scatter it
  // across whichever directories the MCP client spawned the server from, and no
  // single file would answer "what did this server post?" (CC-CFG-24).
  const fallback = join(homedir(), '.local', 'state', 'instagram-mcp-ai', 'writes.jsonl');
  for (const relative of ['.', 'state', './state', '../state', 'a/b']) {
    assert.equal(
      journalFor({ XDG_STATE_HOME: relative }),
      fallback,
      `a relative XDG_STATE_HOME (${JSON.stringify(relative)}) must not be honored`,
    );
  }
  // The trimming still happens first, so a padded ABSOLUTE value is still used.
  assert.equal(
    journalFor({ XDG_STATE_HOME: '  /var/state  ' }),
    join('/var/state', 'instagram-mcp-ai', 'writes.jsonl'),
  );
});

test('an explicit IG_WRITE_JOURNAL may still be relative — it names a file, not a base', () => {
  // The rule above is about a BASE DIRECTORY the environment supplies for many
  // programs. `IG_WRITE_JOURNAL` is this server's own knob, set by an operator
  // who is naming one file, so `IG_WRITE_JOURNAL=writes.jsonl` keeps meaning
  // exactly what it says and the relative-path rule must not creep into it.
  assert.equal(
    journalFor({ IG_WRITE_JOURNAL: 'writes.jsonl', XDG_STATE_HOME: '.' }),
    'writes.jsonl',
  );
});

test('a leading ~ in XDG_STATE_HOME is the home directory, not an ignored relative base', () => {
  // CC-CFG-64: an MCP client's JSON `env` passes `~/state` verbatim. Treated
  // as relative it was dropped for `~/.local/state`, so the audit trail landed
  // somewhere other than where the operator pointed it — with no diagnostic.
  const home = homedir();
  assert.equal(
    journalFor({ XDG_STATE_HOME: '~/state' }),
    join(home, 'state', 'instagram-mcp-ai', 'writes.jsonl'),
  );
  assert.equal(
    journalFor({ XDG_STATE_HOME: '  ~  ' }),
    join(home, 'instagram-mcp-ai', 'writes.jsonl'),
  );
});

test('a leading ~ in IG_WRITE_JOURNAL is the home directory, not a folder named ~ in the cwd', () => {
  // CC-CFG-64: verbatim, `~/audit/writes.jsonl` made `mcp/write-mode.ts`
  // create `<cwd>/~/audit/` and append the journal there.
  assert.equal(
    journalFor({ IG_WRITE_JOURNAL: '~/audit/writes.jsonl' }),
    join(homedir(), 'audit', 'writes.jsonl'),
  );
  // Only the home's own `~` is expanded: one inside a name is an ordinary character.
  assert.equal(journalFor({ IG_WRITE_JOURNAL: '/audit/~/w.jsonl' }), '/audit/~/w.jsonl');
  assert.equal(journalFor({ IG_WRITE_JOURNAL: 'a~/w.jsonl' }), 'a~/w.jsonl');
});

test('a shell-only spelling in XDG_STATE_HOME or IG_WRITE_JOURNAL refuses to start', () => {
  // CC-CFG-65, the journal side of CC-CFG-61: `$HOME/…`, `${HOME}`, `~user`
  // and `%VAR%` are paths only to a shell. Ignoring the state home would drop the
  // journal into the default one; honouring the journal path would create a
  // directory literally named `$HOME` under the cwd.
  for (const name of ['XDG_STATE_HOME', 'IG_WRITE_JOURNAL']) {
    for (const value of [
      '$HOME/state',
      '${HOME}/state',
      '~alice/state',
      '%LOCALAPPDATA%\\s',
      '~+',
    ]) {
      assert.throws(
        () => loadSettings({ [name]: value }),
        (err: unknown) => {
          assert.ok(err instanceof InstagramError, 'expected an InstagramError');
          assert.equal(err.kind, 'validation');
          assert.equal(
            err.message,
            `${name} is ${JSON.stringify(value)}, which only a shell can expand — it is not a ` +
              'path this server can use for the write journal; set it to an absolute path',
          );
          return true;
        },
        `${name}=${value} must be refused`,
      );
    }
  }
  // The explicit journal path is checked before, and instead of, the state home.
  assert.equal(
    journalFor({ IG_WRITE_JOURNAL: '/audit/w.jsonl', XDG_STATE_HOME: '$HOME/state' }),
    '/audit/w.jsonl',
  );
  // A `$` or `%` past the first character is an ordinary file-name character.
  assert.equal(journalFor({ IG_WRITE_JOURNAL: '/a/$b/100%.jsonl' }), '/a/$b/100%.jsonl');
  assert.equal(
    journalFor({ XDG_STATE_HOME: '/srv/$state' }),
    join('/srv/$state', 'instagram-mcp-ai', 'writes.jsonl'),
  );
});

test('DEFAULT_SETTINGS.writeJournal is the documented default, not this process’s environment', () => {
  // `DEFAULT_SETTINGS` is built at import time from an EMPTY env deliberately:
  // it is the value the docs promise, so `doctor` can label it "default" and an
  // operator can look it up in §12. Resolving it from `process.env` instead
  // would make the constant echo whatever the running process is configured
  // with — and no in-process test can see that, because this test runner has no
  // XDG_STATE_HOME to be echoed. Ask a child process that does have one.
  const moduleUrl = new URL('../../src/core/settings.js', import.meta.url).href;
  const probe = [
    `import { DEFAULT_SETTINGS, loadSettings } from ${JSON.stringify(moduleUrl)};`,
    'process.stdout.write(',
    '  JSON.stringify([DEFAULT_SETTINGS.writeJournal, loadSettings().writeJournal]),',
    ');',
  ].join('\n');

  // Inherited so `homedir()` agrees with the parent. Every `IG_*` knob is cleared:
  // `IG_WRITE_JOURNAL` so the child cannot take the explicit-path shortcut and skip
  // the XDG resolution entirely, and the other eleven so the developer's own shell
  // cannot refuse the `loadSettings()` call on the second line of the probe
  // (CC-PROC-177).
  const env: NodeJS.ProcessEnv = {
    ...withoutSettingsEnv(process.env),
    XDG_STATE_HOME: '/probe/state',
  };
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    env,
    encoding: 'utf8',
  });
  const [frozen, resolved] = JSON.parse(out) as [string, string];

  assert.equal(frozen, join(homedir(), '.local', 'state', 'instagram-mcp-ai', 'writes.jsonl'));
  // The other half of the same contract: `loadSettings` DOES follow the ambient
  // environment. Asserting both from one child is what makes the first line a
  // statement about `DEFAULT_SETTINGS` rather than about the probe env.
  assert.equal(resolved, join('/probe/state', 'instagram-mcp-ai', 'writes.jsonl'));
});

test('loadSettings reads process.env when no env map is passed', () => {
  // The production call site is the argless one (`src/index.ts`), so the
  // default parameter carries the journal path too, not just the scalar knobs.
  //
  // Argless means THIS process's environment is the input, which makes the
  // developer's shell part of the fixture — see `withoutSettingsEnv`. Saving and
  // restoring the whole set, rather than clearing it, keeps the file's later tests
  // running in the environment they started in (CC-PROC-177).
  const saved = SETTINGS_ENV_NAMES.map((name): [string, string | undefined] => [
    name,
    process.env[name],
  ]);
  for (const name of SETTINGS_ENV_NAMES) delete process.env[name];
  process.env.IG_WRITE_JOURNAL = '/from/process-env/writes.jsonl';
  try {
    assert.equal(loadSettings().writeJournal, '/from/process-env/writes.jsonl');
  } finally {
    for (const [name, prev] of saved) {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
  }
});

test('every refusal is pinned whole — variable, bounds, allowed set, offending value, guidance', () => {
  // Rule CC-PROC-54: matching a message on the variable-name fragment alone pins
  // nothing an operator reads. Six mutants survived that way — swapped `[max, min]`
  // bounds, a dropped `, got N`, a rewritten boolean message, a `, ` instead of
  // ` | ` between the allowed enum values, the dropped reverse-proxy guidance in
  // the loopback refusal, and a dropped `"raw"` in the integer refusal. Each row
  // asserts the entire line, so any change in wording, punctuation or
  // interpolation order is a test failure, not a silent drift.
  //
  // Wording contract: the *range* message shows the number bare (`got 65`) but
  // spelled as the operator typed it, not re-rendered from the parsed double
  // (CC-CFG-57); every other message quotes the trimmed raw text (`got
  // "maybe"`), so what the operator typed is reproduced verbatim — trailing
  // whitespace excepted, because `read` trims before any parser sees the value.
  // A value too long or unprintable to quote is described instead (CC-CFG-50,
  // CC-CFG-51); every row here is short and printable.
  const rows: ReadonlyArray<readonly [NodeJS.ProcessEnv, string]> = [
    [{ IG_MAX_CONCURRENT: '65' }, 'IG_MAX_CONCURRENT must be in [1, 64], got 65'],
    [{ IG_MAX_CONCURRENT: '0' }, 'IG_MAX_CONCURRENT must be in [1, 64], got 0'],
    [{ IG_MAX_ITEMS: '-5' }, 'IG_MAX_ITEMS must be in [1, 100000], got -5'],
    [{ IG_REFRESH_AFTER_DAYS: '61' }, 'IG_REFRESH_AFTER_DAYS must be in [1, 60], got 61'],
    [{ IG_TIMEOUT_MS: '600001' }, 'IG_TIMEOUT_MS must be in [1, 600000], got 600001'],
    [{ IG_PORT: ' 70000 ' }, 'IG_PORT must be in [1, 65535], got 70000'],
    [{ IG_PORT: ' 3.5 ' }, 'IG_PORT must be an integer, got "3.5"'],
    [{ IG_MAX_ITEMS: 'abc' }, 'IG_MAX_ITEMS must be an integer, got "abc"'],
    [
      { IG_MAX_ITEMS: '99999999999999999999' },
      'IG_MAX_ITEMS must be a safe integer, got "99999999999999999999"',
    ],
    [{ IG_PRETTY_JSON: 'maybe' }, 'IG_PRETTY_JSON must be a boolean (true/false), got "maybe"'],
    [
      { IG_ALLOW_DESTRUCTIVE: ' 2 ' },
      'IG_ALLOW_DESTRUCTIVE must be a boolean (true/false), got "2"',
    ],
    [
      { IG_LOG_LEVEL: 'trace' },
      'IG_LOG_LEVEL must be one of debug | info | warn | error, got "trace"',
    ],
    [{ IG_WRITE_MODE: 'Force' }, 'IG_WRITE_MODE must be one of preview | apply, got "Force"'],
    [{ IG_TRANSPORT: 'ws' }, 'IG_TRANSPORT must be one of stdio | http, got "ws"'],
    [
      { IG_HTTP_HOST: '0.0.0.0' },
      'IG_HTTP_HOST must be one of the loopback spellings this transport accepts ' +
        '(127.0.0.0/8, localhost, ::1 or [::1]), got "0.0.0.0" — the HTTP transport binds ' +
        'loopback only; to expose it, put an authenticating reverse proxy in front of a ' +
        'loopback bind.',
    ],
    [
      // `127.1` is the same refusal on an input that IS loopback: `dns.lookup`
      // resolves it to 127.0.0.1, and {@link isIpv4} refuses it for having two
      // parts instead of four. Refusing it is the point — this checker reads a
      // dotted quad, not every spelling a resolver would take — but the sentence
      // then has to be about the accepted SPELLINGS and not about loopback, or it
      // tells an operator who typed a loopback address that they did not. The
      // `0.0.0.0` row above agrees with either wording, because `0.0.0.0` is
      // genuinely not loopback; this row is the one that can tell them apart.
      { IG_HTTP_HOST: '127.1' },
      'IG_HTTP_HOST must be one of the loopback spellings this transport accepts ' +
        '(127.0.0.0/8, localhost, ::1 or [::1]), got "127.1" — the HTTP transport binds ' +
        'loopback only; to expose it, put an authenticating reverse proxy in front of a ' +
        'loopback bind.',
    ],
  ];
  for (const [env, message] of rows) {
    assert.throws(
      () => loadSettings(env),
      (err: unknown) => {
        assert.ok(err instanceof InstagramError, 'expected an InstagramError');
        assert.equal(err.kind, 'validation');
        assert.equal(err.message, message);
        return true;
      },
      `${JSON.stringify(env)} must be refused with the exact message`,
    );
  }
});

/** The exact refusal message `loadSettings(env)` throws. */
function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadSettings(env);
  } catch (err) {
    assert.ok(err instanceof InstagramError, 'expected an InstagramError');
    assert.equal(err.kind, 'validation');
    return err.message;
  }
  assert.fail(`${JSON.stringify(env)} must be refused`);
}

test('a settings refusal never echoes a value long enough to be a mis-filed credential (CC-CFG-50)', () => {
  // `loadSettings` runs before any secret is registered for redaction, so a
  // quoted value reaches the `failed to start:` line guarded only by the
  // token-shape backstop — which a 32-hex app secret does not match. A value is
  // quoted while it is at most 24 characters and described by length beyond,
  // the same cap `core/config.ts` applies to the auth path (CC-CFG-47). Hex-only
  // fakes on both sides of the boundary, through every site that quotes a value.
  const at = 'ab'.repeat(12); // 24 characters: still quoted
  const over = `${at}c`; // 25 characters: described
  const hidden =
    'a value of 25 characters (not echoed — it may be a credential set under the wrong name)';
  const hostTail =
    ' — the HTTP transport binds loopback only; to expose it, put an authenticating ' +
    'reverse proxy in front of a loopback bind.';
  const hostHead =
    'IG_HTTP_HOST must be one of the loopback spellings this transport accepts ' +
    '(127.0.0.0/8, localhost, ::1 or [::1]), got ';
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['IG_MAX_ITEMS', 'IG_MAX_ITEMS must be an integer, got '],
    ['IG_PRETTY_JSON', 'IG_PRETTY_JSON must be a boolean (true/false), got '],
    ['IG_LOG_LEVEL', 'IG_LOG_LEVEL must be one of debug | info | warn | error, got '],
    ['IG_TRANSPORT', 'IG_TRANSPORT must be one of stdio | http, got '],
  ];
  for (const [name, head] of cases) {
    assert.equal(refusal({ [name]: at }), `${head}"${at}"`);
    assert.equal(refusal({ [name]: over }), `${head}${hidden}`);
    assert.ok(!refusal({ [name]: over }).includes(over), `${name} leaked the value`);
  }
  assert.equal(refusal({ IG_HTTP_HOST: at }), `${hostHead}"${at}"${hostTail}`);
  assert.equal(refusal({ IG_HTTP_HOST: over }), `${hostHead}${hidden}${hostTail}`);
  // The unsafe-integer site: an all-digit value (a numeric id or PIN in the
  // wrong variable) is refused by magnitude, not shape, and follows the same cap.
  const digits = '1'.repeat(25);
  assert.equal(
    refusal({ IG_TIMEOUT_MS: digits }),
    `IG_TIMEOUT_MS must be a safe integer, got ${hidden}`,
  );
  assert.equal(
    refusal({ IG_TIMEOUT_MS: digits.slice(1) }),
    `IG_TIMEOUT_MS must be a safe integer, got "${digits.slice(1)}"`,
  );
  // Short typos — the reason a value is quoted at all — stay useful, and the
  // length is measured after trimming, as the value is.
  assert.equal(
    refusal({ IG_ALLOW_DESTRUCTIVE: `  ture${' '.repeat(40)}` }),
    'IG_ALLOW_DESTRUCTIVE must be a boolean (true/false), got "ture"',
  );
});

test('a settings refusal never quotes control or invisible characters (CC-CFG-51)', () => {
  // `read` trims only the ends. An inner newline would let an env value forge a
  // second stderr line (`...got "x\n[info] ready"`); an ANSI escape could
  // repaint the terminal; a bidi override or zero-width character makes the
  // quoted text differ from what the operator sees. Such a value is described,
  // never quoted — however short.
  for (const raw of [
    'tr\nue',
    'x\r[info] ok',
    '\u001b[2Jon',
    'no\u0000',
    'o‮fn',
    'yes​',
    'a b',
    'a\u2029b',
  ]) {
    const message = refusal({ IG_PRETTY_JSON: raw });
    assert.equal(
      message,
      `IG_PRETTY_JSON must be a boolean (true/false), got a value of ${raw.length} characters ` +
        '(not echoed — it contains control or invisible characters)',
    );
    assert.ok(!message.includes(raw), `${JSON.stringify(raw)} was quoted`);
  }
  // A tab or space inside a value is printable and stays quoted.
  assert.equal(
    refusal({ IG_TRANSPORT: 'st dio' }),
    'IG_TRANSPORT must be one of stdio | http, got "st dio"',
  );
});

test('numeric spellings: sign, padding and zero are read as decimal; empty is unset (CC-CFG-52)', () => {
  // Pins the accepted edge of the `/^[+-]?\d+$/` grammar so it stays a choice:
  // an explicit `+`, leading zeros (decimal, never octal) and surrounding
  // whitespace are all the number they look like; `-0` is zero and refused by
  // the range like `0` (and reported as typed, CC-CFG-57); an empty or blank
  // value is "unset", not zero.
  assert.equal(loadSettings({ IG_PORT: '+8080' }).httpPort, 8080);
  assert.equal(loadSettings({ IG_PORT: '010' }).httpPort, 10);
  assert.equal(loadSettings({ IG_PORT: '\t 5 \n' }).httpPort, 5);
  assert.equal(refusal({ IG_PORT: '-0' }), 'IG_PORT must be in [1, 65535], got -0');
  assert.equal(loadSettings({ IG_PORT: '' }).httpPort, DEFAULT_SETTINGS.httpPort);
  assert.equal(loadSettings({ IG_PORT: '   ' }).httpPort, DEFAULT_SETTINGS.httpPort);
  // Non-ASCII digits are not digits here (`\d` without the `u` flag is ASCII).
  assert.match(refusal({ IG_PORT: '８０８０' }), /^IG_PORT must be an integer, got "８０８０"$/);
});

test('a range refusal reports the number as the operator spelled it, not as it parsed (CC-CFG-57)', () => {
  // The range message interpolated the parsed number, and a template literal
  // renders `-0` as `0`: `IG_PORT=-0` was refused with `got 0`, a value that is
  // nowhere in the operator's file. A sign or zero padding was lost the same
  // way. The spelling is what they search for, so it is what the line carries.
  assert.equal(refusal({ IG_PORT: '-0' }), 'IG_PORT must be in [1, 65535], got -0');
  assert.equal(
    refusal({ IG_MAX_CONCURRENT: '+0' }),
    'IG_MAX_CONCURRENT must be in [1, 64], got +0',
  );
  assert.equal(refusal({ IG_PORT: '+70000' }), 'IG_PORT must be in [1, 65535], got +70000');
  assert.equal(refusal({ IG_PORT: ' 0070000 ' }), 'IG_PORT must be in [1, 65535], got 0070000');
  // Zero padding is the one spelling that passes the safe-integer test at any
  // length, so the echo cap (CC-CFG-50) still governs this site: 24 characters
  // are shown, 25 are described.
  const at = `${'0'.repeat(19)}70000`;
  assert.equal(at.length, 24);
  assert.equal(refusal({ IG_PORT: at }), `IG_PORT must be in [1, 65535], got ${at}`);
  assert.equal(
    refusal({ IG_PORT: `0${at}` }),
    'IG_PORT must be in [1, 65535], got a value of 25 characters ' +
      '(not echoed — it may be a credential set under the wrong name)',
  );
});

// --- The journal's home fallback refuses a home that is not absolute (CC-CFG-75) ---

/** Run `fn` with `$HOME` (`%USERPROFILE%`) set to `home`, restoring both after. */
function withHome<T>(home: string, fn: () => T): T {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const HOME_VARIABLE = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';

test('a home that is not absolute is refused for the journal fallback, not joined as relative (CC-CFG-75)', () => {
  // `os.homedir()` returns `$HOME` verbatim — `"   "` included — so the journal
  // fell back to `   /.local/state/…`, resolved against whichever cwd the MCP
  // client picked: the audit trail scattered across directories (CC-CFG-24).
  // The config home already refused such a home (CC-CFG-69); the journal now
  // shares that one check.
  withHome('   ', () => {
    assertValidationError(() => loadSettings({}), HOME_VARIABLE);
    assertValidationError(() => loadSettings({ XDG_STATE_HOME: 'relative/state' }), HOME_VARIABLE);
    // The home is consulted only for the fallback: a journal named outright, or
    // an absolute state home, never depends on it.
    assert.equal(
      loadSettings({ IG_WRITE_JOURNAL: '/audit/w.jsonl' }).writeJournal,
      '/audit/w.jsonl',
    );
    assert.equal(
      loadSettings({ XDG_STATE_HOME: '/srv/state' }).writeJournal,
      join('/srv/state', 'instagram-mcp-ai', 'writes.jsonl'),
    );
  });
});

test('DEFAULT_SETTINGS resolves its journal when read, so a bad home cannot fail the import (CC-CFG-75)', () => {
  // Every module that imports settings — the CLI's `--help` included — would die
  // at import with a stack trace if the default were resolved eagerly. Read, it
  // is refused like any other fallback; the constant stays unassignable.
  const moduleUrl = new URL('../../src/core/settings.js', import.meta.url).href;
  const probe = [
    `const { DEFAULT_SETTINGS, loadSettings } = await import(${JSON.stringify(moduleUrl)});`,
    'let refusal;',
    'try { void DEFAULT_SETTINGS.writeJournal; } catch (err) { refusal = err.message; }',
    'let assigned = true;',
    "try { DEFAULT_SETTINGS.writeJournal = '/elsewhere'; } catch { assigned = false; }",
    "const journal = loadSettings({ XDG_STATE_HOME: '/srv/state' }).writeJournal;",
    'process.stdout.write(JSON.stringify({ refusal, assigned, journal }));',
  ].join('\n');
  const env: NodeJS.ProcessEnv = {
    ...withoutSettingsEnv(process.env),
    HOME: 'rel',
    USERPROFILE: 'rel',
  };
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    env,
    encoding: 'utf8',
  });
  const { refusal, assigned, journal } = JSON.parse(out) as {
    refusal?: string;
    assigned: boolean;
    journal: string;
  };
  assert.match(
    refusal ?? '',
    new RegExp(`the home directory is "rel" \\(from ${HOME_VARIABLE}\\)`),
  );
  assert.equal(assigned, false);
  assert.equal(journal, join('/srv/state', 'instagram-mcp-ai', 'writes.jsonl'));
});
