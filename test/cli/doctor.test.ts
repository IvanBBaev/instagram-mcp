/**
 * Unit tests for the `doctor` health-check CLI command (src/cli/doctor.ts).
 *
 * `runDoctor` is fully injectable: a fake {@link IgRequestFn} routes on the
 * request path (`/debug_token` vs the reachability `GET /{ig-id}`), the profile
 * and settings are plain objects, and time is pinned via `nowMs`. No network,
 * no global state — the checks are observed purely through the returned report
 * string and exit code.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDoctor } from '../../src/cli/doctor.js';
import { InstagramError } from '../../src/core/types.js';
import type {
  IgRequestFn,
  IgRequestOptions,
  Logger,
  ResolvedProfile,
  Settings,
} from '../../src/core/types.js';
import { testSettings } from '../helpers/settings.js';

const DAY = 86_400_000;
const NOW = 100 * DAY;

/** A distinctive, token-shaped secret so redaction assertions are meaningful. */
const ACCESS_TOKEN = 'EAAJtestTOKENvalue0123456789abcXYZsecret';

const baseSettings: Settings = testSettings();

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
};

function fbProfile(over: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: 'default',
    authPath: 'fb-login',
    accessToken: ACCESS_TOKEN,
    accountId: '178414',
    appId: '55500',
    appSecret: 'app-secret-value-0123456789',
    ...over,
  };
}

function igProfile(over: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: 'default',
    authPath: 'ig-login',
    accessToken: ACCESS_TOKEN,
    accountId: '178414',
    ...over,
  };
}

/** Fake request seam that records calls and routes by path. */
function fakeReq(responder: (opts: IgRequestOptions) => unknown): {
  req: IgRequestFn;
  calls: IgRequestOptions[];
} {
  const calls: IgRequestOptions[] = [];
  const req: IgRequestFn = async <T>(opts: IgRequestOptions): Promise<T> => {
    calls.push(opts);
    return responder(opts) as T;
  };
  return { req, calls };
}

/** Route a fake by request path: `debug` for `/debug_token`, else `account`. */
function routing(map: {
  debug?: () => unknown;
  account?: () => unknown;
}): (opts: IgRequestOptions) => unknown {
  return (opts) => {
    if (opts.path === '/debug_token') {
      if (map.debug === undefined) throw new Error('unexpected debug_token call');
      return map.debug();
    }
    if (map.account === undefined) throw new Error(`unexpected path ${opts.path}`);
    return map.account();
  };
}

test('healthy: valid token debug + reachable account -> green report, exit 0', async () => {
  const { req, calls } = fakeReq(
    routing({
      debug: () => ({
        data: {
          is_valid: true,
          app_id: '55500',
          scopes: ['instagram_basic', 'pages_show_list'],
          expires_at: (NOW + 200 * DAY) / 1000,
        },
      }),
      account: () => ({ id: '178414', username: 'acme' }),
    }),
  );

  const res = await runDoctor({ req, profile: fbProfile(), settings: baseSettings, nowMs: NOW });

  assert.equal(res.exitCode, 0);
  assert.ok(res.report.includes('Token is valid'), 'token validity reported');
  assert.ok(res.report.includes('Granted scopes: instagram_basic'), 'scopes reported');
  assert.ok(res.report.includes('Reachability OK'), 'reachability reported');
  assert.ok(res.report.includes('@acme'), 'resolved username shown');
  assert.ok(res.report.includes('Health check passed'), 'summary is green');
  assert.ok(!res.report.includes(ACCESS_TOKEN), 'no token in report');
  // Exactly two Graph calls: debug_token + reachability.
  assert.equal(calls.length, 2);
});

test('healthy report includes a secret-free configuration summary', async () => {
  const { req } = fakeReq(
    routing({
      debug: () => ({ data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] } }),
      account: () => ({ id: '178414', username: 'acme' }),
    }),
  );

  const res = await runDoctor({
    req,
    profile: fbProfile(),
    settings: baseSettings,
    log: noopLog,
    nowMs: NOW,
  });

  assert.ok(res.report.includes('Transport:'), 'transport line present');
  assert.ok(res.report.includes('Write mode:'), 'write mode line present');
  assert.ok(res.report.includes('Allow destructive:'), 'destructive flag present');
  assert.ok(res.report.includes('Refresh after:'), 'refresh window present');
  assert.ok(res.report.includes('Active packages:'), 'packages line present');
  assert.ok(res.report.includes('Development vs Live'), 'dev-vs-live line present');
  assert.ok(!res.report.includes(ACCESS_TOKEN), 'no token anywhere in the summary');
});

test('expiring: near-expiry token -> warning line, still exit 0', async () => {
  const { req } = fakeReq(
    routing({
      debug: () => ({
        data: {
          is_valid: true,
          scopes: ['instagram_basic'],
          expires_at: (NOW + 10 * DAY) / 1000,
        },
      }),
      account: () => ({ id: '178414', username: 'acme' }),
    }),
  );

  const res = await runDoctor({ req, profile: fbProfile(), settings: baseSettings, nowMs: NOW });

  assert.equal(res.exitCode, 0, 'near-expiry is a warning, not a failure');
  assert.ok(res.report.includes('WARN'), 'a warning line is present');
  assert.ok(res.report.includes('expiring_soon'), 'expiry state named');
  assert.ok(res.report.includes('day(s) left'), 'remaining days surfaced');
});

