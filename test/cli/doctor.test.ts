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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

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

/** The full report line (label included) whose text contains `needle`. */
function lineWith(report: string, needle: string): string {
  const line = report.split('\n').find((l) => l.includes(needle));
  assert.ok(line !== undefined, `the report has a line containing "${needle}"`);
  return line;
}

test('the verdict lines are pinned whole: each names its remediation, not just its state', async () => {
  // These are the lines an operator pastes into a ticket. `includes('INVALID')`
  // or `includes('Health check FAILED')` would still pass with the second half —
  // "run the `login` CLI", "see the FAIL line(s) above; fix ... and re-run" —
  // cut off, and the state without the next step is exactly the report that
  // gets a reply of "so what do I do?". Whole lines, label included.
  const green = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });
  assert.equal(
    lineWith(green.report, 'Health check'),
    '  OK    Health check passed — the active profile can reach the Instagram Graph API.',
  );
  // The validity verdict says WHERE it came from. Path A prints an INFO line
  // admitting introspection is unavailable; a Path B line reduced to "Token is
  // valid." would read the same in both reports and hide which one ran.
  assert.equal(
    lineWith(green.report, 'Token is valid'),
    '  OK    Token is valid (Path B introspection via debug_token).',
  );

  const invalid = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({ data: { is_valid: false, app_id: '55500' } }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });
  assert.equal(
    lineWith(invalid.report, 'INVALID'),
    '  FAIL  Token introspection reports the token is INVALID (is_valid=false) — run the `login` CLI to obtain a new token.',
  );
  assert.equal(
    lineWith(invalid.report, 'Health check'),
    '  FAIL  Health check FAILED — see the FAIL line(s) above; fix the reported issue and re-run `doctor`.',
  );

  const expired = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({ data: { is_valid: true, expires_at: (NOW - DAY) / 1000, scopes: [] } }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });
  assert.equal(
    lineWith(expired.report, 'Token expiry:'),
    `  FAIL  Token expiry: expired — Token expired at ${new Date(NOW - DAY).toISOString()}; ` +
      'run the `login` CLI to obtain a new one.',
  );

  // The failed GET names the id it was sent to. When the configured account
  // id is the mistake (a typo, a page id instead of the IG user id), the path
  // in this line is the only clue; a line hard-wired to `/me` would send the
  // operator to check the token instead of the id.
  const unreachable = await runDoctor({
    req: fakeReq(
      routing({
        account: () => {
          throw new InstagramError('Unsupported get request. Object with ID does not exist', {
            kind: 'validation',
            status: 400,
            code: 100,
            subcode: 33,
          });
        },
      }),
    ).req,
    profile: igProfile({ accountId: '178414' }),
    settings: baseSettings,
    nowMs: NOW,
  });
  assert.equal(
    lineWith(unreachable.report, 'Reachability FAILED'),
    '  FAIL  Reachability FAILED — GET /178414: Unsupported get request. Object with ID does not exist ' +
      '[kind=validation, code=100, subcode=33, status=400]',
  );
});
test('the remaining verdict lines are pinned whole, not by the word that names their state', async () => {
  // The companion to the test above, for the lines it did not reach. Each of
  // these is asserted elsewhere in this file by a fragment that is the NAME of
  // the state — `Reachability OK`, `expiring_soon`, `Token expiry: unknown`,
  // `Development vs Live`, `(none reported by debug_token)` — plus, at most, one
  // interpolated value looked up separately. A name and a value are not a
  // sentence: every one of those assertions still passes when the clause that
  // turns the state into something an operator can act on has been dropped,
  // reworded, or left pointing at a different value than the one it announces.
  //
  // That matters more here than anywhere else in the CLI, because this report
  // is written to be PASTED. It is the artefact that travels to a colleague, a
  // ticket or a support thread, where the person reading it cannot re-run the
  // command, cannot see the profile, and has nothing but these lines. A line
  // that has lost its second half is not obviously incomplete to them — it
  // reads as a tool that had nothing more to say.
  //
  // Three runs cover every remaining state: a healthy Path B profile, the same
  // profile near expiry, and a Path A profile with no configured account id and
  // no app id (which is also the only way to reach the two lines that omit
  // their optional clause).
  const healthy = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: {},
  });
  const soon = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({ data: { is_valid: true, expires_at: (NOW + 3 * DAY) / 1000, scopes: [] } }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: {},
  });
  const pathA = await runDoctor({
    req: fakeReq(routing({ account: () => ({ id: '999888' }) })).req,
    profile: igProfile({ accountId: undefined }),
    settings: baseSettings,
    nowMs: NOW,
    env: {},
  });

  const pinned: { what: string; line: string; expected: string }[] = [
    {
      // The only line in the report that proves the token performed a real
      // call, and the three facts in it are three different answers: WHICH id
      // was fetched (the configured one, or `me`), which id Graph resolved it
      // to, and whose handle that is. `Reachability OK` on its own says a
      // request succeeded against an account nobody has identified — and the
      // pair `GET /178414 … id=178414` is what tells the operator their
      // configured id is the account they think it is.
      what: 'reachability, with a configured id and a handle',
      line: lineWith(healthy.report, 'Reachability OK'),
      expected: '  OK    Reachability OK — GET /178414 resolved account id=178414 (@acme).',
    },
    {
      // `~200 day(s) left` is the number an operator plans around, and the ISO
      // timestamp is what makes it checkable against a clock that may be
      // skewed. Neither is a verdict: `valid` is, and it is the word the
      // summary's green line is consistent with. A line that keeps the
      // countdown and loses "valid" sits in a column of labelled verdicts
      // saying only that a date exists.
      what: 'a token comfortably in date',
      line: lineWith(healthy.report, 'Token expiry:'),
      expected: `  OK    Token expiry: valid — expires ${new Date(NOW + 200 * DAY).toISOString()} (~200 day(s) left).`,
    },
    {
      // Introspection answered, and answered with nothing. The parenthesis is
      // the whole content of the line: it says the emptiness is what
      // `debug_token` reported, not what doctor failed to read — the
      // difference between "this token will 403 on its first call" and "this
      // check did not run". Both readings are consistent with an empty value
      // after the colon.
      what: 'a token that reports no scopes at all',
      line: lineWith(healthy.report, 'Granted scopes:'),
      expected: '  INFO  Granted scopes: (none reported by debug_token)',
    },
    {
      // The pointer line, with the id it could name. The operator is being
      // sent to a dashboard, and Meta accounts routinely hold several apps —
      // the id is which one to open. The sentence after it is the reason to go
      // at all, and the assertion that exists for it is an `endsWith`, so
      // everything in front of the consequence, the app id included, is
      // unpinned without this row.
      what: 'the app-mode pointer when an app id is known',
      line: lineWith(healthy.report, 'Meta App Dashboard'),
      expected:
        '  INFO  Meta app mode is not exposed by token introspection — verify Development vs ' +
        'Live in the Meta App Dashboard (App ID 55500). Development-mode apps may face lower ' +
        'rate limits and can only act on app roles/testers.',
    },
    {
      // Near-expiry is the one verdict with a deadline attached, and the
      // remedy names both CLIs on purpose: `refresh` extends a Path B token in
      // place, `login` mints a new one, and which is appropriate depends on a
      // path this line does not know. Reduced to `expiring_soon` — the word the
      // existing assertion matches — it is a warning with no date, no
      // countdown and no command.
      what: 'a token inside the refresh window',
      line: lineWith(soon.report, 'Token expiry:'),
      expected: `  WARN  Token expiry: expiring_soon — Token expires at ${new Date(NOW + 3 * DAY).toISOString()} (~3 day(s) left); run the \`refresh\` or \`login\` CLI.`,
    },
    {
      // Path A has no `debug_token`, so with no usable record the expiry is
      // genuinely unknown — and "unknown" is the word a reader discounts. The
      // clause after it is what stops them discounting it: it names the record
      // that is missing, why a hand-pasted token has none, and both ways to
      // supply one. `Token expiry: unknown` matched on its own cannot tell that
      // clause from an empty apology.
      what: 'an expiry nothing reported',
      line: lineWith(pathA.report, 'Token expiry:'),
      expected:
        '  INFO  Token expiry: unknown — Token expiry is unknown: no usable expiry is recorded ' +
        'in IG_TOKEN_EXPIRES_AT for this token (a hand-pasted token has none, a record that is not ' +
        'whole Unix seconds (one in milliseconds, say) is not read, and a record from ' +
        'a different source than the token, or written for a different token, is ignored). Run the `login` CLI to mint a token and ' +
        "record its expiry, or set IG_TOKEN_EXPIRES_AT to the token's expiry in Unix seconds.",
    },
    {
      // The same two lines on a profile that supplies neither optional value,
      // which is the state in which their punctuation is easiest to get wrong:
      // the handle clause and the app-id clause both sit immediately before a
      // full stop, and a version that emits the separator unconditionally
      // prints ` .` or `(App ID ).` here while staying invisible on every
      // fixture that has the value. `!report.includes('(@')` catches the
      // phantom handle but says nothing about the rest of the sentence.
      what: 'reachability with no configured id and no handle',
      line: lineWith(pathA.report, 'Reachability OK'),
      expected: '  OK    Reachability OK — GET /me resolved account id=999888.',
    },
    {
      what: 'the app-mode pointer when no app id is known',
      line: lineWith(pathA.report, 'Meta App Dashboard'),
      expected:
        '  INFO  Meta app mode is not exposed by token introspection — verify Development vs ' +
        'Live in the Meta App Dashboard. Development-mode apps may face lower rate limits and ' +
        'can only act on app roles/testers.',
    },
  ];

  for (const { what, line, expected } of pinned) assert.equal(line, expected, what);
});

