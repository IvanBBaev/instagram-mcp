/**
 * Direct contract tests for the SSRF gate — `src/core/host.ts`.
 *
 * This module decides where the operator's long-lived Instagram access token is
 * sent. Every outgoing Graph URL in the process is assembled here and nowhere
 * else, so a single wrong character in a host literal, in the version pin, or in
 * the URL separators either leaks the token to a host the operator never
 * approved or silently changes which Graph contract the whole server speaks.
 *
 * Until this file existed the module was only exercised incidentally through
 * `test/core/http.test.ts`; these tests pin the behaviour directly so it cannot
 * be refactored away.
 *
 * Two refusal layers live here and they are distinguishable ONLY by the message
 * suffix: the loopback/private range check fires first and appends
 * `(loopback/private address)`; the exact-match allowlist fires second and does
 * not. Several tests below assert on that suffix precisely because it is the
 * only externally visible evidence that the defense-in-depth layer is alive.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWED_HOSTS, GRAPH_VERSION, assertAllowedHost, buildUrl } from '../../src/core/host.js';
import type { QueryParams } from '../../src/core/host.js';
import { InstagramError } from '../../src/core/types.js';
import type { GraphHost } from '../../src/core/types.js';

// `core/host.ts` is pure, but a regression that made it reach out would be a
// severe one — pin the global so nothing in this file can open a socket.
const realFetch: typeof globalThis.fetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('host unit tests must never touch the network');
};
after(() => {
  globalThis.fetch = realFetch;
});

/** The refusal `assertAllowedHost` produced, or `undefined` when it allowed the host. */
function refusalFor(host: string): InstagramError | undefined {
  try {
    assertAllowedHost(host);
    return undefined;
  } catch (err) {
    assert.ok(err instanceof InstagramError, `expected an InstagramError for host "${host}"`);
    return err;
  }
}

/** Assert `host` was refused by the loopback/private range check (layer one). */
function assertRefusedAsPrivate(host: string): void {
  const err = refusalFor(host);
  assert.ok(err, `"${host}" must be refused`);
  assert.equal(
    err.message,
    `Refusing request to non-allowlisted host "${host}" (loopback/private address)`,
    `"${host}" must be refused by the loopback/private layer, with that layer named`,
  );
  assert.equal(err.kind, 'validation');
}

/** Assert `host` was refused by the exact-match allowlist (layer two), not the range check. */
function assertRefusedAsOffAllowlist(host: string): void {
  const err = refusalFor(host);
  assert.ok(err, `"${host}" must be refused`);
  assert.equal(
    err.message,
    `Refusing request to non-allowlisted host "${host}"`,
    `"${host}" must be refused by the allowlist, without the loopback/private marker`,
  );
  assert.equal(err.kind, 'validation');
}

/*
 * The version travels in EVERY Graph URL. A silent bump changes field
 * semantics, deprecation windows and error codes for every tool at once, and an
 * empty/floating value hands the contract choice to Meta on each call. Bumping
 * it is meant to be a deliberate, changelog-reviewed PR — this equality is the
 * tripwire that forces the PR to touch a test.
 */
test('GRAPH_VERSION is the exact pinned Graph API version', () => {
  assert.equal(GRAPH_VERSION, 'v25.0');
});

/*
 * This literal IS the SSRF policy. A third entry (a resumable-upload host, a
 * non-API Meta host, a lookalike domain) widens where the access token may be
 * sent without any other code changing; dropping an entry silently disables one
 * of the two supported auth paths. Pinning the array exactly — contents, order
 * and length — means any edit to the policy has to be argued for in review.
 */
test('ALLOWED_HOSTS is exactly the two Graph API hosts', () => {
  assert.deepEqual(ALLOWED_HOSTS, ['graph.instagram.com', 'graph.facebook.com']);
});

/*
 * `readonly` is erased before anything runs, so it protects the policy only
 * against a careless author, not against a running program. The array is a live
 * module-level object every importer shares: one `push` through a widening cast
 * — from a dependency, a plugin, or a test helper that outlived its scope —
 * would add a host to the SSRF allowlist for the rest of the process, and every
 * later `assertAllowedHost` would wave the operator's access token through to
 * it. The freeze is what makes the type-level promise a runtime one, and the
 * refusal at the end is the part that matters: the attempt must not only throw,
 * it must leave the gate closed.
 */
test('ALLOWED_HOSTS is frozen: a runtime push cannot widen the SSRF allowlist', () => {
  const rogue: string = 'evil.example.com';
  // The cast IS the attack — it is exactly what an importing module would write
  // to get past the `readonly` annotation.
  const mutable = ALLOWED_HOSTS as GraphHost[];

  assert.ok(Object.isFrozen(ALLOWED_HOSTS), 'ALLOWED_HOSTS must be frozen, not merely readonly');
  assert.throws(() => mutable.push(rogue as GraphHost), TypeError);
  assert.throws(() => {
    mutable[0] = rogue as GraphHost;
  }, TypeError);
  assert.throws(() => {
    mutable.length = 0;
  }, TypeError);

  assert.deepEqual(ALLOWED_HOSTS, ['graph.instagram.com', 'graph.facebook.com']);
  assertRefusedAsOffAllowlist(rogue);
  assert.doesNotThrow(() => assertAllowedHost('graph.instagram.com'));
});