test('broken: reachability GET throws auth InstagramError -> failure, exit != 0', async () => {
  const { req } = fakeReq(
    routing({
      account: () => {
        throw new InstagramError('Error validating access token: session has expired', {
          kind: 'auth',
          status: 401,
          code: 190,
        });
      },
    }),
  );

  const res = await runDoctor({ req, profile: igProfile(), settings: baseSettings, nowMs: NOW });

  assert.notEqual(res.exitCode, 0, 'a failed reachability check fails the command');
  assert.ok(res.report.includes('FAIL'), 'a failure line is present');
  assert.ok(res.report.includes('Reachability FAILED'), 'names the failed check');
  assert.ok(res.report.includes('kind=auth'), 'surfaces the error discriminant');
  assert.ok(res.report.includes('Health check FAILED'), 'summary is red');
});

test('invalid token: debug_token reports is_valid=false -> failure, exit != 0', async () => {
  const { req } = fakeReq(
    routing({
      debug: () => ({ data: { is_valid: false, app_id: '55500' } }),
      account: () => ({ id: '178414', username: 'acme' }),
    }),
  );

  const res = await runDoctor({ req, profile: fbProfile(), settings: baseSettings, nowMs: NOW });

  assert.notEqual(res.exitCode, 0);
  assert.ok(res.report.includes('INVALID'), 'invalidity is called out');
});

test('secret safety: an access token appearing in an upstream error is redacted', async () => {
  const { req } = fakeReq(
    routing({
      debug: () => ({ data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] } }),
      account: () => {
        throw new InstagramError(`upstream rejected the token ${ACCESS_TOKEN}`, {
          kind: 'upstream',
          status: 500,
        });
      },
    }),
  );

  const res = await runDoctor({ req, profile: fbProfile(), settings: baseSettings, nowMs: NOW });

  assert.ok(!res.report.includes(ACCESS_TOKEN), 'the raw token must never appear');
  assert.ok(res.report.includes('[REDACTED]'), 'the token was masked by the redactor');
});

test('path A (ig-login): states debug_token is unavailable and does not crash', async () => {
  const { req, calls } = fakeReq(
    routing({
      account: () => ({ id: '178414', username: 'acme' }),
    }),
  );

  const res = await runDoctor({ req, profile: igProfile(), settings: baseSettings, nowMs: NOW });

  assert.equal(res.exitCode, 0, 'a reachable Path A profile is healthy');
  assert.ok(res.report.includes('Path A'), 'auth path called out');
  assert.ok(res.report.includes('debug_token'), 'introspection endpoint named');
  assert.ok(res.report.includes('unavailable'), 'stated as unavailable');
  assert.ok(!calls.some((c) => c.path === '/debug_token'), 'debug_token is never called on Path A');
  assert.equal(calls.length, 1, 'only the reachability GET is issued');
});

// --- package summary (must match the registry, not a hardcoded guess) ------

/** The `Active packages:` line of a report, without its status prefix. */
function packagesLine(report: string): string {
  const line = report.split('\n').find((l) => l.includes('Active packages:'));
  assert.ok(line !== undefined, 'the report has an Active packages line');
  return line;
}

function healthyReq(): IgRequestFn {
  return fakeReq(
    routing({
      debug: () => ({ data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] } }),
      account: () => ({ id: '178414', username: 'acme' }),
    }),
  ).req;
}

test('the default package summary names the real core profile, including its write packages', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: {},
  });

  const line = packagesLine(res.report);
  // The registry's core profile is account, media, publishing, comments,
  // insights — under-reporting it hides 12 write tools from the operator.
  for (const pkg of ['account', 'media', 'publishing', 'comments', 'insights']) {
    assert.ok(line.includes(pkg), `the packages line names '${pkg}': ${line}`);
  }
});

test('an explicitly selected profile is expanded into the packages it resolves to', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_TOOL_PACKAGES: 'publisher' },
  });

  const line = packagesLine(res.report);
  assert.ok(line.includes('publisher'), 'the selection itself is echoed');
  for (const pkg of ['account', 'media', 'publishing', 'comments']) {
    assert.ok(line.includes(pkg), `the packages line names '${pkg}': ${line}`);
  }
  assert.ok(!line.includes('insights'), 'publisher does not include insights');
});

test('the reader profile is reported as forced read-only', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_TOOL_PACKAGES: 'reader' },
  });

  assert.ok(
    packagesLine(res.report).includes('forced read-only'),
    'the read-only guarantee of the reader profile is surfaced',
  );
});

test('deny and read-only refinements are surfaced in the package summary', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: {
      IG_TOOL_PACKAGES: 'all',
      IG_PACKAGES_DENY: 'insights',
      IG_PACKAGES_READONLY: 'comments',
    },
  });

  const line = packagesLine(res.report);
  assert.ok(line.includes('deny: insights'), 'the deny list is shown');
  assert.ok(line.includes('read-only: comments'), 'the forced read-only list is shown');
});

// --- applied-write journal --------------------------------------------------

// Every journal assertion runs against a throwaway directory. `testSettings()`
// already redirects `writeJournal` away from the operator's real audit trail at
// ~/.local/state/instagram-mcp-ai/writes.jsonl, and these tests narrow it
// further to a path this file owns and deletes.
const journalRoot = mkdtempSync(join(tmpdir(), 'ig-doctor-journal-'));
after(() => rmSync(journalRoot, { recursive: true, force: true }));