test('reachability does not coerce a blank configured account id into /me', async () => {
  // `profile.accountId ?? 'me'` uses `??` on purpose. With `||` a blank id falls
  // through to `/me`, the token owner's account answers, and the report says
  // `Reachability OK` for an account the operator never configured. `??` keeps
  // the blank id, so the probe goes to `GET /`, fails upstream, and the report
  // names the path it used. (`instagram_get_account` pins the same distinction.)
  const { req, calls } = fakeReq(
    routing({
      account: () => {
        throw new InstagramError('Unsupported get request.', { kind: 'upstream', status: 400 });
      },
    }),
  );

  const res = await runDoctor({
    req,
    profile: igProfile({ accountId: '' }),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.equal(calls[0]?.path, '/', 'a blank id is sent as blank, never silently as `me`');
  assert.notEqual(calls[0]?.path, '/me');
  assert.equal(res.exitCode, 1, 'the blank id surfaces as an unhealthy report');
  assert.ok(
    lineWith(res.report, 'Reachability FAILED').includes('GET /: '),
    'the report names the blank path it probed',
  );
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
  // The whole line, because the two halves mean nothing apart. "Introspection is
  // unavailable" on its own reads as a defect and invites an operator to go
  // hunting for the app secret that would supposedly fix it; the second half is
  // what says this is normal for ig-login and points at the check that DOES
  // answer "is this token good" — without it the report admits a blind spot and
  // never tells the reader where the sighted part of it is.
  assert.equal(
    lineWith(res.report, 'Path A'),
    '  INFO  Path A (ig-login): token introspection via `debug_token` is unavailable; ' +
      'token validity is confirmed only by the reachability check below.',
  );
  assert.ok(!calls.some((c) => c.path === '/debug_token'), 'debug_token is never called on Path A');
  // One call: the account-identity check (CC-AUTH-6) reads the reachability
  // answer and never issues a GET of its own.
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/178414'],
    'only the reachability GET is issued',
  );
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

test('a blank deny or read-only list is not rendered as an empty refinement', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_PACKAGES_DENY: '', IG_PACKAGES_READONLY: '   ' },
  });

  const line = packagesLine(res.report);
  // `IG_PACKAGES_DENY=` in an env file is how an operator UNSETS a refinement,
  // and the registry treats a blank value as no refinement at all. Rendering it
  // as `(deny: )` would state that a filter is in force and then decline to name
  // it — the one reading of this line that sends someone hunting a filter that
  // does not exist.
  assert.ok(!line.includes('(deny:'), `no deny clause for a blank value: ${line}`);
  assert.ok(!line.includes('(read-only:'), `no read-only clause for a blank value: ${line}`);
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
  const writeJournal = join(journalRoot, 'preview', 'writes.jsonl');

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'preview', writeJournal }),
    nowMs: NOW,
  });

  const line = journalLine(res.report);
  // A bare path in preview mode reads as "my audit trail is live" when in fact
  // the journal only ever receives entries for an APPLIED write. The clause is
  // pinned whole because its last third is the part that is useful: an operator
  // told only that nothing is recorded knows the trail is dead but not how to
  // start it, and `apply:true` is the half that matters most — it turns a single
  // call into a real write without restarting the server under a new
  // environment, and it is the escape hatch nothing else in the report names.
  assert.equal(
    line,
    `  INFO  Write journal:      ${writeJournal} (preview mode — nothing is recorded until a ` +
      'write is applied via IG_WRITE_MODE=apply or apply:true; not created yet — it appears on ' +
      'the first applied write)',
  );
});

test('in apply mode the journal line states that applied writes are appended', async () => {
  const writeJournal = join(journalRoot, 'apply', 'writes.jsonl');

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'apply', writeJournal }),
    nowMs: NOW,
  });

  const line = journalLine(res.report);
  assert.ok(!line.includes('preview mode'), 'apply mode is not described as preview');
  // "apply mode" on its own is a restatement of the `Write mode:` line two rows
  // up. What this clause adds is the promise that the file below is where every
  // applied write ends up — the reason an operator can treat it as the audit
  // trail rather than as a sample. Reduced to the mode name it stops answering
  // the only question the line exists for, and the reader is left assuming the
  // same coverage without anything having said so.
  assert.equal(
    line,
    `  INFO  Write journal:      ${writeJournal} (apply mode — every applied write is appended ` +
      'here; not created yet — it appears on the first applied write)',
  );
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
  // "not created yet" alone is a fact with two opposite readings — a journal
  // that has not been set up, or one that simply has nothing to hold yet. The
  // second half is what settles it, and it is also the instruction: an operator
  // who wants to see the file appear has to apply a write, not create the file
  // by hand (doctor deliberately never does, and a hand-made file proves
  // nothing about whether the gate can append to it).
  assert.ok(
    line.includes('; not created yet — it appears on the first applied write)'),
    `a missing journal is a normal state with a stated cure: ${line}`,
  );
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

test('a relative journal path is walked from the process cwd, not from the cwd-relative dot', async () => {
  const dir = mkdtempSync(join(journalRoot, 'relative-'));
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'a regular file where a directory has to go');
  const relativeJournal = relative(process.cwd(), join(blocker, 'writes.jsonl'));

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'apply', writeJournal: relativeJournal }),
    nowMs: NOW,
  });

  // `IG_WRITE_JOURNAL` is a plain env string and nothing forces it absolute, so
  // a relative one reaches the probe as written. Walking it unresolved answers
  // in cwd-relative names and stops at `.` instead of at the filesystem root:
  // the operator is told some `../../x` is not a directory, which names a
  // different path depending on where the server was started from and is not the
  // path an append would actually fail on.
  //
  // The `NOT writable (` prefix is what makes this assertion discriminating. A
  // bare `includes(blocker)` passes on the unresolved answer too, because
  // `../../../var/…/blocker` CONTAINS the absolute `/var/…/blocker` as a
  // substring; anchoring at the start of the reason is what rejects the `..`
  // prefix.
  assert.ok(
    journalLine(res.report).includes(`NOT writable (${blocker} is not a directory)`),
    `the blocking ancestor is named absolutely: ${journalLine(res.report)}`,
  );
});

test('a journal path whose `..` crosses a symlink is diagnosed from its parent, not itself', async () => {
  // `nearestExistingDir` starts its walk at `dirname(resolve(path))`, and the
  // `dirname` used to be justified as saving one syscall: `probeJournal` only
  // calls the walk after `statSync(path)` came back `undefined`, so stating the
  // path itself would stat something already known to be absent.
  //
  // That holds only while the two spellings name the same file, and they come
  // apart here. `resolve` collapses `..` LEXICALLY; the kernel expands symlinks
  // FIRST. With `<d>/a/link -> <d>/real`, the kernel reads
  // `<d>/a/link/../writes.jsonl` as `<d>/writes.jsonl` — absent, so the probe
  // falls through to the walk — while `resolve` reads it as
  // `<d>/a/writes.jsonl`, which exists here as a regular file. Drop the
  // `dirname` and the walk's first iteration stats that file and answers
  // `notDir`, so a journal that will be created without trouble is reported as
  // `WARN … NOT writable`.
  //
  // What is asserted is the STATUS, never the ancestor. Both spellings diagnose
  // an ancestor the append would not use — the real parent is `<d>` — and that
  // limitation is documented at the walk and as CC-CFG-29 rather than pinned,
  // because pinning `<d>/a` would bless a wrong answer. The status has no such
  // problem: `<d>/writes.jsonl` can indeed be created on the first applied
  // write, `absent` is the correct verdict, and the `absent` branch prints no
  // path at all.
  const dir = mkdtempSync(join(journalRoot, 'symlinked-dotdot-'));
  mkdirSync(join(dir, 'real'));
  mkdirSync(join(dir, 'a'));
  symlinkSync(join(dir, 'real'), join(dir, 'a', 'link'), 'dir');
  writeFileSync(join(dir, 'a', 'writes.jsonl'), 'a regular file at the LEXICAL parent\n');
  // Built by concatenation, not `join`: `join` would collapse the `..` itself
  // and the two spellings would never separate.
  const writeJournal = `${join(dir, 'a', 'link')}/../writes.jsonl`;

  assert.ok(
    !existsSync(writeJournal),
    'the kernel resolves the journal path to something absent, which is what sends ' +
      'probeJournal into the ancestor walk in the first place',
  );

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeMode: 'apply', writeJournal }),
    nowMs: NOW,
  });

  const line = journalLine(res.report);
  assert.ok(
    line.includes('not created yet — it appears on the first applied write'),
    `a creatable journal is reported as creatable: ${line}`,
  );
  assert.ok(
    !line.includes('NOT writable'),
    `no spurious unwritable warning from the lexical spelling: ${line}`,
  );
  assert.ok(
    !res.report.includes(`WARN  Write journal:`),
    'the line keeps INFO status, so doctor raises no warning about a healthy sink',
  );
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
  // Pinned as a whole line: `includes('never expires')` also passes for the
  // negated sentence and for a line that has lost its `Token expiry:` label, and
  // an operator scanning for the expiry verdict would then find nothing where
  // the other two token states put theirs and conclude doctor failed to read it.
  // The full stop matters too — this is the one expiry verdict that asks for no
  // follow-up, so there is nothing after it to make its truncation visible.
  assert.equal(
    lineWith(res.report, 'Token expiry:'),
    '  OK    Token expiry: this token never expires.',
  );
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

