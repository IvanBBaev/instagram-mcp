/**
 * Unit tests for the `doctor` health-check CLI command (src/cli/doctor.ts).
 *
 * `runDoctor` is fully injectable: a fake {@link IgRequestFn} routes on the
 * request path (`/debug_token` vs the reachability `GET /{ig-id}`), the profile
 * and settings are plain objects, and time is pinned via `nowMs`. No network,
 * no global state — the checks are observed purely through the returned report
 * string and exit code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDoctor } from '../../src/cli/doctor.js';
import { InstagramError } from '../../src/core/types.js';
import type {
  IgRequestFn,
  IgRequestOptions,
  Logger,
  ResolvedProfile,
  Settings,
} from '../../src/core/types.js';

const DAY = 86_400_000;
const NOW = 100 * DAY;

/** A distinctive, token-shaped secret so redaction assertions are meaningful. */
const ACCESS_TOKEN = 'EAAJtestTOKENvalue0123456789abcXYZsecret';

const baseSettings: Settings = {
  maxConcurrent: 4,
  maxItems: 200,
  refreshAfterDays: 45,
  timeoutMs: 30_000,
  logLevel: 'info',
  prettyJson: false,
  writeMode: 'preview',
  allowDestructive: false,
  transport: 'stdio',
  httpHost: '127.0.0.1',
  httpPort: 3000,
};

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