/** The `Write journal:` line of a report, without its status prefix. */
function journalLine(report: string): string {
  const line = report.split('\n').find((l) => l.includes('Write journal:'));
  assert.ok(line !== undefined, 'the report has a Write journal line');
  return line;
}

test('the configuration section reports the resolved write-journal path', async () => {
  const writeJournal = join(journalRoot, 'reported', 'writes.jsonl');

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeJournal }),
    nowMs: NOW,
  });

  assert.equal(res.exitCode, 0);
  assert.ok(journalLine(res.report).includes(writeJournal), 'the exact resolved path is printed');
});

test('the journal line is aligned with its neighbours in the configuration block', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeJournal: join(journalRoot, 'aligned', 'writes.jsonl') }),
    nowMs: NOW,
  });

  // Every configuration label pads its value to the same column; a bare
  // `label: value` would visibly break the block.
  const valueColumn = (label: string): number => {
    const line = res.report.split('\n').find((l) => l.includes(label));
    assert.ok(line !== undefined, `the report has a ${label} line`);
    const tail = line.slice(line.indexOf(label) + label.length);
    return line.length - tail.trimStart().length;
  };
  assert.equal(valueColumn('Write journal:'), valueColumn('Write mode:'), 'same value column');
  assert.equal(valueColumn('Write journal:'), valueColumn('Refresh after:'), 'same value column');
});

test('in preview mode the journal line states that nothing is being recorded', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({
      writeMode: 'preview',
      writeJournal: join(journalRoot, 'preview', 'writes.jsonl'),
    }),
    nowMs: NOW,
  });

  const line = journalLine(res.report);
  // A bare path in preview mode reads as "my audit trail is live" when in fact
  // the journal only ever receives entries for an APPLIED write.
  assert.ok(line.includes('preview mode'), 'the write mode is named on the same line');
  assert.ok(line.includes('nothing is recorded'), 'the empty-trail consequence is spelled out');
  assert.ok(line.includes('IG_WRITE_MODE=apply'), 'the way to start recording is named');
});

test('in apply mode the journal line states that applied writes are appended', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({
      writeMode: 'apply',
      writeJournal: join(journalRoot, 'apply', 'writes.jsonl'),
    }),
    nowMs: NOW,
  });

  const line = journalLine(res.report);
  assert.ok(line.includes('apply mode'), 'the write mode is named');
  assert.ok(!line.includes('preview mode'), 'apply mode is not described as preview');
  assert.ok(line.includes('appended'), 'states that writes land here');
});

test('an existing journal is reported as present, with its size', async () => {
  const dir = mkdtempSync(join(journalRoot, 'present-'));
  const writeJournal = join(dir, 'writes.jsonl');
  writeFileSync(writeJournal, '{"action":"publish_media"}\n');

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'apply', writeJournal }),
    nowMs: NOW,
  });

  const line = journalLine(res.report);
  assert.ok(line.includes('file exists'), 'existence is reported');
  assert.ok(line.includes('27 B'), 'the size is reported so an empty trail is visible');
});

test('a journal that does not exist yet is reported as not-yet-created, not as broken', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({
      writeMode: 'apply',
      writeJournal: join(journalRoot, 'fresh', 'nested', 'writes.jsonl'),
    }),
    nowMs: NOW,
  });

  const line = journalLine(res.report);
  assert.ok(line.includes('not created yet'), 'a missing journal is a normal state');
  assert.ok(!line.includes('WARN'), 'a missing journal is not a warning');
});

test('doctor never creates the journal file or its directory', async () => {
  const dir = join(journalRoot, 'untouched');
  const writeJournal = join(dir, 'writes.jsonl');

  await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'apply', writeJournal }),
    nowMs: NOW,
  });

  // Diagnosing must not mutate state: the probe is stat/access only.
  assert.equal(existsSync(dir), false, 'the journal directory was not created');
  assert.equal(existsSync(writeJournal), false, 'the journal file was not created');
});

test('an unwritable journal path warns but never fails the health check', async () => {
  // A regular file where the journal directory has to go: `mkdirSync` would fail
  // with ENOTDIR, so the trail is dead. Deterministic on every platform and
  // regardless of the uid the tests run as (unlike a chmod-based fixture, which
  // root would sail straight through).
  const dir = mkdtempSync(join(journalRoot, 'blocked-'));
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'this is a file, not a directory\n');

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'apply', writeJournal: join(blocker, 'writes.jsonl') }),
    nowMs: NOW,
  });

  const line = journalLine(res.report);
  assert.ok(line.includes('WARN'), 'an unusable audit sink is surfaced as a warning');
  assert.ok(line.includes('NOT writable'), 'the problem is named');
  assert.ok(line.includes('will NOT be audited'), 'the consequence is spelled out');
  // The journal is a best-effort audit sink by design — `doctor` answers "can
  // this profile reach the Graph API", and a broken sink is not a "no".
  assert.equal(res.exitCode, 0, 'an unwritable journal never fails doctor');
  assert.ok(res.report.includes('Health check passed'), 'the summary stays green');
});

test('a journal path that is a directory is reported as unwritable rather than crashing', async () => {
  const writeJournal = mkdtempSync(join(journalRoot, 'isdir-'));

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'apply', writeJournal }),
    nowMs: NOW,
  });

  assert.equal(res.exitCode, 0, 'doctor still completes');
  assert.ok(journalLine(res.report).includes('not a regular file'), 'the reason is named');
});