test('every journal detail clause is pinned whole, mode clause included', async () => {
  // The `Write journal:` line is assembled from two independent halves — the
  // mode clause (will anything ever be written) and the detail clause (can
  // anything be written) — and the assertions above hold the mode clause whole
  // for exactly one detail, `absent`. Every other detail is reached by a
  // fragment: `includes('file exists')`, `includes('NOT writable')`,
  // `includes('not a regular file')`, `includes('will NOT be audited')`. Those
  // fragments are the words that name the state; what they cannot see is the
  // sentence around them, and this line is one sentence in two halves whose
  // meaning depends on being read together. "NOT writable" beside "preview
  // mode" is a latent problem; beside "apply mode" it means the audit trail an
  // operator believes they have is not being written right now. Split apart by
  // a refactor that keeps both fragments, the line still contains every word
  // the suite looks for and no longer says which of the two situations the
  // reader is in.
  //
  // Four fixtures, every one of them deterministic on any platform and any uid
  // (no chmod, so no root exemption): a file that exists, a regular file
  // standing where the journal's directory must go — in both write modes,
  // because that is the pair the `will`/`would` switch decides between — and a
  // path that is itself a directory.
  const present = mkdtempSync(join(journalRoot, 'pinned-present-'));
  const presentJournal = join(present, 'writes.jsonl');
  writeFileSync(presentJournal, '{"action":"publish_media"}\n');

  const blockedDir = mkdtempSync(join(journalRoot, 'pinned-blocked-'));
  const blocker = join(blockedDir, 'not-a-directory');
  writeFileSync(blocker, 'a regular file where a directory has to go\n');
  const blockedJournal = join(blocker, 'writes.jsonl');

  const isDirJournal = mkdtempSync(join(journalRoot, 'pinned-isdir-'));

  const APPLY = 'apply mode — every applied write is appended here';
  const PREVIEW =
    'preview mode — nothing is recorded until a write is applied via IG_WRITE_MODE=apply or ' +
    'apply:true';

  const line = async (settings: Parameters<typeof testSettings>[0]): Promise<string> =>
    journalLine(
      (
        await runDoctor({
          req: healthyReq(),
          profile: fbProfile(),
          settings: testSettings(settings),
          nowMs: NOW,
          env: {},
        })
      ).report,
    );

  assert.equal(
    await line({ writeMode: 'apply', writeJournal: presentJournal }),
    `  INFO  Write journal:      ${presentJournal} (${APPLY}; file exists, 27 B)`,
    'a journal that exists: the size is what tells an empty trail from a used one',
  );
  assert.equal(
    await line({ writeMode: 'apply', writeJournal: blockedJournal }),
    `  WARN  Write journal:      ${blockedJournal} (${APPLY}; NOT writable (${blocker} is not a ` +
      'directory) — applied writes will NOT be audited)',
    'blocked while applying: writes are happening right now and none of them is being recorded',
  );
  assert.equal(
    await line({ writeMode: 'preview', writeJournal: blockedJournal }),
    `  WARN  Write journal:      ${blockedJournal} (${PREVIEW}; NOT writable (${blocker} is not ` +
      'a directory) — applied writes would NOT be audited)',
    'blocked while previewing: the same defect, stated as the trap it will become',
  );
  assert.equal(
    await line({ writeMode: 'apply', writeJournal: isDirJournal }),
    `  WARN  Write journal:      ${isDirJournal} (${APPLY}; NOT writable (the path is not a ` +
      'regular file) — applied writes will NOT be audited)',
    'a directory where the file belongs: the reason names the path, not the append',
  );

  // The undetermined state carries a reason this test cannot spell out — it is
  // the operating system's own `statSync` message, and its text differs between
  // platforms and Node releases. Everything doctor itself writes around that
  // reason is pinned instead: the parenthesis opens where the injected text
  // begins and closes at the end of the line, which is what an assertion on the
  // reason alone cannot tell from a line that lost its mode clause.
  const undetermined = await line({
    writeMode: 'apply',
    writeJournal: join(journalRoot, 'z'.repeat(5000), 'writes.jsonl'),
  });
  const prefix = `  INFO  Write journal:      ${join(journalRoot, 'z'.repeat(5000), 'writes.jsonl')} (${APPLY}; state could not be determined (`;
  assert.ok(
    undetermined.startsWith(prefix),
    `the undetermined line is the same sentence up to the reason: ${undetermined}`,
  );
  assert.ok(undetermined.endsWith('))'), `and the reason closes the line: ${undetermined}`);
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

test('a ZERO code, subcode or status is still named in the diagnostic bracket', async () => {
  // Graph really does send `code: 0` ("An unexpected error has occurred"), and
  // `mapGraphError` is pinned to carry a zero through rather than read it as
  // absent (`test/core/errors.test.ts`). This bracket is the only place those
  // numbers reach the operator, and it is what gets quoted into a support
  // ticket. Rewritten as a truthiness test, the guards drop exactly the values
  // a zero carries — on the failure where the operator has least else to go on
  // — while staying invisible on every other fixture in this file, all of which
  // use truthy codes. `status` is pinned in the same row because it carries the
  // identical guard, not because a zero HTTP status is a thing Graph is known
  // to send. Measured 2026-09-23: without this row, each of the three guards
  // survives the whole suite as a truthiness test, adding no killer.
  const zeros = await runDoctor({
    req: fakeReq(
      routing({
        account: () => {
          throw new InstagramError('An unexpected error has occurred', {
            kind: 'upstream',
            status: 0,
            code: 0,
            subcode: 0,
          });
        },
      }),
    ).req,
    profile: igProfile({ accountId: '178414' }),
    settings: baseSettings,
    nowMs: NOW,
  });
  assert.equal(
    lineWith(zeros.report, 'Reachability FAILED'),
    '  FAIL  Reachability FAILED — GET /178414: An unexpected error has occurred ' +
      '[kind=upstream, code=0, subcode=0, status=0]',
  );
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

test('every section heading is preceded by a blank line, so the report scans as blocks', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  // The report is written to a terminal and pasted into issues verbatim. The
  // blank line is the only separator between a section's last status line and
  // the next heading — without it the headings sit flush against the indented
  // lines above them and the five blocks read as one wall of text.
  const lines = res.report.split('\n');
  const headings = lines
    .map((l, idx) => ({ l, idx }))
    .filter(({ l, idx }) => l !== '' && !l.startsWith('  ') && idx >= 2);
  assert.equal(headings.length, 5, 'all five headings are present');
  for (const { l, idx } of headings) {
    assert.equal(lines[idx - 1], '', `a blank line precedes '${l}'`);
  }
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

test('an uppercase ALL is expanded too, exactly as the registry lowercases it', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_TOOL_PACKAGES: 'ALL' },
  });

  // `selectPackages` compares the LOWERCASED selection against `'all'`, so
  // `IG_TOOL_PACKAGES=ALL` really does register every package, write tools
  // included. Matching case-sensitively here would echo it as an opaque literal
  // and under-report the widest surface this server can be configured with.
  const line = packagesLine(res.report);
  assert.ok(line.includes('ALL'), 'the operator\u2019s own spelling is echoed');
  assert.ok(line.includes('every package'), `and it is expanded: ${line}`);
});

test('an all selection is pinned whole: the spelling given, then every package, unqualified', async () => {
  // `includes('every package')` above cannot tell this line from one reading
  // "every package except the write tools", and that difference is the whole
  // reason the line exists. `IG_TOOL_PACKAGES=all` is the widest surface this
  // server can be configured with: it registers the publishing and comment
  // tools, which post, delete and reply AS the connected account. An operator
  // reads this line to decide whether a deployment can write at all, so the
  // claim has to arrive without a qualifier -- any qualifier here is a promise
  // the registry does not keep, and it is read as one.
  for (const spelling of ['all', 'ALL', 'All']) {
    const res = await runDoctor({
      req: healthyReq(),
      profile: fbProfile(),
      settings: baseSettings,
      nowMs: NOW,
      env: { IG_TOOL_PACKAGES: spelling },
    });

    // Whole line, label column included: the expansion is echoed after the
    // operator's own spelling, so the line answers both "what did I set?" and
    // "what did that turn into?" in the order they are asked.
    assert.equal(
      packagesLine(res.report),
      `  INFO  Active packages:    ${spelling} (every package)`,
      spelling,
    );
  }
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
  assert.ok(!res.report.includes('FAIL'), 'the token is not declared broken');
  assert.equal(res.exitCode, 0);
});

test('a debug_token payload without is_valid is not reported as a valid token either', async () => {
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

  // An OK line needs evidence; a missing field is none. The line says so and
  // points at the one check that does test the token.
  const lines = res.report.split('\n');
  assert.ok(!res.report.includes('Token is valid'), 'no OK verdict without is_valid=true');
  assert.ok(
    lines.includes(
      '  INFO  Token validity: not reported by debug_token (no is_valid field) — ' +
        'see the reachability check below.',
    ),
    res.report,
  );
  assert.equal(res.exitCode, 0);
});

test('introspection debugs this profile\u2019s own access token, not some other one', async () => {
  const { req, calls } = fakeReq(
    routing({
      debug: () => ({ data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] } }),
      account: () => ({ id: '178414', username: 'acme' }),
    }),
  );

  await runDoctor({ req, profile: fbProfile(), settings: baseSettings, nowMs: NOW });

  // `debug_token` takes the token to inspect as `input_token` and authenticates
  // the CALL with a second one. Passing anything but the profile's own token
  // makes every verdict in this section — valid, scopes, expiry — a report about
  // a credential the server will never use, and it would read exactly as green.
  const debug = calls.find((c) => c.path === '/debug_token');
  assert.ok(debug !== undefined, 'introspection was attempted');
  assert.equal(debug.params?.input_token, ACCESS_TOKEN, 'the profile token is the one inspected');
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

test('path A reports the expiry login/refresh recorded, naming where it came from', async () => {
  // The record is the only expiry Path A has. It used to be written and never
  // read, so doctor said "unknown" even for a token that had already lapsed.
  // The label names the env var so a stale hand-edited record is findable.
  const account = routing({ account: () => ({ id: '178414', username: 'acme' }) });
  const valid = await runDoctor({
    req: fakeReq(account).req,
    profile: igProfile({ tokenExpiresAtSec: (NOW + 40 * DAY) / 1000 }),
    settings: { ...baseSettings, refreshAfterDays: 7 },
    nowMs: NOW,
  });
  assert.equal(
    lineWith(valid.report, 'Token expiry'),
    `  OK    Token expiry (recorded in IG_TOKEN_EXPIRES_AT): valid — expires ${new Date(NOW + 40 * DAY).toISOString()} (~40 day(s) left).`,
  );
  assert.equal(valid.exitCode, 0);

  const expired = await runDoctor({
    req: fakeReq(account).req,
    profile: igProfile({ name: 'brand', tokenExpiresAtSec: (NOW - DAY) / 1000 }),
    settings: baseSettings,
    nowMs: NOW,
  });
  assert.ok(
    lineWith(expired.report, 'Token expiry').startsWith(
      '  WARN  Token expiry (recorded in IG_PROFILE_BRAND_TOKEN_EXPIRES_AT): expired — ',
    ),
  );
  // The record can be stale (a token replaced by hand, or one the MCP client
  // passes in); the reachability check, which passed here, is the authority.
  assert.ok(!expired.report.includes('FAIL'), 'a lapsed record alone is not a failure');
  assert.equal(expired.exitCode, 0);
});

test('path A reports a bare hand-set record as unverified (CC-AUTH-70)', async () => {
  // A record with no token fingerprint is read as written. The verdict keeps
  // its level — the reachability check is the authority on the token — but the
  // line says the expiry was never checked against this token.
  const account = routing({ account: () => ({ id: '178414', username: 'acme' }) });
  const res = await runDoctor({
    req: fakeReq(account).req,
    profile: igProfile({
      tokenExpiresAtSec: (NOW + 40 * DAY) / 1000,
      tokenExpiryUnverified: true,
    }),
    settings: { ...baseSettings, refreshAfterDays: 7 },
    nowMs: NOW,
  });
  assert.equal(
    lineWith(res.report, 'Token expiry'),
    `  OK    Token expiry (recorded in IG_TOKEN_EXPIRES_AT): valid — expires ${new Date(NOW + 40 * DAY).toISOString()} (~40 day(s) left). Token expiry is unverified: IG_TOKEN_EXPIRES_AT records this expiry without a token fingerprint (a record set by hand), so it is taken as written and not checked against the token: if the token was replaced since, it describes the old one. Run the \`refresh\` or \`login\` CLI to record an expiry bound to the token.`,
  );
  assert.equal(res.exitCode, 0);

  const never = await runDoctor({
    req: fakeReq(account).req,
    profile: igProfile({ tokenExpiresAtSec: 0, tokenExpiryUnverified: true }),
    settings: baseSettings,
    nowMs: NOW,
  });
  assert.ok(
    lineWith(never.report, 'Token expiry').startsWith(
      '  OK    Token expiry (recorded in IG_TOKEN_EXPIRES_AT): this token never expires. Token expiry is unverified: IG_TOKEN_EXPIRES_AT records this expiry without a token fingerprint',
    ),
    lineWith(never.report, 'Token expiry'),
  );
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

test('the App Dashboard pointer falls back to the configured app id when introspection omits it', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        // `app_id` is optional on the `debug_token` payload and this is the
        // shape where it is absent: a response that answered the validity
        // question and nothing else. Every other Path B test in this file
        // reports an `app_id`, and the two that assert on it either report one
        // that DISAGREES with configuration or use a Path A profile that has no
        // configured id at all — so `info.appId ?? appId` could lose its `??`
        // fallback and the whole suite stayed green.
        debug: () => ({
          data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] },
        }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile({ appId: '55500' }),
    settings: baseSettings,
    nowMs: NOW,
  });

  // Configuration is the weaker source, not a discardable one. Dropping the
  // fallback turns the one line that tells an operator WHICH dashboard to open
  // into a line that tells them to go find out, on the profile that has the
  // answer sitting in its own config.
  assert.ok(res.report.includes('(App ID 55500)'), 'the configured id is the fallback');
});