/*
 * Both supported auth paths must stay reachable — Path A (ig-login) talks to
 * graph.instagram.com, Path B (fb-login) to graph.facebook.com — and the
 * `asserts host is GraphHost` signature is what lets a caller hand a plain
 * `string` from config straight to `buildUrl`. If the signature degraded to
 * `void`, every call site would need its own cast and the compiler would stop
 * enforcing that an unchecked string never reaches a URL.
 */
test('assertAllowedHost admits both Graph hosts and narrows them to GraphHost', () => {
  const fromConfig: string = 'graph.instagram.com';
  assertAllowedHost(fromConfig);
  const narrowed: GraphHost = fromConfig;
  assert.equal(narrowed, 'graph.instagram.com');

  const other: string = 'graph.facebook.com';
  assertAllowedHost(other);
  const narrowedOther: GraphHost = other;
  assert.equal(narrowedOther, 'graph.facebook.com');
});

/*
 * Hosts arrive from config files and environment variables, where a trailing
 * newline or a capitalised copy-paste is routine, and DNS is case-insensitive
 * anyway. Refusing those would be a false SSRF alarm that blocks a legitimate
 * operator from ever making a call — the failure mode is a dead server, not a
 * leak, which is why normalization has to be tested as carefully as refusal.
 */
test('assertAllowedHost trims surrounding whitespace and lower-cases before matching', () => {
  for (const host of [
    ' graph.instagram.com',
    'graph.instagram.com ',
    '  graph.facebook.com  ',
    '\tgraph.facebook.com\n',
    'GRAPH.INSTAGRAM.COM',
    'Graph.Facebook.Com',
    ' GRAPH.INSTAGRAM.COM ',
  ]) {
    assert.equal(refusalFor(host), undefined, `"${host}" is the allowlisted host, just untidy`);
  }
});

/*
 * The refusal path is the actual security control: anything that is not one of
 * the two Graph hosts must never reach a socket. `rupload.facebook.com` is in
 * this list on purpose — it is a real Meta host that v1 deliberately does NOT
 * allow, so it is the closest thing to a plausible accidental widening. The
 * `validation` kind matters too: it is what makes the MCP layer report an
 * operator/config mistake instead of retrying against upstream.
 */
test('assertAllowedHost refuses every off-allowlist host as a validation error', () => {
  for (const host of [
    'evil.example.com',
    'rupload.facebook.com',
    'www.instagram.com',
    'api.instagram.com',
    'instagram.com',
    'facebook.com',
    '',
    ' ',
    '8.8.8.8',
    'graph.instagram.com.',
  ]) {
    assertRefusedAsOffAllowlist(host);
  }
});

/*
 * Every one of these is a real phishing/SSRF shape: an attacker-controlled
 * parent domain (`graph.instagram.com.evil.com`), an attacker-controlled child
 * (`evilgraph.instagram.com`), a truncation (`graph.instagram.co`), a port
 * redirect (`graph.instagram.com:8443`) or a bare substring (`graph`). They all
 * pass a prefix, suffix or substring test and all must fail an exact match —
 * this is the difference between an allowlist and a suggestion. The userinfo
 * shapes (`user@graph.instagram.com`, `graph.instagram.com@evil.com`) are the
 * near miss a URL parser invites: anything that "looks past the `@`" admits a
 * string that is not a host at all.
 */
test('the allowlist is an exact match — never a prefix, suffix, or substring', () => {
  for (const host of [
    'user@graph.instagram.com',
    'user:pass@graph.facebook.com',
    'graph.instagram.com@evil.com',
    'graph.facebook.com.evil',
    'xgraph.facebook.com',
    'graph.instagram.com.evil.com',
    'graph.facebook.com.attacker.net',
    'evilgraph.instagram.com',
    'notgraph.facebook.com',
    'graph.instagram.com:8443',
    'graph.instagram.co',
    'graph.facebook.co',
    'graph.lnstagram.com',
    'graph-instagram.com',
    'edge.graph.instagram.com',
    'www.graph.facebook.com',
    'graph',
    'com',
    'https://graph.instagram.com',
    'graph.instagram.com/v25.0',
  ]) {
    assertRefusedAsOffAllowlist(host);
  }
});

/*
 * The message is what the operator sees in the MCP error and in the log. It has
 * to echo the string they actually configured, byte for byte, because the
 * mistake is usually invisible in the normalized form — a trailing space or a
 * stray capital is exactly what they need to see. Echoing the normalized host
 * would hide the typo and send them looking in the wrong place.
 */
test('a refusal quotes the caller string verbatim, not the normalized one', () => {
  const offAllowlist = refusalFor('  EVIL.example.com  ');
  assert.ok(offAllowlist);
  assert.equal(
    offAllowlist.message,
    'Refusing request to non-allowlisted host "  EVIL.example.com  "',
  );

  const loopback = refusalFor('  LOCALHOST  ');
  assert.ok(loopback);
  assert.equal(
    loopback.message,
    'Refusing request to non-allowlisted host "  LOCALHOST  " (loopback/private address)',
  );
});

/*
 * These are the targets an SSRF attempt actually aims at: the cloud metadata
 * endpoint (169.254.169.254, which hands out instance credentials), a local
 * debug proxy, a container-network sibling, an IPv6 loopback. The exact-match
 * allowlist would refuse them anyway — the reason this layer exists is that its
 * message says *why*, so an operator can tell "someone tried to point the
 * server at the metadata service" apart from "I typo'd my host". Losing the
 * marker silently downgrades an intrusion signal into a config-typo signal.
 *
 * The bracket, port and stray-punctuation shapes are here because the address
 * is compared as a string: `[::1]:443`, `[::1`, `10.0.0.1[` and `localhost:3000`
 * must all reduce to the same bare address before the range checks run.
 */