test('in preview mode an unwritable journal is still warned about (a latent problem)', async () => {
  const dir = mkdtempSync(join(journalRoot, 'blocked-preview-'));
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'x\n');

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'preview', writeJournal: join(blocker, 'writes.jsonl') }),
    nowMs: NOW,
  });

  const line = journalLine(res.report);
  assert.ok(line.includes('WARN'), 'the operator learns before switching to apply');
  assert.ok(line.includes('would NOT be audited'), 'phrased as the latent consequence it is');
  assert.equal(res.exitCode, 0);
});

test('runDoctor tolerates an omitted nowMs (defaults to the wall clock)', async () => {
  const { req } = fakeReq(
    routing({
      debug: () => ({ data: { is_valid: true, expires_at: 0, scopes: [] } }),
      account: () => ({ id: '178414' }),
    }),
  );

  const res = await runDoctor({ req, profile: fbProfile(), settings: baseSettings });

  assert.equal(res.exitCode, 0);
  assert.ok(res.report.includes('never expires'), 'expires_at=0 renders as never-expires');
});

// --- a journal state that cannot be determined ------------------------------

test('a journal path the filesystem refuses to stat is "could not be determined", not a warning', async () => {
  // A 5000-character path segment: `statSync` throws ENAMETOOLONG and, unlike
  // ENOENT and ENOTDIR, `throwIfNoEntry: false` does NOT suppress it — so the
  // probe's outer catch is the only thing standing between an exotic path and a
  // crashed health check. Deterministic on every platform and every uid.
  const writeJournal = join(journalRoot, 'z'.repeat(5000), 'writes.jsonl');

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'apply', writeJournal }),
    nowMs: NOW,
  });

  const line = journalLine(res.report);
  assert.ok(
    line.includes('state could not be determined'),
    'the honest answer is "I could not tell"',
  );
  assert.ok(line.includes('ENAMETOOLONG'), 'the underlying reason is carried through');
  // "I proved you cannot append here" earns a WARN; "I could not tell" does not
  // — collapsing the two would cry wolf on every exotic filesystem.
  assert.ok(!line.includes('WARN'), 'an undetermined state is not asserted as broken');
  assert.equal(res.exitCode, 0, 'and it never fails the health check');
});

// The two permission probes below are the only fixtures in this file that need
// chmod. They are skipped for uid 0, which is exempt from the mode bits and
// would sail straight through the very check being asserted — a green result
// there would be meaningless, and a failing one would be a lie about the code.
const asRoot = process.getuid?.() === 0;

test(
  'an existing journal file with no write permission is reported as unwritable',
  { skip: asRoot },
  async () => {
    const dir = mkdtempSync(join(journalRoot, 'ro-file-'));
    const writeJournal = join(dir, 'writes.jsonl');
    writeFileSync(writeJournal, '{"action":"publish_media"}\n');
    chmodSync(writeJournal, 0o400);

    try {
      const res = await runDoctor({
        req: healthyReq(),
        profile: fbProfile(),
        settings: testSettings({ writeMode: 'apply', writeJournal }),
        nowMs: NOW,
      });

      const line = journalLine(res.report);
      // The file exists and has a size, so the cheap "does it exist" answer is
      // "yes" — reporting that alone would tell the operator their trail is fine
      // while every append silently fails.
      assert.ok(line.includes('WARN'), 'a read-only trail is surfaced as a warning');
      assert.ok(line.includes('no write permission on the file'), 'the reason is named');
      assert.ok(!line.includes('file exists,'), 'it is not reported as a healthy present journal');
      assert.equal(res.exitCode, 0, 'a broken audit sink still never fails doctor');
    } finally {
      chmodSync(writeJournal, 0o600);
    }
  },
);

test(
  'a journal whose nearest existing directory is not writable is reported as unwritable',
  { skip: asRoot },
  async () => {
    const dir = mkdtempSync(join(journalRoot, 'ro-dir-'));
    chmodSync(dir, 0o500);

    try {
      const res = await runDoctor({
        req: healthyReq(),
        profile: fbProfile(),
        settings: testSettings({
          writeMode: 'apply',
          // Nothing exists below `dir`, so the walk anchors on `dir` itself — the
          // directory the write gate's `mkdirSync` would have to create into.
          writeJournal: join(dir, 'nested', 'writes.jsonl'),
        }),
        nowMs: NOW,
      });

      const line = journalLine(res.report);
      assert.ok(line.includes('WARN'), 'an uncreatable trail is surfaced as a warning');
      assert.ok(line.includes(`no write permission on ${dir}`), 'the blocking directory is named');
      assert.ok(!line.includes('not created yet'), 'it is not reported as a normal fresh journal');
      assert.equal(res.exitCode, 0);
    } finally {
      chmodSync(dir, 0o700);
    }
  },
);

test('a journal past a mebibyte is sized in MiB, not in five-digit KiB', async () => {
  const dir = mkdtempSync(join(journalRoot, 'big-'));
  const writeJournal = join(dir, 'writes.jsonl');
  writeFileSync(writeJournal, 'x'.repeat(2 * 1024 * 1024));

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'apply', writeJournal }),
    nowMs: NOW,
  });

  assert.ok(journalLine(res.report).includes('2.0 MiB'), 'the size scales past KiB');
});