test('a blank app id on the wire does not erase the configured one', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        // `app_id` is an OPTIONAL string on the `debug_token` payload, and an
        // optional string can arrive empty. `src/api/account.ts` copies `d.app_id`
        // straight through, so nothing between Graph and this line has an opinion
        // about a blank one — the config parser's `clean()` only ever sees the
        // profile. Under the old `info.appId ?? appId` the blank won, because `??`
        // asks whether the left side is NULLISH and `''` is not.
        debug: () => ({
          data: { is_valid: true, app_id: '', expires_at: (NOW + 200 * DAY) / 1000, scopes: [] },
        }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile({ appId: '55500' }),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.ok(res.report.includes('(App ID 55500)'), 'a blank wire id is no id, not a new id');
  assert.ok(!res.report.includes('(App ID )'), 'the pointer never degrades to a blank id');
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

test('an account that reports no username is not given an empty handle', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({
          data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] },
        }),
        account: () => ({ id: '178414' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  // Meta OMITS fields it will not disclose rather than nulling them (CC-DATA-2),
  // so a username-less account is an ordinary answer, not a broken one. Dropping
  // the guard prints `(@undefined)` — which reads as a real handle and is the
  // kind of detail an operator copies into a support ticket.
  assert.ok(res.report.includes('resolved account id=178414'), 'the id is still reported');
  assert.ok(!res.report.includes('@undefined'), 'no phantom handle is invented');
  assert.ok(!res.report.includes('(@'), 'the handle clause is omitted entirely');
  assert.equal(res.exitCode, 0, 'a missing username is not a health failure');
});

test('a BLANK username prints no handle clause, exactly as a missing one does', async () => {
  // The companion to the test above, for the other way the handle can be
  // nothing. `api/account.ts` maps the wire response field for field and cleans
  // nothing, deliberately — `test/tools/account.test.ts` pins that a cleared
  // text field must stay an empty string rather than become `undefined`, so
  // "cleared" never reads as "undisclosed". That leaves the display layer to
  // decide, and a presence test alone decides wrong: it prints ` (@)`, a handle
  // clause naming no handle, which is the same phantom-clause defect the
  // punctuation row earlier in this file catches on the app-id side.
  const blank = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({
          data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] },
        }),
        account: () => ({ id: '178414', username: '' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });
  assert.equal(
    lineWith(blank.report, 'Reachability OK'),
    '  OK    Reachability OK — GET /178414 resolved account id=178414.',
  );
  assert.ok(!blank.report.includes('(@'), 'no empty handle clause is printed');
  assert.equal(blank.exitCode, 0, 'a blank username is not a health failure');
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
  level: 'debug' | 'info';
  msg: string;
  fields?: Record<string, unknown>;
}

/** A logger that records the `debug`/`info` records the command emits. */
function capturingLog(records: LogRecord[]): Logger {
  const log: Logger = {
    debug(msg, fields) {
      records.push({ level: 'debug', msg, fields });
    },
    info(msg, fields) {
      records.push({ level: 'info', msg, fields });
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

test('the run is announced to the log before the first Graph call is made', async () => {
  const records: LogRecord[] = [];
  const seen: string[] = [];
  const { req } = fakeReq((opts) => {
    seen.push(`${records.length}:${opts.path}`);
    if (opts.path === '/debug_token') {
      return { data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] } };
    }
    return { id: '178414', username: 'acme' };
  });

  await runDoctor({
    req,
    profile: fbProfile({ name: 'marketing' }),
    settings: baseSettings,
    log: capturingLog(records),
    nowMs: NOW,
    env: {},
  });

  // When a check wedges — a Graph call that never returns, a process killed
  // mid-run — this is the only record that ever gets written, and it is what
  // tells an operator reading the log which profile and which auth path the
  // hung run was testing. Emitted after the first call, it would not be there.
  const started = records.find((r) => r.msg === 'doctor: starting health check');
  assert.ok(started !== undefined, 'the start of the run is logged');
  assert.equal(started.level, 'debug', 'as debug — the report is the operator-facing output');
  assert.equal(started.fields?.profile, 'marketing', 'the profile under test is named');
  assert.equal(started.fields?.authPath, 'fb-login', 'and so is its auth path');
  assert.deepEqual(seen, ['1:/debug_token', '1:/178414'], 'the record precedes both calls');
});

test('a telemetry sink that throws costs the record, never the report', async () => {
  const dead = (failing: 'debug' | 'info'): Logger => {
    const log: Logger = {
      debug() {
        if (failing === 'debug') throw new Error('ENOSPC: no space left on device');
      },
      info() {
        if (failing === 'info') throw new Error('ENOSPC: no space left on device');
      },
      warn() {},
      error() {},
      child() {
        return log;
      },
    };
    return log;
  };

  // `core/log.ts` deliberately RETHROWS for a sink it cannot use at all
  // (CC-PROC-24) — a full disk, or a non-stream an embedder handed in. Both
  // records here sit outside every check's guard, so an unguarded throw from
  // either one loses the whole report and the exit code with it: `src/index.ts`
  // never reaches its `process.stdout.write`, and the operator gets "failed to
  // start" while learning nothing about the token they ran `doctor` to check.
  for (const failing of ['debug', 'info'] as const) {
    const res = await runDoctor({
      req: healthyReq(),
      profile: fbProfile(),
      settings: baseSettings,
      log: dead(failing),
      nowMs: NOW,
      env: {},
    });

    assert.equal(res.exitCode, 0, `a dead ${failing} sink does not change the verdict`);
    assert.ok(res.report.includes('Health check passed'), `the report survives a dead ${failing}`);
    assert.ok(res.report.includes('Reachability OK'), 'and still carries every check');
  }
});

// --- report layout: labels, columns and colors ------------------------------

/**
 * A report that exercises all four severities at once: an OK introspection
 * line, a WARN near-expiry line, a FAIL reachability line, and the INFO
 * configuration block.
 */
async function mixedReport(): Promise<string> {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({
          data: { is_valid: true, scopes: [], expires_at: (NOW + 10 * DAY) / 1000 },
        }),
        account: () =>
          raise(new InstagramError('session has expired', { kind: 'auth', status: 401 })),
      }),
    ).req,
    profile: fbProfile(),
    settings: testSettings({ writeJournal: join(journalRoot, 'mixed', 'writes.jsonl') }),
    nowMs: NOW,
    env: {},
  });
  return res.report;
}

/** The status lines of the `Configuration` block, in the order they are printed. */
function configBlock(report: string): string[] {
  const lines = report.split('\n');
  const start = lines.indexOf('Configuration');
  assert.notEqual(start, -1, 'the report has a Configuration section');
  const end = lines.indexOf('', start + 1);
  assert.notEqual(end, -1, 'the configuration block is terminated by a blank line');
  return lines.slice(start + 1, end);
}

test('every status label is padded to the same width, so the lines read as columns', async () => {
  const report = await mixedReport();

  // The label column is the only thing that makes a 30-line report scannable:
  // an operator's eye runs down four fixed characters looking for FAIL. A label
  // that is not padded to the common width (`OK` instead of `OK  `) shifts the
  // whole line left, so the text no longer aligns with its neighbours and the
  // severity column stops being a column at all.
  const statusLines = report.split('\n').filter((l) => l.startsWith('  '));
  assert.deepEqual(
    [...new Set(statusLines.map((l) => l.slice(2, 6)))].sort(),
    ['FAIL', 'INFO', 'OK  ', 'WARN'],
    'all four severities appear in this report',
  );
  for (const line of statusLines) {
    assert.match(
      line,
      /^ {2}(?:OK {2}|WARN|FAIL|INFO) {2}\S/,
      `a four-wide label between fixed gutters: ${JSON.stringify(line)}`,
    );
  }
});

test('every configuration label pads its value to one shared column', async () => {
  const report = await mixedReport();

  // The configuration block is read as a two-column table. One label that stops
  // padding (`Profile: default` next to `Auth path:          fb-login`) breaks
  // the value column for the lines around it, and this block is what operators
  // paste into bug reports — a ragged one is read as a formatting bug in the
  // tool that is supposed to be diagnosing their setup.
  const columns = configBlock(report).map((line) => {
    const rest = line.replace(/^ {2}(?:OK {2}|WARN|FAIL|INFO) {2}/, '');
    assert.notEqual(rest, line, `a configuration line carries a status label: ${line}`);
    const [, label, padding] = /^([^:]+:)( +)\S/.exec(rest) ?? [];
    assert.ok(
      label !== undefined && padding !== undefined,
      `label, padding, then a value: ${JSON.stringify(rest)}`,
    );
    return label.length + padding.length;
  });
  assert.equal(new Set(columns).size, 1, `one shared value column, got ${columns.join('/')}`);
});