test('the loopback/private layer refuses smuggled internal targets and names itself', () => {
  for (const host of [
    // Loopback names.
    'localhost',
    'localhost:3000',
    'LocalHost:8080',
    'sub.localhost',
    'a.b.localhost',
    // Unspecified / IPv6 loopback, bracketed and bare, terminated and not.
    '0.0.0.0',
    '::',
    '::1',
    '[::1]',
    '[::1]:443',
    '[::]',
    '[::',
    '[::1]]',
    '[0.0.0.0',
    // IPv4 loopback 127.0.0.0/8.
    '127.0.0.1',
    '127.0.0.1:8080',
    '127.1.1.1',
    '[127.0.0.1]',
    // RFC1918 10.0.0.0/8, including a stray trailing bracket.
    '10.0.0.5',
    '10.0.0.5:3128',
    '10.0.0.1[',
    // RFC1918 192.168.0.0/16 and link-local 169.254.0.0/16.
    '192.168.1.1',
    '169.254.169.254',
    '[169.254.169.254',
    // RFC1918 172.16.0.0/12 — both edges and the middle of the range.
    '172.16.0.1',
    '172.19.0.1',
    '172.20.10.1',
    '172.29.0.1',
    '172.31.255.254',
    // IPv6 unique-local fc00::/7.
    '[fd00::1]',
    '[fc00::1]:443',
    '[fd::1]',
    '[fdab::1]',
    '[fdff::1]',
    // IPv6 link-local fe80::/10.
    '[fe80::1]',
    '[fe8a::1]',
    '[feb0::1]',
  ]) {
    assertRefusedAsPrivate(host);
  }
});

/*
 * The mirror image, and the more dangerous direction: a range check that is too
 * greedy starts mislabelling ordinary public addresses as internal. Every host
 * here is public (100.64/10 is carrier-grade NAT, 192.0.2/24 is TEST-NET,
 * fe00::/9 and fec0::/10 are not link-local) or is an attacker-chosen name that
 * merely *contains* a private-looking substring. They must still be refused —
 * by the allowlist — but reporting them as loopback would fill the log with
 * phantom SSRF alarms and hide the real ones.
 */
test('public addresses that merely resemble private ranges are not reported as loopback', () => {
  for (const host of [
    // Loopback-shaped names that are not loopback.
    'notlocalhost',
    'localhost.evil.com',
    'x.localhost.evil.com',
    'sub.local',
    // 127.0.0.0/8 boundaries.
    '1270.1.2.3',
    'x127.0.0.1',
    '128.0.0.1',
    // 10.0.0.0/8 boundaries.
    '1.2.3.4',
    '100.64.0.1',
    'x10.0.0.5',
    // 192.168.0.0/16 boundaries.
    '192.0.2.1',
    '192.1680.0.1',
    '192.169.0.1',
    // 169.254.0.0/16 boundaries.
    '169.1.2.3',
    '169.2540.1.1',
    '169.253.0.1',
    // 172.16.0.0/12 boundaries — 15 and 32 are outside, 2 and 160 are not the range at all.
    '172.15.0.1',
    '172.32.0.1',
    '172.2.0.1',
    '172.160.0.1',
    '172.0.0.1',
    // IPv6 prefixes just outside fc00::/7 and fe80::/10.
    '[fe00::1]',
    '[fec0::1]',
    // Private-looking prefixes with no IPv6 group separator, or not anchored.
    'fd.example.com',
    'xfd00::1',
    'fe80.example.com',
    'xfe80::1',
  ]) {
    assertRefusedAsOffAllowlist(host);
  }
});

/*
 * The assembled string is the whole product of this module, so it is asserted
 * whole rather than by `startsWith`/`includes`. Every piece is load-bearing:
 * `https` (a downgrade to http puts the access token on the wire in clear),
 * `//` (`https:/host` is a relative path, not an absolute URL), the host taken
 * from the argument rather than hard-wired (hard-wiring sends Path A traffic to
 * the Path B host, where the token is invalid and `appsecret_proof` is
 * expected), the single `/` before the version, and the path appended raw so
 * its own slashes stay separators.
 */
test('buildUrl assembles an absolute, version-pinned https URL for both Graph hosts', () => {
  assert.equal(
    buildUrl('graph.instagram.com', '/17841400000000000/media'),
    'https://graph.instagram.com/v25.0/17841400000000000/media',
  );
  assert.equal(
    buildUrl('graph.facebook.com', '/oauth/access_token'),
    'https://graph.facebook.com/v25.0/oauth/access_token',
  );
  // An empty path leaves the version as the last segment — no trailing slash.
  assert.equal(buildUrl('graph.instagram.com', ''), 'https://graph.instagram.com/v25.0');
});

/*
 * `core/http.ts` merges the caller's params with the auth params (the access
 * token, and on Path B the appsecret_proof) into this one object, so every
 * detail here is a token-handling detail. `?` must be the separator — `&`
 * folds the query into the last path segment and `#` turns the entire auth
 * query into a fragment that is never sent, producing a confusing unauthorized
 * response instead of a request. Values must be percent-encoded exactly once:
 * `id,caption` has to arrive as `id%2Ccaption`, and double-encoding it would
 * make Graph reject the field list.
 *
 * The `undefined` entry sits in the MIDDLE deliberately: optional params are
 * routinely undefined, and a guard that aborted the loop instead of skipping
 * the entry would silently drop every later param — including the access token.
 */