// --- package selection: an explicit list is not a profile -------------------

test('an explicit comma list of packages is echoed unchanged, never mis-expanded', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_TOOL_PACKAGES: 'account,media' },
  });

  const line = packagesLine(res.report);
  const value = line.slice(line.indexOf('Active packages:') + 'Active packages:'.length).trim();
  // A list is already its own expansion. Appending a profile-style "(...)" here
  // would state a package set the registry was never asked for.
  assert.equal(value, 'account,media', 'the selection is reported verbatim');
});

// --- token introspection failures -------------------------------------------

test('an expired token fails the health check with a non-zero exit', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({
          data: { is_valid: true, expires_at: (NOW - DAY) / 1000, scopes: ['instagram_basic'] },
        }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.ok(res.report.includes('Token expiry: expired'), 'the verdict is stated');
  // is_valid=true and a reachable account are not enough: a token Graph still
  // accepts today but that expired by our own clock must not report green.
  assert.notEqual(res.exitCode, 0, 'an expired token is a failed health check');
  assert.ok(!res.report.includes('Health check passed'), 'the summary is not green');
});

/** Throw a value that is deliberately not an `Error` (the `String(err)` tail). */
function raise(value: unknown): never {
  throw value as Error;
}

test('an introspection call that throws is rendered as a failure line, not a crash', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => raise(new Error('socket hang up')),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.ok(
    res.report.includes('Token introspection failed: socket hang up'),
    'the reason reaches the operator',
  );
  // The reachability section still ran — one failed check must not abort the rest.
  assert.ok(res.report.includes('Reachability OK'), 'later checks still run');
  assert.notEqual(res.exitCode, 0);
});

test('an introspection failure that is not an Error is still described, never "[object Object]"', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => raise('graph refused the connection'),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.ok(
    res.report.includes('Token introspection failed: graph refused the connection'),
    'a thrown non-Error is stringified rather than dropped',
  );
  assert.notEqual(res.exitCode, 0);
});

test('an InstagramError from introspection surfaces its Graph codes for the docs lookup', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () =>
          raise(
            new InstagramError('Error validating access token', {
              kind: 'auth',
              status: 400,
              code: 190,
              subcode: 460,
            }),
          ),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  const line = res.report.split('\n').find((l) => l.includes('Token introspection failed'));
  assert.ok(line !== undefined, 'the failure line is present');
  // code+subcode is what docs/operations.md §3 is indexed by: 190/460 means
  // "password changed", 190/463 means "expired" — the subcode is the diagnosis.
  assert.ok(line.includes('kind=auth'), 'the discriminant is named');
  assert.ok(line.includes('code=190'), 'the Graph code is carried through');
  assert.ok(line.includes('subcode=460'), 'the subcode is carried through');
  assert.ok(line.includes('status=400'), 'the HTTP status is carried through');
});

// --- TTY colorization -------------------------------------------------------

/**
 * Run `body` with stdout pretending to be an interactive, color-capable
 * terminal, restoring both `isTTY` and `NO_COLOR` afterwards.
 */
async function withTty(body: () => Promise<void>): Promise<void> {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const noColor = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    delete process.env.NO_COLOR;
    await body();
  } finally {
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
    if (tty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, 'isTTY', tty);
  }
}

test('a report to a TTY is colorized, and NO_COLOR turns it off', async () => {
  await withTty(async () => {
    const colored = await runDoctor({
      req: healthyReq(),
      profile: fbProfile(),
      settings: baseSettings,
      nowMs: NOW,
    });
    assert.ok(colored.report.includes('\u001B['), 'an interactive terminal gets ANSI colors');
    assert.ok(colored.report.includes('Health check passed'), 'and the content is unchanged');

    // NO_COLOR is honored regardless of its value — presence alone opts out.
    process.env.NO_COLOR = '';
    const plain = await runDoctor({
      req: healthyReq(),
      profile: fbProfile(),
      settings: baseSettings,
      nowMs: NOW,
    });
    assert.ok(!plain.report.includes('\u001B['), 'NO_COLOR suppresses every escape sequence');
  });
});

test('a failing check is labelled FAIL and colored red on a TTY', async () => {
  await withTty(async () => {
    const res = await runDoctor({
      req: fakeReq(
        routing({
          account: () =>
            raise(new InstagramError('session has expired', { kind: 'auth', status: 401 })),
        }),
      ).req,
      profile: igProfile(),
      settings: baseSettings,
      nowMs: NOW,
    });

    const line = res.report.split('\n').find((l) => l.includes('Reachability FAILED'));
    assert.ok(line !== undefined, 'the failure line is present');
    // Label and color are the whole scanning affordance of the report. A
    // failure painted in the warning yellow, or carrying the WARN label, reads
    // as "degraded but working" and gets postponed instead of fixed.
    const red = `${String.fromCharCode(27)}[31m`;
    assert.ok(line.includes(red), 'failures are red, not the warning yellow');
    assert.ok(line.includes('  FAIL  '), 'and carry the FAIL label, not WARN');
  });
});

// --- report layout ----------------------------------------------------------