test('the configuration block is printed in its documented order', async () => {
  const report = await mixedReport();

  // The order is the order docs/operations.md §6 documents and the order an
  // operator reads top-down: who am I, how do I authenticate, how do I talk,
  // what am I allowed to do, what is recorded, what is exposed. Reordering is
  // invisible to a per-line assertion and silently invalidates every
  // screenshot, doc excerpt and support answer that quotes the block.
  const labels = configBlock(report).map((line) => {
    const [, label] = /^ {2}(?:OK {2}|WARN|FAIL|INFO) {2}([^:]+:)/.exec(line) ?? [];
    assert.ok(label !== undefined, `a labelled configuration line: ${line}`);
    return label;
  });
  assert.deepEqual(labels, [
    'Profile:',
    'Auth path:',
    'Transport:',
    'Write mode:',
    'Allow destructive:',
    'Write journal:',
    'Active packages:',
    'Refresh after:',
  ]);
});

test('each severity has its own color and every colored line closes its escape', async () => {
  await withTty(async () => {
    const report = await mixedReport();
    const esc = String.fromCharCode(27);

    // The colors are the second half of the scanning affordance, and they only
    // work while they mean one thing each: green=passed, yellow=needs attention
    // soon, red=broken, grey=context. A severity painted in another severity's
    // color inverts the reading of the line it is on — a green FAIL is read as
    // a passing check by everyone who scans the color before the label.
    const colored = (needle: string): string => {
      const line = report.split('\n').find((l) => l.includes(needle));
      assert.ok(line !== undefined, `the report has a line containing ${needle}`);
      return line;
    };
    assert.ok(colored('Token is valid').startsWith(`${esc}[32m`), 'OK is green');
    assert.ok(colored('expiring_soon').startsWith(`${esc}[33m`), 'WARN is yellow');
    assert.ok(colored('Reachability FAILED').startsWith(`${esc}[31m`), 'FAIL is red');
    assert.ok(colored('Profile:').startsWith(`${esc}[90m`), 'INFO is grey');

    // Without the reset the color leaks past the line into whatever the
    // terminal prints next — the shell prompt included, which stays red until
    // the operator types `reset`.
    for (const line of report.split('\n').filter((l) => l.includes(esc))) {
      assert.ok(line.endsWith(`${esc}[0m`), `the escape is closed: ${JSON.stringify(line)}`);
    }
  });
});

test('the report opens with its title, then the profile line naming the Graph host', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile({ name: 'marketing' }),
    settings: baseSettings,
    nowMs: NOW,
    env: {},
  });

  // These two lines are the provenance of every pasted report: without the
  // title nobody can tell which tool produced it, and without the host on the
  // profile line the reader cannot tell whether the run even targeted the Graph
  // host their problem is about. The title must come first — a report whose
  // first line is account-specific reads as a fragment of some other output.
  const [title, profileLine] = res.report.split('\n');
  assert.equal(title, 'Instagram MCP — doctor');
  assert.equal(
    profileLine,
    'Active profile: marketing (fb-login — Facebook Login for Business — graph.facebook.com)',
  );
});

test('the app-mode line states the consequence, not just the question', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: {},
  });

  const line = res.report.split('\n').find((l) => l.includes('Meta App Dashboard'));
  assert.ok(line !== undefined, 'the app-mode line is present');
  // "Verify Development vs Live" is an errand; the sentence after it is the
  // reason anyone would run the errand. Dropping it leaves a line that costs an
  // operator a dashboard visit and teaches them nothing about why the throttled
  // limits and the tester-only reach they are hitting are expected.
  assert.ok(
    line.endsWith(
      'Development-mode apps may face lower rate limits and can only act on app roles/testers.',
    ),
    `the consequence is spelled out: ${line}`,
  );
});

// --- severities that carry the verdict --------------------------------------

test('a reported scope set is an OK line, not grey context', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({
          data: {
            is_valid: true,
            expires_at: (NOW + 200 * DAY) / 1000,
            scopes: ['instagram_basic', 'pages_show_list'],
          },
        }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: {},
  });

  // Introspection answering with a real scope set is a check that passed, and
  // the companion line for an empty set is deliberately INFO. Painting both the
  // same grey erases the only difference between "the token carries permissions"
  // and "the token carries none" for anyone scanning severities.
  const line = res.report.split('\n').find((l) => l.includes('Granted scopes:'));
  assert.ok(line !== undefined, 'the scopes line is present');
  assert.ok(line.startsWith('  OK  '), `a granted scope set is an OK line: ${line}`);
});

test('an expired token is labelled FAIL, never WARN', async () => {
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
    env: {},
  });

  // The neighbouring `expiring_soon` verdict IS a WARN, and the two lines
  // differ by one word an operator skims past. The label is what separates
  // "renew this week" from "every call is already failing"; a WARN on an
  // expired token is read as the former and the outage keeps running.
  const line = res.report.split('\n').find((l) => l.includes('Token expiry: expired'));
  assert.ok(line !== undefined, 'the expiry verdict is present');
  assert.ok(line.startsWith('  FAIL  '), `an expired token is a failure line: ${line}`);
});

test('an injected clock of zero is honoured, not mistaken for "no clock"', async () => {
  const expiresAtMs = 400 * DAY;
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({ data: { is_valid: true, expires_at: expiresAtMs / 1000, scopes: [] } }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: 0,
    env: {},
  });

  // `nowMs` is a seam, and 0 is a perfectly ordinary value for it — the epoch
  // is what a fixed-clock harness reaches for first. A falsy-test fallback
  // silently swaps the injected clock for the wall clock, which turns every
  // expiry assertion in a caller's suite into a time bomb: the report would
  // read "expired" here purely because the machine's real date is 2026.
  assert.equal(res.exitCode, 0, 'the epoch clock is used, so the token is not yet expired');
  const line = res.report.split('\n').find((l) => l.includes('Token expiry:'));
  assert.ok(line !== undefined, 'the expiry line is present');
  assert.ok(line.includes(new Date(expiresAtMs).toISOString()), 'the absolute expiry is stated');
  assert.ok(line.includes('~400 day(s) left'), 'counted from the injected clock, not from today');
});

// --- rendering details that carry meaning -----------------------------------

test('the Graph codes of a failed check are rendered as a comma-separated list', async () => {
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
    env: {},
  });

  const line = res.report.split('\n').find((l) => l.includes('Token introspection failed'));
  assert.ok(line !== undefined, 'the failure line is present');
  // The bracket is a list of four independent facts appended to an upstream
  // message that itself contains spaces and numbers. Space-separated they run
  // into the message and into each other, and `code=190 subcode=460` stops
  // being greppable as the pair docs/operations.md §3 is indexed by.
  assert.ok(
    line.endsWith('Error validating access token [kind=auth, code=190, subcode=460, status=400]'),
    `the codes are a readable list: ${line}`,
  );
});

test('an expanded package profile is a comma-separated list, not a run-on string', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: {},
  });

  // This expansion is what an operator copies into `IG_TOOL_PACKAGES` to pin
  // the surface they just verified, and the variable is parsed as a comma list.
  // Rendered space-separated it is not a value they can paste back, and a
  // package name is no longer visually separable from its neighbours.
  const value = configValue(res.report, 'Active packages:');
  const [, packages] = /^core \(default: ([^)]+)\)$/.exec(value) ?? [];
  assert.ok(packages !== undefined, `the default profile is expanded: ${value}`);
  assert.match(packages, /^[a-z][a-z-]*(?:, [a-z][a-z-]*)+$/, 'packages are comma-separated');
});

test('a whitespace-only deny list is not rendered as a refinement', async () => {
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_PACKAGES_DENY: '   ', IG_PACKAGES_READONLY: '' },
  });

  // `IG_PACKAGES_DENY=" "` is what a hand-edited env file or a shell expansion
  // of an unset variable leaves behind, and the registry trims before deciding
  // whether a refinement exists. Reporting `(deny:    )` here would claim a
  // filter the running server is not applying — the exact disagreement between
  // report and reality that makes a diagnostic worse than none.
  assert.ok(!packagesLine(res.report).includes('(deny:'), `no deny clause: ${res.report}`);
});

test('the deny refinement is reported before the read-only one', async () => {
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

  // The two clauses answer different questions — what is gone versus what is
  // present but neutered — and they are read as an increasingly narrow filter:
  // deny removes, read-only then restricts what is left. Swapping them reads as
  // "comments is read-only, and by the way insights is denied", which invites
  // the conclusion that the read-only list still applies to the denied package.
  const line = packagesLine(res.report);
  assert.ok(
    line.indexOf('(deny: insights)') < line.indexOf('(read-only: comments)'),
    `deny precedes read-only: ${line}`,
  );
});

test('journal sizes are scaled in binary units, not decimal ones', async () => {
  const dir = mkdtempSync(join(journalRoot, 'units-'));
  const small = join(dir, 'small.jsonl');
  writeFileSync(small, 'x'.repeat(1000));
  const large = join(dir, 'large.jsonl');
  writeFileSync(large, 'x'.repeat(1_030_000));

  const sizeOf = async (writeJournal: string): Promise<string> => {
    const res = await runDoctor({
      req: healthyReq(),
      profile: fbProfile(),
      settings: testSettings({ writeMode: 'apply', writeJournal }),
      nowMs: NOW,
      env: {},
    });
    return journalLine(res.report);
  };

  // The unit says KiB/MiB, so the divisor has to be 1024. A decimal divisor
  // under a binary label misstates the size by 2.4% per step, which is exactly
  // the kind of quiet wrongness that gets noticed when someone compares this
  // line with `ls -l` while deciding whether a journal needs rotating.
  assert.ok((await sizeOf(small)).includes('file exists, 1000 B)'), 'under 1 KiB stays in bytes');
  assert.ok(
    (await sizeOf(large)).includes('file exists, 1005.9 KiB)'),
    'just under 1 MiB is still KiB, divided by 1024',
  );
});

test('the journal line states the write mode before what was found on disk', async () => {
  const dir = mkdtempSync(join(journalRoot, 'order-'));
  const writeJournal = join(dir, 'writes.jsonl');
  writeFileSync(writeJournal, 'x'.repeat(27));

  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: testSettings({ writeJournal }),
    nowMs: NOW,
    env: {},
  });

  // The mode clause qualifies everything after it: "preview mode — nothing is
  // recorded" is what stops `file exists, 27 B` from being read as a live audit
  // trail. Stated after the file facts it arrives too late — the reader has
  // already concluded the journal is working.
  const line = journalLine(res.report);
  assert.ok(
    line.indexOf('preview mode') < line.indexOf('file exists, 27 B'),
    `the mode is stated first: ${line}`,
  );
});

// --- scope drift ------------------------------------------------------------

/**
 * The full Path B default grant, spelled out rather than imported. These tests
 * pin what an operator sees, so the fixture has to be an independent statement
 * of the expectation — importing `DEFAULT_SCOPES` here would make the "matches
 * exactly" case pass for any table at all.
 */