test('buildUrl appends the query in declaration order, encoded once, skipping undefined', () => {
  assert.equal(
    buildUrl('graph.instagram.com', '/me/media', {
      limit: 5,
      skip: undefined,
      fields: 'id,caption',
      flag: true,
    }),
    'https://graph.instagram.com/v25.0/me/media?limit=5&fields=id%2Ccaption&flag=true',
  );
});

/*
 * Only `undefined` means "absent". `0`, `false` and the empty string are real
 * Graph values (a zero offset, an explicit opt-out, a cleared filter) and a
 * falsy-value guard would drop them, turning an explicit request into a
 * different one that the caller never asked for and cannot see in the URL.
 */
test('buildUrl keeps falsy param values and drops only undefined', () => {
  assert.equal(
    buildUrl('graph.facebook.com', '/me', { q: '', n: 0, flag: false, gone: undefined }),
    'https://graph.facebook.com/v25.0/me?q=&n=0&flag=false',
  );
});

/*
 * CC-DATA-10, and the reason this module cannot rely on its own parameter type.
 * `QueryParams` says `string | number | boolean | undefined`, but the annotation
 * is erased before the loop runs and nothing validates a params object: `req`
 * CASTS the parsed Graph body, so `paging.cursors.after` is `string | undefined`
 * by declaration and JSON `null` in fact, and `api/media.ts` carries that value
 * forward as the next cursor. `String(null)` then serialized it, and
 * `…/999/media?fields=id&after=null` went out over a live token — a request for
 * the page after a cursor that does not exist. It is not a rejected request that
 * announces itself; it is a plausible one that means something no caller asked
 * for.
 *
 * The casts below are the defect itself, written out: they are exactly the shape
 * an unvalidated upstream value has by the time it reaches this function.
 *
 * The `null` sits in the MIDDLE for the same reason the `undefined` does in the
 * test above — `core/http.ts` merges the auth params into this one object, so a
 * guard that aborted the loop instead of skipping the entry would drop every
 * later param, `access_token` included, and send an unauthenticated request.
 */
test('buildUrl drops a null param instead of sending the literal string "null"', () => {
  const fromGraph = { fields: 'id', after: null } as unknown as QueryParams;
  assert.equal(
    buildUrl('graph.instagram.com', '/999/media', fromGraph),
    'https://graph.instagram.com/v25.0/999/media?fields=id',
    'a null cursor must vanish from the query, not become the four characters "null"',
  );

  const withAuthBehind = { limit: 5, after: null, access_token: 'NOT_A_REAL_TOKEN' };
  assert.equal(
    buildUrl('graph.instagram.com', '/me/media', withAuthBehind as unknown as QueryParams),
    'https://graph.instagram.com/v25.0/me/media?limit=5&access_token=NOT_A_REAL_TOKEN',
    'params after the skipped one must survive — the loop continues, it does not break',
  );

  // Nullish-only collapses to the bare base, with no trailing "?" — the same
  // shape the "no effective params" test above pins, for the same reason:
  // `core/refresh.ts` compares built URLs to decide whether a refresh is already
  // in flight, and two spellings of the same request would defeat that.
  assert.equal(
    buildUrl('graph.instagram.com', '/me', { a: null, b: undefined } as unknown as QueryParams),
    'https://graph.instagram.com/v25.0/me',
  );
});

/*
 * The guard is nullish, never falsy — the boundary the fix above must not cross.
 * `0`, `false` and `''` are values a caller deliberately chose (a zero offset,
 * an explicit opt-out, a cleared filter); widening the skip to cover them would
 * drop parameters that were asked for and issue a different request, invisibly.
 * They are asserted here in the SAME object as the `null` so the two conditions
 * are pinned against each other and not merely side by side.
 */
test('buildUrl skips null without touching the falsy values Graph treats as real', () => {
  assert.equal(
    buildUrl('graph.facebook.com', '/me', {
      q: '',
      n: 0,
      flag: false,
      after: null,
      gone: undefined,
    } as unknown as QueryParams),
    'https://graph.facebook.com/v25.0/me?q=&n=0&flag=false',
  );
});

/*
 * CC-DATA-14 — the one input that used to leave this module as something other
 * than an `InstagramError` of kind `validation`. `String(value)` is a ToString
 * on a caller-controlled value, and ToString is not total: an object with a
 * `null` prototype inherits neither `toString` nor `valueOf`, so the conversion
 * threw `TypeError: Cannot convert object to primitive value` — measured
 * verbatim before the fix — and that TypeError escaped `buildUrl` as itself,
 * past every caller that catches an `InstagramError` and reports its `kind`.
 *
 * The casts below are the defect written out: `QueryParams` is erased before
 * the loop runs, and the unvalidated Graph body that already delivers a `null`
 * cursor (CC-DATA-10) is the same one that can deliver an object.
 *
 * Refusing is the whole fix — a value with no string form has no query spelling
 * to invent, and the request was not going to be issued either way — so what is
 * pinned here is the SHAPE of the refusal, which is the part that changed: a
 * validation error like every other exit from this module, naming which
 * parameter (the raw TypeError named none), and echoing no value.
 */

