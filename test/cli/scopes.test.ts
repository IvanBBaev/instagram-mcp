/**
 * Tests for the scope contract shared by `login` and `doctor`.
 *
 * The table itself is pinned where it is observable — `login.test.ts` reads the
 * scopes off the authorize URL the CLI actually builds, which is what the
 * operator's browser sees. Importing `DEFAULT_SCOPES` here to assert its members
 * would compare a value to itself and pass no matter what the constant said, so
 * this file tests the thing the constant is *for*: the comparison `doctor` runs
 * against a real grant.
 *
 * The comparison is what makes two documented promises true — the setup guide's
 * "over-granted scopes are flagged by `doctor` so you can trim them" and
 * `docs/security.md`'s "token scope drift" line. Before this module those
 * sentences described nothing: `doctor` printed the grant and stopped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyScopes, ALWAYS_GRANTED_SCOPES, DEFAULT_SCOPES } from '../../src/cli/scopes.js';

/** A grant that matches a path exactly, built from the table under test. */
function exactGrant(path: 'ig-login' | 'fb-login'): string[] {
  return [...DEFAULT_SCOPES[path]];
}

test('a grant that matches the path exactly reports no drift in either direction', () => {
  for (const path of ['ig-login', 'fb-login'] as const) {
    assert.deepEqual(
      classifyScopes(path, exactGrant(path)),
      { missing: [], extra: [] },
      `${path}: an exact grant must be reported as clean`,
    );
  }
});

test('grant order does not change the verdict, and the report is sorted', () => {
  // `debug_token` promises no order. An operator diffing two doctor runs should
  // see a change only when the grant changed, not when Meta reshuffled a list.
  const granted = [...exactGrant('fb-login')].reverse();
  granted.push('pages_manage_posts', 'ads_management');
  granted.splice(granted.indexOf('instagram_manage_comments'), 1);

  assert.deepEqual(classifyScopes('fb-login', granted), {
    missing: ['instagram_manage_comments'],
    extra: ['ads_management', 'pages_manage_posts'],
  });
});

test('a scope the server never uses is reported as over-granted', () => {
  // The failure this catches: a token minted with `pages_manage_posts` can write
  // to the Page feed forever, and nothing in this server would ever have needed
  // it. Listing the grant without comparing it leaves that invisible.
  const { extra, missing } = classifyScopes('fb-login', [
    ...exactGrant('fb-login'),
    'pages_manage_posts',
  ]);
  assert.deepEqual(extra, ['pages_manage_posts']);
  assert.deepEqual(missing, [], 'a superset must not also be reported as incomplete');
});

test('a scope the path needs but the token lacks is reported as missing', () => {
  // The failure this catches: the token works, `doctor` is green, and the first
  // `insights` call weeks later returns an opaque 10/200-series permission error.
  const granted = exactGrant('ig-login').filter(
    (scope) => scope !== 'instagram_business_manage_insights',
  );
  const { missing, extra } = classifyScopes('ig-login', granted);
  assert.deepEqual(missing, ['instagram_business_manage_insights']);
  assert.deepEqual(extra, [], 'a subset must not also be reported as over-granted');
});

test('scopes Facebook attaches to every token are not reported as over-granted', () => {
  // Noise on every single run is how a real finding gets ignored.
  const granted = [...exactGrant('fb-login'), ...ALWAYS_GRANTED_SCOPES];
  assert.deepEqual(classifyScopes('fb-login', granted), { missing: [], extra: [] });
});

test('the always-granted exemption matches names exactly, not loosely', () => {
  // A prefix/substring/whitespace-tolerant exemption would silently swallow a
  // real grant that merely looks like the exempt one. Each of these is a scope
  // the server does not use and must therefore be surfaced.
  const nearMisses = ['public_profile_extended', 'PUBLIC_PROFILE', ' public_profile', 'profile'];
  const { extra } = classifyScopes('fb-login', [...exactGrant('fb-login'), ...nearMisses]);
  assert.deepEqual(extra, [...nearMisses].sort());
});

test('the expected set is chosen by path, not shared between them', () => {
  // Path A and Path B use disjoint scope vocabularies (granular vs classic
  // names). Measuring one against the other must report the whole grant as
  // wrong, not quietly accept it.
  const { missing, extra } = classifyScopes('ig-login', exactGrant('fb-login'));
  assert.deepEqual(missing, [...exactGrant('ig-login')].sort());
  assert.deepEqual(extra, [...exactGrant('fb-login')].sort());
});

test('no default scope set asks for DM access', () => {
  // The rule, not the list: this survives someone extending either array, which
  // a verbatim pin updated in the same commit would not.
  for (const path of ['ig-login', 'fb-login'] as const) {
    assert.deepEqual(
      DEFAULT_SCOPES[path].filter((scope) => scope.includes('messages')),
      [],
      `${path} would ask the operator to grant DM access that no tool can use`,
    );
  }
});

test('the table cannot be widened at runtime by an importing module', () => {
  // `readonly` is erased at compile time, so an importer could cast it away and
  // push a scope onto the live array — silently widening what every subsequent
  // `login` asks the operator to grant. Same reasoning as `ALLOWED_HOSTS`.
  const table = DEFAULT_SCOPES as Record<string, string[]>;
  assert.throws(() => table['ig-login']?.push('instagram_business_manage_messages'), TypeError);
  assert.throws(() => {
    table['fb-login'] = ['anything'];
  }, TypeError);
  assert.deepEqual(
    DEFAULT_SCOPES['ig-login'].filter((scope) => scope.includes('messages')),
    [],
  );
});

test('the always-granted list cannot be widened at runtime by an importing module', () => {
  // This is the one list that tells `doctor` NOT to report something, so
  // widening it is how a real over-grant is made invisible: push a scope onto it
  // and a Path B token carrying it stops being flagged. `pages_manage_posts` is
  // the one used here because it is a real over-grant — a write permission on
  // Pages that no tool in this server exercises.
  // It was a frozen `Set` until 2026-09-23, which read like this same guard and
  // was not one — `Object.freeze` leaves a Set's members reachable through
  // `.add()`, silently and even under strict mode, because they live in internal
  // slots rather than own properties. Same reasoning as `ALLOWED_HOSTS`, and now
  // the same guarantee.
  const mutable = ALWAYS_GRANTED_SCOPES as string[];

  assert.ok(Object.isFrozen(ALWAYS_GRANTED_SCOPES), 'must be frozen, not merely readonly');
  assert.throws(() => mutable.push('pages_manage_posts'), TypeError);
  assert.throws(() => {
    mutable[0] = 'pages_manage_posts';
  }, TypeError);
  assert.throws(() => {
    mutable.length = 0;
  }, TypeError);

  assert.deepEqual(ALWAYS_GRANTED_SCOPES, ['public_profile']);
  // And the over-grant the push was trying to silence is still reported.
  const granted = [...exactGrant('fb-login'), 'pages_manage_posts'];
  assert.deepEqual(classifyScopes('fb-login', granted).extra, ['pages_manage_posts']);
});