const FB_FULL_GRANT = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
];

/** Run doctor against a healthy token carrying exactly `scopes`. */
async function scopeReport(
  scopes: string[],
  profile: ResolvedProfile = fbProfile(),
): Promise<{ report: string; exitCode: number }> {
  const { req } = fakeReq(
    routing({
      debug: () => ({ data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes } }),
      account: () => ({ id: '178414', username: 'acme' }),
    }),
  );
  return runDoctor({ req, profile, settings: baseSettings, nowMs: NOW });
}

/** The four-character severity label of the first line containing `needle`. */
function statusOf(report: string, needle: string): string {
  const line = report.split('\n').find((l) => l.includes(needle));
  assert.ok(line !== undefined, `the report has a line containing "${needle}"`);
  return line.slice(2, 6);
}

test('a grant that matches the path exactly is reported as matching', async () => {
  // Listing the grant is not the same as reviewing it: an operator cannot review
  // it without the expected set in front of them, and nobody keeps seven scope
  // names in their head. The positive line is what makes the silence in the
  // other two cases meaningful.
  const res = await scopeReport(FB_FULL_GRANT);

  assert.ok(
    res.report.includes('Scope grant matches exactly what this server needs.'),
    'an exact grant is confirmed, not left to the operator to verify by eye',
  );
  assert.equal(statusOf(res.report, 'Scope grant matches'), 'OK  ');
  assert.equal(res.exitCode, 0);
});

test('a scope this server never uses is reported, named, and only it', async () => {
  // The finding: a token minted with `pages_manage_posts` can write to the Page
  // feed for as long as it lives, and nothing here would ever have needed it.
  // This is the promise `docs/setup-guide.md` §5 and `docs/security.md` make.
  const res = await scopeReport([...FB_FULL_GRANT, 'pages_manage_posts', 'ads_management']);

  assert.equal(
    configValue(res.report, 'Over-granted scopes:'),
    'ads_management, pages_manage_posts — this server never uses them; re-run ' +
      '`login` to mint a token without them.',
  );
  assert.equal(
    statusOf(res.report, 'Over-granted scopes:'),
    'WARN',
    'a deliberately trimmed or widened grant is a judgement call, not a broken install',
  );
  assert.equal(res.exitCode, 0, 'over-granting must not fail the command');
  assert.ok(
    !res.report.includes('Missing scopes:'),
    'a superset must not also be reported as incomplete',
  );
  assert.ok(!res.report.includes('Scope grant matches exactly'), 'and not as clean either');
});

test('a scope the path needs but the token lacks is reported, named, and only it', async () => {
  // The failure this catches is the expensive one: doctor green, then an opaque
  // Graph permission error at the first `insights` call weeks later.
  const res = await scopeReport(
    FB_FULL_GRANT.filter((s) => s !== 'instagram_manage_insights' && s !== 'business_management'),
  );

  assert.equal(
    configValue(res.report, 'Missing scopes:'),
    'business_management, instagram_manage_insights — tools needing them will fail with a ' +
      'permission error; re-run `login` (or pass `--scopes`) to add them.',
  );
  assert.equal(
    statusOf(res.report, 'Missing scopes:'),
    'WARN',
    'a trimmed grant is a legitimate read-only deployment; failing here is how a check gets routed around',
  );
  assert.equal(res.exitCode, 0);
  assert.ok(
    !res.report.includes('Over-granted scopes:'),
    'a subset must not also be reported as over-granted',
  );
  assert.ok(!res.report.includes('Scope grant matches exactly'), 'and not as clean either');
});

test('a grant that is wrong in both directions reports both', async () => {
  const res = await scopeReport([
    ...FB_FULL_GRANT.filter((s) => s !== 'pages_show_list'),
    'pages_manage_metadata',
  ]);

  assert.ok(res.report.includes('Missing scopes: pages_show_list —'), 'the gap is named');
  assert.ok(
    res.report.includes('Over-granted scopes: pages_manage_metadata —'),
    'the excess is named',
  );
});

test('scopes Facebook attaches to every token are not reported as over-granted', async () => {
  // Noise on every single Path B run is how a real finding gets ignored.
  const res = await scopeReport([...FB_FULL_GRANT, 'public_profile']);

  assert.ok(res.report.includes('Scope grant matches exactly what this server needs.'));
  assert.ok(!res.report.includes('Over-granted'), 'public_profile is not a finding');
});

test('Path A reports no scope verdict, because it has no grant to read', async () => {
  // `debug_token` is a Facebook-app endpoint; `graph.instagram.com` has no
  // equivalent, so on Path A doctor never learns what was granted. Saying
  // nothing is right — but a "matches exactly" line printed by default, or a
  // Path B table applied to Path A's disjoint scope vocabulary, would both be
  // confident and wrong. This pins the silence.
  const res = await scopeReport(FB_FULL_GRANT, igProfile());

  for (const label of [
    'Granted scopes:',
    'Missing scopes:',
    'Over-granted scopes:',
    'Scope grant',
  ]) {
    assert.ok(!res.report.includes(label), `Path A must not print a "${label}" line`);
  }
  assert.equal(res.exitCode, 0, 'and the absence of a scope verdict is not a failure');
});

test('both auth paths name their Meta product whole, on both lines that carry it', async () => {
  // `pathLabel` is a two-arm ternary whose arms had different protection — in
  // this file. The fb arm is pinned whole exactly once, by `the report opens
  // with its title, then the profile line naming the Graph host`. The ig arm
  // was pinned nowhere: `the header names the profile and the Graph host its
  // calls will hit` asserts only that the ig report contains
  // `graph.instagram.com` and not `graph.facebook.com`, which leaves the
  // product name between the path and the host as free text. Rewriting it to
  // `Instagram Basic Display` — the API Meta retired in December 2024 — keeps
  // both host assertions true and passes every other test in this file. An
  // operator reading that line concludes a correct deployment runs on a dead
  // API and goes to rebuild its auth, which is the very failure the
  // neighbouring comment says this line exists to prevent: naming the path
  // wrongly "sends them editing the wrong config entry".
  //
  // The label is printed twice — the header and the `Auth path:` row — so both
  // are pinned here, for both paths (CC-CFG-25).
  const reports: Record<string, string> = {
    'fb-login': (
      await runDoctor({
        req: healthyReq(),
        profile: fbProfile({ name: 'marketing' }),
        settings: baseSettings,
        nowMs: NOW,
        env: {},
      })
    ).report,
    'ig-login': (
      await runDoctor({
        req: fakeReq(routing({ account: () => ({ id: '178414', username: 'acme' }) })).req,
        profile: igProfile({ name: 'creator' }),
        settings: baseSettings,
        nowMs: NOW,
        env: {},
      })
    ).report,
  };
  const expected = {
    'fb-login': { profile: 'marketing', label: 'Facebook Login for Business — graph.facebook.com' },
    'ig-login': { profile: 'creator', label: 'Instagram Login — graph.instagram.com' },
  } as const;

  for (const [path, { profile, label }] of Object.entries(expected)) {
    const report = reports[path] ?? '';
    assert.equal(
      report.split('\n')[1],
      `Active profile: ${profile} (${path} — ${label})`,
      `the ${path} header line, product name included`,
    );
    assert.equal(
      lineWith(report, 'Auth path:').replace(/^ {2}(?:OK {2}|WARN|FAIL|INFO) {2}Auth path: +/, ''),
      `${path} (${label})`,
      `the ${path} configuration row repeats the same label`,
    );
  }
  assert.notEqual(
    expected['fb-login'].label,
    expected['ig-login'].label,
    'the two paths are told apart by more than the host they share a line with',
  );
});

test('the forced-read-only clause is pinned with the separator that attaches it', async () => {
  // Two tests in this file assert `packagesLine(...).includes('forced
  // read-only')`, and both survive dropping the `; ` that joins the clause to
  // the package list: `reader (account, media, insights, comments, discovery
  // forced read-only)` reads as a fifth entry named "discovery forced
  // read-only" rather than as a guarantee governing all five. This line is the
  // answer to "which tools does this deployment expose, and may they write" —
  // the question `doctor` is run to settle before a token is granted. Pinned
  // whole: the expansion, its order, and the clause (CC-CFG-25).
  const res = await runDoctor({
    req: healthyReq(),
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
    env: { IG_TOOL_PACKAGES: 'reader' },
  });

  assert.equal(
    packagesLine(res.report).replace(/^ {2}(?:OK {2}|WARN|FAIL|INFO) {2}Active packages: +/, ''),
    'reader (account, media, insights, comments, discovery; forced read-only)',
    'the expansion, its order, and the clause that governs all of it',
  );
});

// --- an answer that cannot be used is not a passing check -------------------

/** A healthy Path B introspection, so the reachability line alone decides. */
function validDebug(): unknown {
  return { data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes: [] } };
}

test('a reachability answer with no usable account id fails the check (CC-DATA-88)', async () => {
  // `getAccount` casts the body, so `{}` arrives typed as a profile whose `id`
  // is a string. It printed `OK  Reachability OK — GET /178414 resolved account
  // id=undefined.` and a passing summary with exit 0: doctor certified a setup
  // on an answer that identifies no account. Every non-string or blank id is
  // the same non-answer, with an account id configured and through `/me` alike.
  const bodies: [unknown, string][] = [
    [{}, 'no id field'],
    [{ username: 'acme' }, 'no id field'],
    [{ id: null }, 'id null (type object)'],
    [{ id: 178414 }, 'id 178414'],
    [{ id: '' }, 'id "" (type string)'],
  ];
  for (const profile of [fbProfile(), fbProfile({ accountId: undefined })]) {
    const igId = profile.accountId ?? 'me';
    for (const [body, detail] of bodies) {
      const res = await runDoctor({
        req: fakeReq(routing({ debug: validDebug, account: () => body })).req,
        profile,
        settings: baseSettings,
        nowMs: NOW,
      });
      const shown = JSON.stringify(body);
      assert.equal(
        lineWith(res.report, 'Reachability FAILED'),
        `  FAIL  Reachability FAILED — GET /${igId}: the answer carries no usable account id (${detail}), so it does not prove this profile can address its account; retry, and if it persists check the account id and the token [kind=upstream]`,
        `${shown} via /${igId}`,
      );
      assert.ok(!res.report.includes('Reachability OK'), `${shown}: no OK line`);
      assert.ok(!res.report.includes('undefined'), `${shown}: nothing prints undefined`);
      assert.ok(res.report.includes('Health check FAILED'), `${shown}: the summary fails`);
      assert.equal(res.exitCode, 1, `${shown}: the exit code reports the failure`);
    }
  }
});