/** The refusal `buildUrl` produced for `params`; fails if it accepted them. */
function paramRefusalFor(params: unknown): InstagramError {
  try {
    buildUrl('graph.instagram.com', '/me', params as QueryParams);
  } catch (err) {
    assert.ok(err instanceof InstagramError, 'a raw throw must not escape this module');
    assert.equal(err.kind, 'validation', 'refused as a validation error');
    return err;
  }
  return assert.fail('buildUrl accepted a param value that has no string form');
}

test('buildUrl refuses a param value with no string form, naming the key (CC-DATA-14)', () => {
  // The offender sits in the MIDDLE, between an ordinary param and the auth
  // param `core/http.ts` merges in last: the refusal must be about the value
  // that broke, not about whichever key happens to be first or last.
  const noPrimitive = Object.create(null) as unknown;
  const err = paramRefusalFor({ fields: 'id', after: noPrimitive, access_token: 'SECRET_TOKEN' });
  assert.match(err.message, /"after"/, 'the refusal names the offending parameter key');
  assert.equal(
    err.message.includes('SECRET_TOKEN'),
    false,
    'a refusal never echoes a param value — this one is a credential',
  );
  assert.equal(
    /cannot convert object to primitive/i.test(err.message),
    false,
    'the engine message is replaced, not wrapped: it names no parameter at all',
  );

  // The other way a ToString raises: the value's own `toString` throws. It is
  // the caller's code, so its message can say anything — including the secret
  // the value was carrying — and it escaped just as raw. Same refusal, and none
  // of that borrowed text is carried along.
  const throwingToString = {
    toString(): string {
      throw new Error('LEAKED_TOKEN_ab12');
    },
  };
  const err2 = paramRefusalFor({ since: throwingToString });
  assert.match(err2.message, /"since"/, 'the second raising path names its key too');
  assert.equal(err2.message.includes('LEAKED_TOKEN_ab12'), false, 'no borrowed message text');
});

/*
 * The boundary CC-DATA-14 must not cross. The refusal is for values with NO
 * string form — not for objects in general. An array and a plain object both
 * have a (sometimes useless) `toString`, so they are stringified and sent
 * exactly as they always were; widening the guard into "refuse anything that is
 * not a primitive" would be a different policy, and it would start refusing
 * calls this module has always allowed.
 */
test('buildUrl still stringifies a param value that does have a string form', () => {
  assert.equal(
    buildUrl('graph.instagram.com', '/me', {
      ids: ['1', '2'],
      obj: {},
    } as unknown as QueryParams),
    'https://graph.instagram.com/v25.0/me?ids=1%2C2&obj=%5Bobject+Object%5D',
  );

  // `String(value)` is not interchangeable with a template literal here, and the
  // difference is exactly one type: `String(sym)` yields "Symbol(x)" while
  // `${sym}` throws. Under the CC-DATA-14 guard that throw would be CAUGHT and
  // turned into a refusal, so the two spellings are two different policies for a
  // symbol. The one this module has always had is pinned here; whether
  // `s=Symbol(x)` is a query worth sending at all is a question for the register,
  // not one this fix should answer by accident.
  assert.equal(
    buildUrl('graph.instagram.com', '/me', { s: Symbol('x') } as unknown as QueryParams),
    'https://graph.instagram.com/v25.0/me?s=Symbol%28x%29',
  );

  // And the conversion happens exactly ONCE. The refusal has to stringify the
  // value to find out whether it can be stringified at all, so the result is
  // reused rather than recomputed: a second `String(value)` would re-enter a
  // caller-supplied `toString`, and a stateful one would then put a different
  // string on the wire than the one the guard just accepted.
  let conversions = 0;
  const counted = {
    toString(): string {
      conversions += 1;
      return `call-${conversions}`;
    },
  };
  assert.equal(
    buildUrl('graph.instagram.com', '/me', { c: counted } as unknown as QueryParams),
    'https://graph.instagram.com/v25.0/me?c=call-1',
  );
  assert.equal(conversions, 1, 'a caller-supplied toString runs once, not twice');
});

/*
 * Graph parameter names are case-sensitive and the server rejects unknown ones,
 * so silently lower-casing a key turns a valid call into an "unknown parameter"
 * error that looks like an API change. Values must survive untouched too: a
 * caller that deliberately sends surrounding whitespace (or a key that needs
 * encoding) must get exactly that on the wire, encoded once and not twice.
 */
test('buildUrl passes param keys and values through verbatim, encoding them once', () => {
  assert.equal(
    buildUrl('graph.instagram.com', '/me', { 'metric type': ' a b ', Since: '2026-01-01' }),
    'https://graph.instagram.com/v25.0/me?metric+type=+a+b+&Since=2026-01-01',
  );
});

/*
 * A URL that ends in a bare `?` is not wrong on the wire, but it is the shape
 * that shows up in logs and fixtures, and `core/refresh.ts` compares built URLs
 * when it decides whether a refresh call is already in flight. All four "no
 * effective params" shapes must collapse to the identical bare base.
 *
 * The `null` case is not reachable from TypeScript — it pins the fact that the
 * guard is `!params`, not `params === undefined`, so a JavaScript caller (this
 * package ships .d.ts, not enforcement) passing `null` gets the base URL rather
 * than a TypeError from `Object.entries(null)`.
 */