test('the header names the profile and the Graph host its calls will hit', async () => {
  const fb = await runDoctor({
    req: healthyReq(),
    profile: fbProfile({ name: 'marketing' }),
    settings: baseSettings,
    nowMs: NOW,
  });
  const ig = await runDoctor({
    req: fakeReq(routing({ account: () => ({ id: '178414', username: 'acme' }) })).req,
    profile: igProfile({ name: 'creator' }),
    settings: baseSettings,
    nowMs: NOW,
  });

  // This single line is what an operator with several profiles reads to know
  // whose credentials were just tested and which Graph host answered. Naming
  // the auth path instead of the profile, or pairing a path with the other
  // path's host, sends them editing the wrong config entry.
  assert.ok(fb.report.includes('Active profile: marketing (fb-login'), 'the profile is named');
  assert.ok(fb.report.includes('graph.facebook.com'), 'Path B targets the Facebook host');
  assert.ok(!fb.report.includes('graph.instagram.com'), 'and never the Instagram host');
  assert.ok(ig.report.includes('Active profile: creator (ig-login'), 'the profile is named');
  assert.ok(ig.report.includes('graph.instagram.com'), 'Path A targets the Instagram host');
  assert.ok(!ig.report.includes('graph.facebook.com'), 'and never the Facebook host');
});

test('the report is laid out in the section order documented in operations.md §6', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  // Section headings are the unindented lines after the two header lines. The
  // order is the diagnostic order an operator reads top-down — what the server
  // resolved, then the token, then whether the API answers — and a heading that
  // names the wrong section makes the whole report unquotable in a bug report.
  const headings = res.report
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('  '))
    .slice(2);
  assert.deepEqual(headings, [
    'Configuration',
    'Token & authentication',
    'Reachability',
    'Meta app mode (Development vs Live)',
    'Summary',
  ]);
});

// --- configuration values ---------------------------------------------------

/** The value of a `Label:` line in a report, without its alignment padding. */
function configValue(report: string, label: string): string {
  const line = report.split('\n').find((l) => l.includes(label));
  assert.ok(line !== undefined, `the report has a ${label} line`);
  return line.slice(line.indexOf(label) + label.length).trim();
}

test('the configuration block prints the resolved values, not just the labels', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({
      transport: 'http',
      writeMode: 'apply',
      allowDestructive: true,
      refreshAfterDays: 7,
      writeJournal: join(journalRoot, 'values', 'writes.jsonl'),
    }),
    nowMs: NOW,
  });

  // Every knob is read off a different settings field, and printing a
  // neighbouring one is invisible on a default config while lying about the
  // running server — "Allow destructive: false" on a box that will happily
  // delete media is the reason an operator ran doctor in the first place.
  assert.equal(configValue(res.report, 'Transport:'), 'http');
  assert.equal(configValue(res.report, 'Write mode:'), 'apply');
  assert.equal(configValue(res.report, 'Allow destructive:'), 'true');
  assert.equal(configValue(res.report, 'Refresh after:'), '7 day(s)');
});

test('a journal with nothing to report is an INFO line, like its neighbours', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({
      writeMode: 'apply',
      writeJournal: join(journalRoot, 'info-label', 'writes.jsonl'),
    }),
    nowMs: NOW,
  });

  // The probe only stats a path; it never proved a record landed there. An OK
  // label would read as a verified-healthy audit trail — precisely the claim
  // this check is not able to make.
  assert.ok(journalLine(res.report).startsWith('  INFO'), 'the journal line is INFO, not OK');
});

test('a journal of exactly one kibibyte is sized in KiB, not in bytes', async () => {
  const dir = mkdtempSync(join(journalRoot, 'kib-'));
  const writeJournal = join(dir, 'writes.jsonl');
  writeFileSync(writeJournal, 'x'.repeat(1024));

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'apply', writeJournal }),
    nowMs: NOW,
  });

  // The exact unit boundary: 1024 B is already a kibibyte, and the divisor has
  // to match the unit printed next to it.
  assert.ok(journalLine(res.report).includes('1.0 KiB'), 'the byte/KiB boundary is exclusive');
});

test('a journal of exactly one mebibyte is sized in MiB, not in four-digit KiB', async () => {
  const dir = mkdtempSync(join(journalRoot, 'mib-'));
  const writeJournal = join(dir, 'writes.jsonl');
  writeFileSync(writeJournal, 'x'.repeat(1024 * 1024));

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'apply', writeJournal }),
    nowMs: NOW,
  });

  assert.ok(journalLine(res.report).includes('1.0 MiB'), 'the KiB/MiB boundary is exclusive');
});

// --- package selection: the summary must mirror the registry's parsing ------

test('a profile name is matched case-insensitively, exactly as the registry does', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_TOOL_PACKAGES: 'Reader' },
  });

  const line = packagesLine(res.report);
  // The registry lowercases the selection before resolving it, so `Reader` really
  // does register the reader profile. A summary that echoed it as an opaque
  // literal would under-report the exposed surface for a capitalised value.
  assert.ok(line.includes('discovery'), `the profile is expanded: ${line}`);
  assert.ok(line.includes('forced read-only'), 'and its read-only guarantee is surfaced');
});

test('the all selection is reported as every package, not echoed as a literal', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_TOOL_PACKAGES: 'all' },
  });

  assert.ok(
    packagesLine(res.report).includes('every package'),
    'all is a selection, not a package',
  );
});