test('an upstream username cannot inject terminal escapes or forge a report line (CC-DATA-89)', async () => {
  // A handle is account-controlled text and the report goes to a terminal. An
  // ESC repainted it and a newline forged a whole line — here a green-looking
  // `OK  Health check passed` under a report that has not decided yet.
  const esc = String.fromCharCode(27);
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: validDebug,
        account: () => ({
          id: '178414',
          username: `acme${esc}[2J\n  OK    Health check passed‮`,
        }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.ok(!res.report.includes(esc), 'no raw ESC reaches the terminal');
  assert.ok(!res.report.includes('‮'), 'no bidi override reaches the terminal');
  assert.equal(
    lineWith(res.report, 'Reachability OK'),
    '  OK    Reachability OK — GET /178414 resolved account id=178414 (@acme\\u{1b}[2J\\u{a}  OK    Health check passed\\u{202e}).',
    'every unprintable is shown as a visible escape, on the one line it belongs to',
  );
  assert.equal(
    res.report.split('\n').filter((line) => line.includes('Health check passed')).length,
    2,
    'the only other "Health check passed" is the real summary line',
  );
});

test('an upstream error message is escaped and length-capped, and keeps its Graph codes (CC-DATA-89)', async () => {
  const esc = String.fromCharCode(27);
  const message = `${esc}]0;owned${String.fromCharCode(7)}` + 'y'.repeat(5000);
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: validDebug,
        account: () => {
          throw new InstagramError(message, { kind: 'upstream', code: 1, status: 500 });
        },
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  const line = lineWith(res.report, 'Reachability FAILED');
  assert.ok(!line.includes(esc), 'no raw ESC');
  assert.ok(!line.includes(String.fromCharCode(7)), 'no raw BEL');
  assert.equal(
    line,
    `  FAIL  Reachability FAILED — GET /178414: \\u{1b}]0;owned\\u{7}${'y'.repeat(290)}… (5010 characters in all) [kind=upstream, code=1, status=500]`,
    'cut at 300 code points, the full length stated, the bracket intact after the cut',
  );
  assert.equal(res.exitCode, 1);
});

test('a message is redacted BEFORE it is cut, so no secret prefix survives the cap (CC-DATA-89)', async () => {
  // The app secret matches no token shape, so only the exact-value registry
  // masks it — and a registry match needs the WHOLE value. Cutting first would
  // leave `app-secret-v…` at the end of the line, a prefix nothing recognises.
  const secret = 'app-secret-value-0123456789';
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: validDebug,
        account: () => {
          throw new InstagramError(`${'z'.repeat(288)}${secret}`, { kind: 'upstream' });
        },
      }),
    ).req,
    profile: fbProfile({ appSecret: secret }),
    settings: baseSettings,
    nowMs: NOW,
  });

  const line = lineWith(res.report, 'Reachability FAILED');
  assert.ok(!line.includes('app-secret'), 'not even a prefix of the secret is printed');
  assert.ok(line.includes(`${'z'.repeat(288)}[REDACTED]`), 'the marker stands where it was');
});

test('introspection text from the wire is escaped too: app id and scope names (CC-DATA-89)', async () => {
  const esc = String.fromCharCode(27);
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({
          data: {
            is_valid: true,
            app_id: `555${esc}[31m`,
            expires_at: (NOW + 200 * DAY) / 1000,
            scopes: ['instagram_basic', `evil${esc}[8m`],
          },
        }),
        account: () => ({ id: '178414' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.ok(!res.report.includes(esc), 'no raw ESC anywhere in the report');
  assert.ok(res.report.includes('(App ID 555\\u{1b}[31m)'), 'the app id is escaped');
  assert.ok(
    lineWith(res.report, 'Granted scopes').endsWith('instagram_basic, evil\\u{1b}[8m'),
    'a granted scope is escaped',
  );
  assert.ok(
    lineWith(res.report, 'Over-granted scopes').includes(': evil\\u{1b}[8m — '),
    'an over-granted scope is escaped',
  );
});

test('an overlong identifier from the wire is cut at the identifier cap (CC-DATA-89)', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({ debug: validDebug, account: () => ({ id: '178414', username: 'u'.repeat(70) }) }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.equal(
    lineWith(res.report, 'Reachability OK'),
    `  OK    Reachability OK — GET /178414 resolved account id=178414 (@${'u'.repeat(64)}… (70 characters in all)).`,
  );

  // At exactly the cap nothing is cut, and nothing claims it was.
  const atCap = await runDoctor({
    req: fakeReq(
      routing({ debug: validDebug, account: () => ({ id: '178414', username: 'u'.repeat(64) }) }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });
  assert.equal(
    lineWith(atCap.report, 'Reachability OK'),
    `  OK    Reachability OK — GET /178414 resolved account id=178414 (@${'u'.repeat(64)}).`,
  );
});

test('a scope list that is not a list of names warns instead of failing the run (CC-DATA-90)', async () => {
  // A string `scopes` reached `.join` and threw; the engine's TypeError text
  // became `FAIL  Token introspection failed: info.scopes.join is not a
  // function` and the run exited 1 on a valid, reachable token. A list with a
  // `null` in it rendered the null as an empty over-granted scope name.
  const cases: [unknown, string][] = [
    ['instagram_basic', '"instagram_basic" (type string)'],
    [['instagram_basic', null], '["instagram_basic",null] (type object)'],
    [{ a: 1 }, '{"a":1} (type object)'],
  ];
  for (const [scopes, shown] of cases) {
    const res = await runDoctor({
      req: fakeReq(
        routing({
          debug: () => ({
            data: { is_valid: true, expires_at: (NOW + 200 * DAY) / 1000, scopes },
          }),
          account: () => ({ id: '178414' }),
        }),
      ).req,
      profile: fbProfile(),
      settings: baseSettings,
      nowMs: NOW,
    });
    assert.equal(
      lineWith(res.report, 'Granted scopes'),
      `  WARN  Granted scopes: unreadable — debug_token sent ${shown}, not a list of scope names; the scope grant cannot be checked.`,
      shown,
    );
    assert.ok(!res.report.includes('Token introspection failed'), `${shown}: not a failure`);
    for (const verdict of ['Missing scopes', 'Over-granted scopes', 'Scope grant matches']) {
      assert.ok(!res.report.includes(verdict), `${shown}: no drift verdict on an unread grant`);
    }
    assert.ok(res.report.includes('Token expiry: valid'), `${shown}: expiry is still reported`);
    assert.equal(res.exitCode, 0, `${shown}: a valid, reachable token passes`);
  }
});

test('an unrepresentable expires_at is quoted with its invisible characters escaped (CC-DATA-89)', async () => {
  // `describeWireValue` renders a string `expires_at` through `JSON.stringify`,
  // which escapes C0 controls but leaves a right-to-left override in place — it
  // reversed the rest of the line on the operator's terminal.
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => ({ data: { is_valid: true, scopes: [], expires_at: 'soon\u202e' } }),
        account: () => ({ id: '178414' }),
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.ok(!res.report.includes('\u202e'), 'no raw bidi override');
  assert.equal(
    lineWith(res.report, 'Token expiry'),
    '  INFO  Token expiry: unknown — Token expiry is unknown: upstream reported an `expires_at` of "soon\\u{202e}" (type string), which is not a representable timestamp.',
  );
});

test('a failed introspection and a plain Error are quoted too, line separators included (CC-DATA-89)', async () => {
  // Both failure lines take the message through the same quote: introspection
  // as an InstagramError, reachability as a bare Error the seam did not wrap.
  // U+2028/U+2029 are line breaks to many terminals and editors, so they are
  // escaped with the controls rather than passed through as "printable".
  const esc = String.fromCharCode(27);
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: () => {
          throw new InstagramError('bad\u2028  OK    forged\u2029tail', { kind: 'upstream' });
        },
        account: () => {
          throw new Error(`plain${esc}[31m`);
        },
      }),
    ).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.equal(
    lineWith(res.report, 'Token introspection failed'),
    '  FAIL  Token introspection failed: bad\\u{2028}  OK    forged\\u{2029}tail [kind=upstream]',
  );
  assert.equal(
    lineWith(res.report, 'Reachability FAILED'),
    '  FAIL  Reachability FAILED — GET /178414: plain\\u{1b}[31m',
  );
  assert.ok(!/[\u2028\u2029]/.test(res.report), 'no raw separator reaches the terminal');
  assert.ok(!res.report.includes(esc), 'no raw ESC reaches the terminal');
  assert.equal(res.exitCode, 1);
});

// --- account identity (CC-AUTH-6) -------------------------------------------

const HEALTHY_DEBUG = (): unknown => ({
  data: { is_valid: true, scopes: [], expires_at: (NOW + 200 * DAY) / 1000 },
});

const MISMATCH_178414_999 =
  '  WARN  Account identity MISMATCH — IG_ACCOUNT_ID is 178414, but GET /178414 answered for ' +
  'account 999; every tool addresses 178414. If that is not the account you mean to operate, ' +
  'set IG_ACCOUNT_ID to the id of the account the token belongs to.';

test('path A: an answer for another account than the configured id warns, naming both ids (CC-AUTH-6)', async () => {
  // The reachability GET answered, so its line reads OK — and until this check
  // every other line did too, and the run passed, while every tool addressed
  // an account the answer was not for.
  const { req, calls } = fakeReq(routing({ account: () => ({ id: '999', username: 'other' }) }));

  const res = await runDoctor({ req, profile: igProfile(), settings: baseSettings, nowMs: NOW });

  // A WARN, not a FAIL: Path A knows an account by two ids, so a mismatch is
  // evidence for the operator to weigh, not proof the profile is broken.
  assert.equal(res.exitCode, 0, 'an unproven mismatch does not fail the run');
  assert.equal(lineWith(res.report, 'Account identity'), MISMATCH_178414_999);
  assert.ok(res.report.includes('Health check passed'), 'the summary stays green');
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/178414'],
    'the check reads the reachability answer; it issues no GET of its own',
  );
});

test('path B: an answer for a different node than the configured id warns (CC-AUTH-63)', async () => {
  const { req, calls } = fakeReq(
    routing({ debug: HEALTHY_DEBUG, account: () => ({ id: '999', username: 'acme' }) }),
  );
  const res = await runDoctor({ req, profile: fbProfile(), settings: baseSettings, nowMs: NOW });

  assert.equal(res.exitCode, 0);
  assert.equal(lineWith(res.report, 'Account identity'), MISMATCH_178414_999);
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/debug_token', '/178414'],
    'on Path B `me` is not the IG account, so it is never asked',
  );

  // The id the answer names is wire text, so it is quoted like any other.
  const hostile = await runDoctor({
    req: fakeReq(routing({ debug: HEALTHY_DEBUG, account: () => ({ id: '9\u001b[2J' }) })).req,
    profile: fbProfile(),
    settings: baseSettings,
    nowMs: NOW,
  });
  assert.ok(
    lineWith(hostile.report, 'Account identity').includes('answered for account 9\\u{1b}[2J;'),
  );
});