test('buildUrl returns the bare base when there are no effective params', () => {
  const base = 'https://graph.instagram.com/v25.0/me';
  assert.equal(buildUrl('graph.instagram.com', '/me'), base);
  assert.equal(buildUrl('graph.instagram.com', '/me', {}), base);
  assert.equal(buildUrl('graph.instagram.com', '/me', { a: undefined, b: undefined }), base);
  assert.equal(buildUrl('graph.instagram.com', '/me', null as unknown as QueryParams), base);
});

/*
 * `core/refresh.ts` calls `buildUrl` WITHOUT a separate `assertAllowedHost`
 * first, so this internal assertion is the only SSRF gate on the token-refresh
 * path — the one path that carries the long-lived token by definition. The
 * casts below simulate exactly what a `GraphHost` value that came from an
 * unchecked source at runtime would look like.
 */
test('buildUrl re-checks the allowlist even though its type says it cannot fail', () => {
  for (const host of [
    'evil.example.com',
    '169.254.169.254',
    'localhost',
    'graph.instagram.com.evil.com',
  ]) {
    assert.throws(
      () => buildUrl(host as GraphHost, '/me'),
      (err: unknown) => err instanceof InstagramError && err.kind === 'validation',
      `buildUrl must refuse "${host}"`,
    );
  }
});

/*
 * The compile-time half of the same gate: `buildUrl` accepts `GraphHost`, not
 * `string`, so a module that forgot to run the host through
 * `assertAllowedHost` cannot even build. If the parameter widened to `string`
 * this directive would become unused and the build would fail — which is the
 * point of asserting it here rather than in a comment.
 */
test('buildUrl rejects an unchecked string host at compile time', () => {
  const unchecked: string = 'evil.example.com';
  assert.throws(() => {
    // @ts-expect-error buildUrl takes an allowlisted GraphHost, never an open string.
    return buildUrl(unchecked, '/me');
  }, InstagramError);
});

/*
 * The path-shape invariant (CC-PROC-15). `path` is concatenated raw, so an api
 * function that interpolates an id without `encodeURIComponent` can restructure
 * the URL rather than merely address a different object. Every call site is
 * encoded today and `test/api/path-injection.test.ts` proves it end-to-end; the
 * assertion inside `buildUrl` is the guard for the api function written NEXT,
 * which no existing test can cover.
 *
 * It is a check on the result, never a repair: `buildUrl` refuses, so a
 * restructured URL cannot be silently "corrected" into one the caller never
 * asked for — and so the invariant can never double-encode a path an api
 * function already encoded (pinned by the final test in this group).
 */

/** The refusal `buildUrl` produced for `path`, or `undefined` when it accepted it. */
function pathRefusalFor(path: string): InstagramError | undefined {
  try {
    buildUrl('graph.instagram.com', path, { fields: 'id', access_token: 'SECRET_TOKEN' });
    return undefined;
  } catch (err) {
    assert.ok(err instanceof InstagramError, `expected an InstagramError for ${path}`);
    assert.equal(err.kind, 'validation', `${path}: refused as a validation error`);
    // The message states which invariant broke and nothing else. Echoing the
    // path would copy untrusted model input — an access token pasted where a
    // media id belongs, say — into logs and back into the model's context.
    assert.equal(err.message.includes(path), false, `${path}: the path is not echoed back`);
    assert.equal(err.message.includes('SECRET_TOKEN'), false, `${path}: no param is echoed`);
    return err;
  }
}

test('buildUrl refuses a path that would turn the query string into a fragment', () => {
  // Consequence 1: fetch does not send a fragment, so `access_token` never
  // leaves the process and Graph answers with an unexplainable 400.
  //
  // `/X#` is the case that dictates HOW the invariant is written. The parser
  // reports `hash === ''` for a bare trailing `#` — the component is present but
  // empty — so an invariant phrased as `hash !== ''` would wave it through, and
  // `buildUrl` would then append `?fields=…&access_token=…` behind that very `#`.
  // The structural comparison sees it, because `pathname` stops at the `#`.
  for (const path of ['/X#injected', '/X#', '/#/comments']) {
    const err = pathRefusalFor(path);
    assert.match(err?.message ?? '', /did not survive URL parsing/, `${path}: names the invariant`);
  }
});

test('buildUrl refuses a path that opens a query string of its own', () => {
  // Consequence 2: the smuggled pairs precede the auth params `core/http.ts`
  // merges in, so a first-wins parser on the far side reads the caller's value.
  // `/X?` is the empty-component twin of `/X#` above: `search` is also `''`.
  for (const path of ['/X?access_token=STOLEN', '/X?', '/X?a=1/comments']) {
    const err = pathRefusalFor(path);
    assert.match(err?.message ?? '', /did not survive URL parsing/, `${path}: names the invariant`);
  }
});

test('buildUrl refuses a path the URL parser would rewrite in place', () => {
  // The residue of the same class: a dot segment or a character outside the path
  // alphabet that resolves INSIDE the pinned prefix, so the version pin survives
  // but the URL addresses something the caller never wrote. `.` and `..` are the
  // sharp ones — `encodeURIComponent` passes both through untouched, so an id of
  // literally `.` is a hole a correctly encoded call site still has.
  for (const path of ['/X/./children', `/${encodeURIComponent('.')}/children`, '/X\\Y', '/X Y']) {
    const err = pathRefusalFor(path);
    assert.match(err?.message ?? '', /did not survive URL parsing/, `${path}: names the invariant`);
  }
});