test('a default package selection is marked as a default, an explicit one is not', async () => {
  const implicit = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: {},
  });
  const explicit = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_TOOL_PACKAGES: 'core' },
  });

  // The marker answers the question the line exists for: "is this what I
  // configured, or what the server fell back to?" Inverted, it tells an
  // operator their IG_TOOL_PACKAGES never took effect.
  assert.ok(packagesLine(implicit.report).includes('(default: '), 'the fallback is labelled');
  assert.ok(!packagesLine(explicit.report).includes('default: '), 'an explicit choice is not');
});

test('surrounding whitespace in IG_TOOL_PACKAGES is ignored', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_TOOL_PACKAGES: '  publisher  ' },
  });

  // Env values arrive from shell exports and YAML blocks that carry stray
  // spaces; the registry trims before resolving, so a padded value really is
  // the publisher profile and the summary must not report it as unknown.
  assert.ok(packagesLine(res.report).includes('publishing'), 'a padded profile still expands');
});

test('an empty IG_TOOL_PACKAGES is the default profile, not an empty selection', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_TOOL_PACKAGES: '' },
  });

  const line = packagesLine(res.report);
  // `IG_TOOL_PACKAGES=` in an env file is an unset variable as far as the
  // registry is concerned; reporting it as a selection would print a blank
  // package list for a server that is in fact serving the whole core profile.
  assert.ok(line.includes('default: '), 'a blank value is not an operator choice');
  assert.ok(line.includes('publishing'), `the core profile is expanded: ${line}`);
});

// --- token introspection details --------------------------------------------

test('a debug_token payload without is_valid is not reported as an invalid token', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({
          data: { expires_at: (NOW + 200 * DAY) / 1000, scopes: ['instagram_basic'] },
        }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  // Meta omits fields rather than nulling them (CC-DATA-2). Only an explicit
  // is_valid=false is a verdict; treating a missing field as one would fail the
  // health check — and send the operator re-running `login` — for a profile
  // whose reachability GET succeeded moments later.
  assert.ok(!res.report.includes('INVALID'), 'a missing field is not a verdict');
  assert.ok(res.report.includes('Token is valid'), 'the token is not declared broken');
  assert.equal(res.exitCode, 0);
});

test('an empty scope list is reported as none-reported, never as a granted set', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  const line = res.report.split('\n').find((l) => l.includes('Granted scopes:'));
  assert.ok(line !== undefined, 'the scopes line is present');
  // An empty list is the shape of a token that will 403 on the first real call.
  // Rendering it as an OK line with nothing after the colon hides that behind
  // what looks like a satisfied check.
  assert.ok(line.includes('(none reported by debug_token)'), 'the emptiness is spelled out');
  assert.ok(line.startsWith('  INFO'), 'and it is not asserted as an OK scope set');
});

test('granted scopes are listed comma-separated', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({
          data: {
            is_valid: true,
            expires_at: (NOW + 200 * DAY) / 1000,
            scopes: ['instagram_basic', 'pages_show_list', 'business_management'],
          },
        }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  // Scope names are copied out of this line into the Meta App Dashboard and
  // into docs/operations.md tables; space-separated they cannot be pasted as a
  // list, and a missing scope is hard to spot in a run-on string.
  assert.equal(
    configValue(res.report, 'Granted scopes:'),
    'instagram_basic, pages_show_list, business_management',
  );
});

test('a valid token states its absolute expiry as well as the days left (CC-AUTH-13)', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  const line = res.report.split('\n').find((l) => l.includes('Token expiry:'));
  assert.ok(line !== undefined, 'the expiry line is present');
  // "Valid" alone is unactionable, and a countdown alone is unverifiable
  // against a skewed clock: the absolute timestamp is what an operator compares
  // with the token's expiry in the Meta dashboard.
  assert.ok(line.includes(new Date(NOW + 200 * DAY).toISOString()), 'the ISO expiry is stated');
  assert.ok(line.includes('~200 day(s) left'), 'and the countdown alongside it');
});

test('path A reports the token expiry as unknown rather than guessing (CC-AUTH-7)', async () => {
  const res = await runDoctor({
    req: fakeReq(routing({ account: () => ({ id: '178414', username: 'acme' }) })).req,
    profile: igProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  const line = res.report.split('\n').find((l) => l.includes('Token expiry:'));
  assert.ok(line !== undefined, 'the expiry line is present');
  assert.ok(line.includes('Token expiry: unknown'), 'the honest answer is "I cannot tell"');
  // Path A has no debug_token, which is not the same as a token that never
  // expires: claiming the latter buries the one warning that would have told
  // the operator to re-run `login` before the token silently dies.
  assert.ok(!res.report.includes('never expires'), 'absent metadata is not an eternal token');
  // Path A is a fully supported deployment, not a broken one. A FAIL line here
  // would contradict the green summary of the very same run.
  assert.ok(!res.report.includes('FAIL'), 'an unknown expiry is not a failure');
  assert.equal(res.exitCode, 0);
});

test('the App Dashboard pointer names the app the token really belongs to', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({
          data: {
            is_valid: true,
            app_id: '99999',
            expires_at: (NOW + 200 * DAY) / 1000,
            scopes: [],
          },
        }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile({ appId: '55500' }),
    settings: baseSettings,
    nowMs: NOW,
  });

  // The configured id is what we believe; introspection reports the app the
  // token was actually issued for. When they disagree the token wins — printing
  // the configured id points the operator at a dashboard whose Development/Live
  // switch has nothing to do with the calls this server makes.
  assert.ok(res.report.includes('(App ID 99999)'), 'introspection outranks configuration');
  assert.ok(!res.report.includes('(App ID 55500)'), 'the stale configured id is not asserted');
});

