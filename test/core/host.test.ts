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
 * this is the difference between an allowlist and a suggestion.
 */
test('the allowlist is an exact match — never a prefix, suffix, or substring', () => {
  for (const host of [
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