test('a matching answer, a failed reachability GET or no configured id prints no identity line', async () => {
  const down = (): unknown => {
    throw new InstagramError('Unsupported get request.', { kind: 'validation', code: 100 });
  };
  const cases: { label: string; profile: ResolvedProfile; account: () => unknown; exit: number }[] =
    [
      { label: 'A match', profile: igProfile(), account: () => ({ id: '178414' }), exit: 0 },
      { label: 'B match', profile: fbProfile(), account: () => ({ id: '178414' }), exit: 0 },
      { label: 'A down', profile: igProfile(), account: down, exit: 1 },
      { label: 'B down', profile: fbProfile(), account: down, exit: 1 },
      // With no id configured the GET addresses `me`, the token's own account by
      // definition, so whatever id it answers with is the right one.
      {
        label: 'A unset',
        profile: igProfile({ accountId: undefined }),
        account: () => ({ id: '999' }),
        exit: 0,
      },
      {
        label: 'B unset',
        profile: fbProfile({ accountId: undefined }),
        account: () => ({ id: '999' }),
        exit: 0,
      },
    ];
  for (const c of cases) {
    const res = await runDoctor({
      req: fakeReq(routing({ debug: HEALTHY_DEBUG, account: c.account })).req,
      profile: c.profile,
      settings: baseSettings,
      nowMs: NOW,
    });
    assert.equal(res.exitCode, c.exit, c.label);
    assert.ok(!res.report.includes('Account identity'), c.label);
  }
});

test('env-derived ids and profile names are quoted and capped in every line (CC-DATA-94)', async () => {
  const esc = String.fromCharCode(27);
  const accountId = `178${esc}[2J`;
  const res = await runDoctor({
    req: fakeReq(routing({ account: () => ({ id: 'x'.repeat(80), username: `u‮` }) })).req,
    profile: igProfile({ name: `ops${esc}[32m`, accountId }),
    settings: baseSettings,
    nowMs: NOW,
  });

  assert.ok(!res.report.includes(esc), 'no raw ESC anywhere');
  assert.ok(!res.report.includes('‮'), 'no raw bidi override anywhere');
  assert.ok(
    res.report.includes('Active profile: ops\\u{1b}[32m (ig-login'),
    'header quotes the name',
  );
  assert.ok(res.report.includes('  INFO  Profile:            ops\\u{1b}[32m'));
  const long = `${'x'.repeat(64)}… (80 characters in all)`;
  assert.equal(
    lineWith(res.report, 'Reachability OK'),
    `  OK    Reachability OK — GET /178\\u{1b}[2J resolved account id=${long} (@u\\u{202e}).`,
  );
  assert.equal(
    lineWith(res.report, 'Account identity'),
    '  WARN  Account identity MISMATCH — IG_PROFILE_OPS\\u{1b}[32M_ACCOUNT_ID is 178\\u{1b}[2J, ' +
      `but GET /178\\u{1b}[2J answered for account ${long}; every tool addresses ` +
      '178\\u{1b}[2J. If that is not the account you mean to operate, set ' +
      'IG_PROFILE_OPS\\u{1b}[32M_ACCOUNT_ID to the id of the account the token belongs to.',
  );
});

test('a failed reachability GET quotes the configured id it names (CC-DATA-94)', async () => {
  const res = await runDoctor({
    req: fakeReq(
      routing({
        debug: HEALTHY_DEBUG,
        account: () => {
          throw new InstagramError('down', { kind: 'upstream' });
        },
      }),
    ).req,
    profile: fbProfile({ accountId: 'a\nFAIL forged' }),
    settings: baseSettings,
    nowMs: NOW,
  });
  assert.equal(
    lineWith(res.report, 'Reachability FAILED'),
    '  FAIL  Reachability FAILED — GET /a\\u{a}FAIL forged: down [kind=upstream]',
  );
});

test('the recorded-expiry label and warning quote the profile name they carry (CC-DATA-94)', async () => {
  const esc = String.fromCharCode(27);
  for (const [expires, needle] of [
    [(NOW + 3 * DAY) / 1000, 'expiring_soon'],
    [(NOW - 3 * DAY) / 1000, 'expired'],
    [(NOW + 200 * DAY) / 1000, 'valid'],
  ] as const) {
    const res = await runDoctor({
      req: fakeReq(routing({ account: () => ({ id: '178414' }) })).req,
      profile: igProfile({ name: `p${esc}[31m`, tokenExpiresAtSec: expires }),
      settings: baseSettings,
      nowMs: NOW,
    });
    const line = lineWith(res.report, 'Token expiry');
    assert.ok(!res.report.includes(esc), `no raw ESC (${needle})`);
    assert.ok(
      line.includes('Token expiry (recorded in IG_PROFILE_P\\u{1b}[31M_TOKEN_EXPIRES_AT)'),
      line,
    );
    assert.ok(line.includes(needle), line);
  }
});

test('the package selection and the journal path are echoed with their controls escaped (CC-DATA-94)', async () => {
  const esc = String.fromCharCode(27);
  const res = await runDoctor({
    req: fakeReq(routing({ account: () => ({ id: '178414' }) })).req,
    profile: igProfile(),
    settings: testSettings({ writeJournal: join(journalRoot, `j${esc}[2J`, 'writes.jsonl') }),
    nowMs: NOW,
    env: {
      IG_TOOL_PACKAGES: `bogus${esc}[2J`,
      IG_PACKAGES_DENY: `d\u2028x`,
      IG_PACKAGES_READONLY: `r${esc}`,
    },
  });
  assert.ok(!res.report.includes(esc), 'no raw ESC anywhere');
  assert.ok(!res.report.includes('\u2028'), 'no raw line separator anywhere');
  assert.equal(
    packagesLine(res.report),
    '  INFO  Active packages:    bogus\\u{1b}[2J (deny: d\\u{2028}x) (read-only: r\\u{1b})',
  );
  assert.ok(
    journalLine(res.report).includes(`${join(journalRoot, 'j\\u{1b}[2J', 'writes.jsonl')} (`),
  );
});

test('a journal blocked by a file whose name carries a control is reported escaped (CC-DATA-94)', async () => {
  const esc = String.fromCharCode(27);
  const dir = mkdtempSync(join(journalRoot, 'esc-blocked-'));
  writeFileSync(join(dir, `f${esc}`), 'a file where a directory has to go\n');
  const res = await runDoctor({
    req: fakeReq(routing({ account: () => ({ id: '178414' }) })).req,
    profile: igProfile(),
    settings: testSettings({ writeJournal: join(dir, `f${esc}`, 'writes.jsonl') }),
    nowMs: NOW,
  });
  assert.ok(!res.report.includes(esc));
  assert.ok(
    journalLine(res.report).includes(`NOT writable (${join(dir, 'f\\u{1b}')} is not a directory)`),
    journalLine(res.report),
  );
});

test('an undetermined journal state quotes the reason, which carries the path (CC-DATA-94)', async () => {
  // ENAMETOOLONG's message names the path it refused, so a control character in
  // the configured path reaches the reason as well as the path clause.
  const esc = String.fromCharCode(27);
  const res = await runDoctor({
    req: fakeReq(routing({ account: () => ({ id: '178414' }) })).req,
    profile: igProfile(),
    settings: testSettings({
      writeJournal: join(journalRoot, `${'z'.repeat(5000)}${esc}`, 'writes.jsonl'),
    }),
    nowMs: NOW,
  });
  const line = journalLine(res.report);
  assert.ok(line.includes('state could not be determined ('), line.slice(0, 200));
  assert.ok(line.includes('ENAMETOOLONG'));
  assert.ok(!res.report.includes(esc), 'no raw ESC in the path or in the reason');
  assert.equal(line.split('\\u{1b}').length - 1, 2, 'escaped once in the path, once in the reason');
});

test('Path B: doctor reports the data-access window, which expires independently (CC-AUTH-77)', async () => {
  const run = async (dataAccess: unknown) => {
    const { req } = fakeReq(
      routing({
        debug: () => ({
          data: {
            is_valid: true,
            app_id: '55500',
            scopes: ['instagram_basic', 'pages_show_list'],
            expires_at: 0,
            ...(dataAccess === undefined ? {} : { data_access_expires_at: dataAccess }),
          },
        }),
        account: () => ({ id: '178414', username: 'acme' }),
      }),
    );
    return runDoctor({ req, profile: fbProfile(), settings: baseSettings, nowMs: NOW });
  };
  const lineOf = (report: string): string | undefined =>
    report.split('\n').find((l) => l.includes('Data access expiry'));

  // Open window: an OK line with the instant.
  const openSec = (NOW + 30 * DAY) / 1000;
  const open = await run(openSec);
  assert.equal(open.exitCode, 0);
  assert.equal(
    lineOf(open.report),
    `  OK    Data access expiry: open until ${new Date(openSec * 1000).toISOString()}.`,
  );

  // Closed window on a valid token: a WARN naming the remedy. The exit code is
  // left to the reachability check, which is the authority on data reads.
  const closedSec = NOW / 1000;
  const closed = await run(closedSec);
  const closedIso = new Date(closedSec * 1000).toISOString();
  assert.equal(
    lineOf(closed.report),
    `  WARN  Data access expiry: expired — Data access expired at ${closedIso}: the token can ` +
      'still be valid, but reads of Instagram data fail with a permission error until the app ' +
      'is re-authorized; run the `login` CLI to renew the data-access window.',
  );
  assert.equal(closed.exitCode, 0, 'reachability passed here, so the run stays healthy');

  // Unrepresentable: an INFO line naming the value, escaped.
  const odd = await run('soon\u202e');
  assert.equal(
    lineOf(odd.report),
    '  INFO  Data access expiry: unknown — Data-access expiry is unknown: upstream reported a ' +
      '`data_access_expires_at` of "soon\\u{202e}" (type string), which is not a representable timestamp.',
  );
  assert.equal(odd.exitCode, 0);

  // No window (omitted, or Meta's 0 sentinel): no line at all.
  assert.equal(lineOf((await run(undefined)).report), undefined);
  assert.equal(lineOf((await run(0)).report), undefined);
});