test('the App Dashboard pointer omits the app id when nothing reported one', async () => {
  const res = await runDoctor({
    req: fakeReq(routing({ account: () => ({ id: '178414' }) })).req,
    profile: igProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.ok(res.report.includes('Development vs Live'), 'the pointer line is still printed');
  assert.ok(!res.report.includes('App ID'), 'an unknown id is left out, not printed as undefined');
});

// --- reachability -----------------------------------------------------------

test('the reachability GET targets the account id the profile is pinned to', async () => {
  const { req, calls } = fakeReq(
    routing({
      debug: () => ({ data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] } }),
      account: () => ({ id: '178414', username: 'acme' }),
    }),
  );

  const res = await runDoctor({
    req,
    profile: fbProfile({ accountId: '178414' }),
    settings: baseSettings,
    nowMs: NOW,
  });

  // `GET /me` only proves the token resolves to something. Every tool call this
  // server makes is scoped to the configured account, so a token that cannot
  // read *that* account is broken here even while /me happily answers.
  const account = calls.find((c) => c.path !== '/debug_token');
  assert.ok(account !== undefined, 'a reachability call was issued');
  assert.equal(account.path, '/178414', 'the configured id is the one fetched');
  assert.ok(res.report.includes('GET /178414'), 'and the report names it');
});

test('a profile with no account id falls back to /me and reports the resolved id', async () => {
  const { req, calls } = fakeReq(
    routing({
      debug: () => ({ data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] } }),
      account: () => ({ id: '999888', username: 'acme' }),
    }),
  );

  const res = await runDoctor({
    req,
    profile: fbProfile({ accountId: undefined }),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.ok(
    calls.some((c) => c.path === '/me'),
    'the fallback id is what gets fetched',
  );
  // Echoing the requested id back would make this line true by construction.
  // The id Graph resolved is the whole point: it is how an operator running
  // without IG_ACCOUNT_ID learns which account the token actually drives.
  assert.ok(res.report.includes('resolved account id=999888'), 'the resolved id is reported');
  assert.equal(res.exitCode, 0);
});

// --- secret safety: exact registration, not the shape backstops -------------

test('a token that matches no shape pattern is still redacted (CC-AUTH-7)', async () => {
  const pasted = 'pasted-from-graph-explorer-2f4a6c8e';
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({
          data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] },
        }),
        account: () =>
          raise(
            new InstagramError(`invalid OAuth access token ${pasted}`, {
              kind: 'auth',
              status: 401,
            }),
          ),
      }),
    ).req,
    profile: fbProfile({ accessToken: pasted }),
    settings: baseSettings,
    nowMs: NOW,
  });

  // The `EAA…`/`IG…` patterns are a backstop, not the mechanism. A token pasted
  // by hand out of the Graph Explorer (CC-AUTH-7) matches none of them, so only
  // registering this run's exact secrets keeps it out of a report the operator
  // is about to paste into an issue tracker.
  assert.ok(!res.report.includes(pasted), 'the raw token must never appear');
  assert.ok(res.report.includes('[REDACTED]'), 'it was masked as an exact secret');
});

test('the app secret is redacted if an upstream message ever echoes it', async () => {
  const appSecret = 'app-secret-value-0123456789';
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () =>
          raise(
            new InstagramError(`appsecret_proof does not match secret ${appSecret}`, {
              kind: 'auth',
              status: 400,
              code: 190,
            }),
          ),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile({ appSecret }),
    settings: baseSettings,
    nowMs: NOW,
  });

  // The app secret has no recognisable shape at all — no prefix, no fixed
  // length — so it is invisible to every pattern. It is also the one secret
  // that a proof-mismatch error is most likely to quote back at us.
  assert.ok(!res.report.includes(appSecret), 'the app secret must never appear');
  assert.ok(res.report.includes('[REDACTED]'), 'it was masked as an exact secret');
});

// --- telemetry --------------------------------------------------------------

interface LogRecord {
  msg: string;
  fields?: Record<string, unknown>;
}

/** A logger that records `info` records so the completion telemetry is assertable. */
function capturingLog(records: LogRecord[]): Logger {
  const log: Logger = {
    debug() {},
    info(msg, fields) {
      records.push({ msg, fields });
    },
    warn() {},
    error() {},
    child() {
      return log;
    },
  };
  return log;
}

test('the completion log records the real verdict, not an optimistic one', async () => {
  const records: LogRecord[] = [];
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({
          data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] },
        }),
        account: () =>
          raise(
            new InstagramError('session has expired', { kind: 'auth', status: 401, code: 190 }),
          ),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    log: capturingLog(records),
    nowMs: NOW,
  });

  const completed = records.find((r) => r.msg === 'doctor: completed');
  assert.ok(completed !== undefined, 'completion is logged');
  // The report goes to a human's terminal; this record is what a wrapper script
  // or a log pipeline alerts on. A hardcoded `healthy: true` would keep a dead
  // profile invisible to everything except someone reading stdout.
  assert.equal(completed.fields?.healthy, false, 'the logged verdict matches the report');
  assert.equal(completed.fields?.exitCode, res.exitCode, 'and so does the exit code');
  assert.notEqual(res.exitCode, 0);
});