test('buildUrl refuses a path that escapes the pinned version prefix', () => {
  // Consequence 3: `new URL` resolves dot segments, so `/v25.0/../me` really is
  // `/me` by the time fetch sees it — a versionless call against an unpinned
  // Graph contract. The last two cases are the other way out of the prefix: a
  // `path` that forgot its leading slash, which glues onto the version itself.
  //
  // `extra/v25.0/x` is that case carrying a SECOND copy of the version further
  // along, and it is the one that pins the prefix test as a `startsWith` rather
  // than a substring search. Its pathname is `/v25.0extra/v25.0/x`, which
  // CONTAINS `/v25.0/` while beginning with the segment `v25.0extra` — so a
  // containment test passes it, and it then survives the round-trip comparison
  // untouched (no dot segment, no character the parser rewrites). Both guards
  // would wave through a request whose real first path segment is off the pin.
  for (const path of ['/../me', '/X/../../me', 'me', 'extra/v25.0/x']) {
    const err = pathRefusalFor(path);
    assert.match(
      err?.message ?? '',
      new RegExp(`pinned /${GRAPH_VERSION} version prefix`),
      `${path}: names the version pin`,
    );
  }
});

/*
 * The failure mode of an over-eager invariant: "fixing" the path instead of
 * refusing it. `api/account.ts` was already encoding its id before the audit, so
 * a transformation here would double-encode `%2F` into `%252F` and address an
 * object that does not exist — a corruption no error would ever announce.
 * Everything an api function legitimately builds must therefore come back
 * byte-for-byte, including the encodings it applied itself.
 */
test('the path invariant returns accepted paths byte-for-byte, encoding nothing', () => {
  for (const path of [
    '', // the version-only base
    '/me',
    `/${encodeURIComponent('17841400008460056_17877854240352520')}/comments`,
    `/${encodeURIComponent('X#?&/../id')}`, // an already-encoded hostile id stays inert
    '/oauth/access_token',
    `/${encodeURIComponent("a!~*'()-_.b")}/insights`, // the rest of the encodeURIComponent alphabet
  ]) {
    assert.equal(
      buildUrl('graph.instagram.com', path),
      `https://graph.instagram.com/${GRAPH_VERSION}${path}`,
      `${path}: passed through unchanged`,
    );
  }
});

/*
 * CC-DATA-17: the two inputs that used to escape `buildUrl` as something other
 * than an `InstagramError`, or as one that named the wrong culprit.
 *
 * (2) An allowlisted host in a spelling other than its allowlist literal.
 * `assertAllowedHost` trims and lower-cases for the comparison — a pinned
 * tolerance, exercised above — but `buildUrl` interpolates the caller's RAW
 * spelling. Measured before the guard: `' graph.instagram.com '` passed the
 * gate and then blew up inside `assertPinnedGraphPath` as a raw
 * `TypeError: Invalid URL`; `'\tgraph.instagram.com'` and
 * `'GRAPH.instagram.com'` were refused as `InstagramError`s, but by the
 * parse-survival check, whose message says the PATH did not survive parsing.
 * Every such spelling is now refused up front, by a message that names the
 * host and the actual defect. The host is echoed verbatim — the gate has
 * already established that, normalised, it is one of the two literals, so the
 * echo can never carry anything the operator did not approve.
 */
test('buildUrl refuses an allowlisted host in any spelling other than its exact literal (CC-DATA-17)', () => {
  for (const host of [
    ' graph.instagram.com ',
    'graph.instagram.com ',
    ' graph.instagram.com',
    '\tgraph.instagram.com',
    'GRAPH.instagram.com',
    'Graph.Facebook.com',
    ' graph.facebook.com ',
  ]) {
    // First, the premise: `assertAllowedHost` still recognises the spelling.
    // Were it refused there, this test would be pinning the wrong layer.
    assert.equal(refusalFor(host), undefined, `"${host}" is still tolerated by the gate itself`);

    let caught: unknown;
    try {
      buildUrl(host as GraphHost, '/me', { fields: 'id', access_token: 'SECRET_TOKEN' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof InstagramError, `"${host}": a raw TypeError must not escape`);
    assert.equal(
      caught.message,
      `Refusing request: host "${host}" is allowlisted only once trimmed and lower-cased and cannot be interpolated into a URL as written`,
      `"${host}": the refusal names the host and the spelling defect, not the path`,
    );
    assert.equal(caught.kind, 'validation', `"${host}": refused as a validation error`);
    assert.equal(caught.message.includes('SECRET_TOKEN'), false, `"${host}": no param echoed`);
  }
});

/*
 * The other side of the same guard: it must be an exact-spelling test and
 * nothing more. Both canonical literals still build the same URL they always
 * did, byte for byte, so the guard cannot have narrowed the accepted set.
 */
test('the exact-spelling guard leaves both canonical host literals untouched', () => {
  assert.equal(
    buildUrl('graph.instagram.com', '/me'),
    `https://graph.instagram.com/${GRAPH_VERSION}/me`,
  );
  assert.equal(
    buildUrl('graph.facebook.com', '/me'),
    `https://graph.facebook.com/${GRAPH_VERSION}/me`,
  );
  for (const host of ALLOWED_HOSTS) {
    assert.equal(buildUrl(host, ''), `https://${host}/${GRAPH_VERSION}`, `${host}: the bare base`);
  }
});

/*
 * (1) A `path` with no string form. The `string` annotation is erased before
 * the call runs; a `null`-prototype object reached the template literal and
 * threw the raw `TypeError: Cannot convert object to primitive value`, and a
 * symbol its own raw TypeError. Same fix shape as CC-DATA-14 for param values:
 * the conversion alone is wrapped, the refusal names the argument, and the
 * value is never echoed (it is untrusted input, and the throwing-`toString`
 * case shows how a caller-controlled message could otherwise ride along).
 */
test('buildUrl refuses a path with no string form instead of leaking a TypeError (CC-DATA-17)', () => {
  const throwingToString = {
    toString(): string {
      throw new Error('LEAKED_TOKEN_ab12');
    },
  };
  for (const [label, path] of [
    ['null-prototype object', Object.create(null) as unknown],
    ['symbol', Symbol('media-id')],
    ['throwing toString', throwingToString],
  ] as const) {
    let caught: unknown;
    try {
      buildUrl('graph.instagram.com', path as string, {
        fields: 'id',
        access_token: 'SECRET_TOKEN',
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof InstagramError, `${label}: a raw TypeError must not escape`);
    assert.equal(
      caught.message,
      'Refusing request: the request path cannot be converted to a string',
      `${label}: the refusal names the argument and nothing else`,
    );
    assert.equal(caught.kind, 'validation', `${label}: refused as a validation error`);
    assert.equal(caught.message.includes('LEAKED_TOKEN_ab12'), false, `${label}: no borrowed text`);
    assert.equal(caught.message.includes('SECRET_TOKEN'), false, `${label}: no param echoed`);
  }
});

/*
 * The boundary this guard must not cross, mirroring the CC-DATA-14 one for
 * params: it refuses values with NO string form, not non-strings in general. A
 * one-element array spells its element and a number its digits; both go on to
 * the path invariant and are judged there on what they spell, exactly as before
 * the guard existed. Widening this into "refuse anything that is not a string"
 * would be a different policy — and one no test on the invariant asked for.
 */
/**
 * Pin the three `buildUrl` refusals that are still matched by a fragment.
 *
 * Four of this module's six refusals are already asserted by whole-string
 * equality — both host refusals, the spelling-defect one and the unstringifiable
 * `path` one. The remaining three are matched by `/did not survive URL parsing/`,
 * by `new RegExp('pinned /v25.0 version prefix')` and, for the param guard, by
 * the interpolated key alone (`/"after"/`, `/"since"/`). Each of those patterns
 * owns the clause that names the invariant and leaves the rest of the sentence
 * free — and the rest of the sentence is the half that tells whoever reads the
 * error what to do about it.
 *
 * That matters more here than in most modules, because these refusals have two
 * audiences and neither gets a second line. They travel out as `validation`
 * `InstagramError`s, so the model sees one rendered error text and the operator
 * sees one log line; nothing downstream re-explains them. The URL-parsing
 * refusal in particular carries the only list anywhere of the three characters
 * that cause it (`#`, `?`, a `.` segment) — delete that half and the reader is
 * told an id "did not survive URL parsing" with no way to guess which character
 * in it was the problem. The param refusal is the mirror image: its fragment
 * assertions own the key and nothing else, so the sentence around the key could
 * say anything at all, including something that echoes the value — which the
 * neighbouring assertions exist precisely to forbid.
 *
 * The fragment assertions above stay as they are. They are grouped by defect
 * class — fragment injection, smuggled query string, in-place rewrite — and
 * each one's job is to prove which guard fired for a given path. This test owns
 * the wording, once.
 */
test('every buildUrl refusal that is only fragment-matched is pinned by its whole sentence', () => {
  const parsing = pathRefusalFor('/X#injected');
  assert.equal(
    parsing?.message,
    'Refusing request: the request path did not survive URL parsing unchanged — an unencoded "#", "?" or "." segment in an interpolated id restructures the URL',
  );

  const prefix = pathRefusalFor('/../me');
  assert.equal(
    prefix?.message,
    `Refusing request: the request path escaped the pinned /${GRAPH_VERSION} version prefix`,
  );

  // Built from the module constant rather than written out, so the day the pin
  // moves this test moves with it instead of failing on the version alone.
  assert.equal(
    prefix?.message.includes(GRAPH_VERSION),
    true,
    'the version pin names the version it is pinned to',
  );

  const noPrimitive = Object.create(null) as unknown;
  const param = paramRefusalFor({ after: noPrimitive });
  assert.equal(
    param.message,
    'Refusing request: the value of query parameter "after" cannot be converted to a string',
  );

  // All three open with the same three words. That is deliberate — it is how an
  // operator greps for "this module refused to build a URL" across a log — so it
  // is asserted rather than left to coincidence.
  for (const message of [parsing?.message, prefix?.message, param.message]) {
    assert.equal(
      message?.startsWith('Refusing request'),
      true,
      `every buildUrl refusal opens with the same three words, got: ${String(message)}`,
    );
  }
});

test('the string-form guard still hands a stringifiable non-string path to the path invariant', () => {
  assert.equal(
    buildUrl('graph.instagram.com', ['/me'] as unknown as string),
    `https://graph.instagram.com/${GRAPH_VERSION}/me`,
    'a one-element array spells its element and builds',
  );
  // A number spells its digits, which glue onto the version — so it is the
  // path INVARIANT that refuses it, by the version-pin message, not this guard.
  const err = pathRefusalFor(42 as unknown as string);
  assert.match(
    err?.message ?? '',
    new RegExp(`pinned /${GRAPH_VERSION} version prefix`),
    'a number reaches the invariant and is refused there, on what it spells',
  );
});
