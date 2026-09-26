/**
 * SSRF host allowlist, version pin, and URL builder (Layer 0). Pure — no
 * network, no clock. The single gate every **server-issued Graph request**
 * passes through: `core/http.ts` routes every tool call through
 * {@link assertAllowedHost} + {@link buildUrl}, and `core/refresh.ts` routes the
 * token exchange through {@link buildUrl}. No path from a model-supplied
 * argument to a socket bypasses it (docs/security.md §3, docs/architecture.md §5).
 *
 * SCOPE, stated exactly — the older wording ("every outgoing Graph URL") was not
 * true. The `login` CLI (`src/cli/login.ts`) is deliberately outside this gate.
 * It assembles the OAuth endpoints itself: `www.instagram.com`,
 * `api.instagram.com` and `www.facebook.com` are OAuth hosts, not Graph hosts,
 * and are intentionally absent from the allowlist below; the two token exchanges
 * it also runs against `graph.instagram.com` / `graph.facebook.com` are built
 * from the same module-level literals. Every one of those URLs has a host that
 * is a compile-time constant — no operator or model value reaches it — so there
 * is nothing for a host allowlist to decide, and a second allowlist for constant
 * URLs would be ceremony rather than safety. The literals are pinned directly in
 * `test/cli/login.test.ts` instead, which is what actually stops them from being
 * repointed.
 *
 * Policy: only the two Graph hosts are reachable in v1. `rupload.facebook.com`
 * is intentionally absent — it joins the list only when a resumable-upload phase
 * ships, so there are no dead allowlist entries. No user-supplied hosts, no
 * cross-host redirects, loopback/private/link-local ranges always refused.
 */
import { InstagramError } from './types.js';
import type { GraphHost } from './types.js';

/**
 * Pinned Graph API version — carried in EVERY URL, both hosts. A versionless
 * call is never issued. Bumping this is a deliberate, changelog-reviewed PR
 * (docs/operations.md §5).
 */
export const GRAPH_VERSION = 'v25.0';

/**
 * The SSRF allowlist (v1). `rupload.facebook.com` is deliberately NOT here —
 * no dead entries until a resumable-upload phase needs it (architecture §5).
 *
 * Frozen, not merely `readonly`: `readonly` is erased at compile time, so any
 * importing module could cast the annotation away and `push` a host onto the
 * live array, widening the process-wide allowlist for every subsequent call.
 * `Object.freeze` makes the guarantee hold at runtime, where the attack is.
 */
export const ALLOWED_HOSTS: readonly GraphHost[] = Object.freeze([
  'graph.instagram.com',
  'graph.facebook.com',
]);

/**
 * Strip an IPv6 bracket wrapper or an IPv4/hostname `:port` suffix so the range
 * checks below see a bare address. Bracketless IPv6 (2+ colons) is kept intact.
 */
function bareHost(host: string): string {
  let h = host;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h.slice(1) : h.slice(1, end);
  }
  // A single colon is a port separator on an IPv4/hostname; 2+ colons is IPv6.
  // Equivalent-mutant note: the nullish fallback on the next line may be written
  // as a logical-or fallback with identical behaviour — a global match yields
  // either null or a non-empty (truthy) array, so the two never diverge.
  const colons = (h.match(/:/g) ?? []).length;
  if (colons === 1) {
    // Equivalent-mutant note: a first-index and a last-index search for the
    // separator coincide here — this branch runs only when there is exactly one.
    h = h.slice(0, h.indexOf(':'));
  }
  return h;
}

/**
 * Recognize loopback / private / link-local targets even if smuggled in.
 * Redundant with the exact-match allowlist below (neither Graph host is
 * private), but kept as explicit defense-in-depth with a clear SSRF message.
 */
function isPrivateOrLoopback(host: string): boolean {
  const h = bareHost(host);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  // IPv4 loopback / private / link-local ranges.
  if (/^127\./.test(h)) return true; // 127.0.0.0/8   loopback
  if (/^10\./.test(h)) return true; // 10.0.0.0/8    private
  if (/^192\.168\./.test(h)) return true; // 192.168.0.0/16 private
  if (/^169\.254\./.test(h)) return true; // 169.254.0.0/16 link-local
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true; // 172.16.0.0/12 private
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  // Equivalent-mutant note: both patterns below are lower-case only THROUGHOUT —
  // the `f`/`fe` literals just as much as the `[cd]`, `[89ab]` and `[0-9a-f]`
  // classes. The sole caller lower-cases the host before this function sees it,
  // so widening any of them to also accept upper-case hex is unobservable
  // (measured, for the literals as well as the classes).
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

/**
 * Assert `host` is on the SSRF allowlist, narrowing it to {@link GraphHost}.
 * Throws `InstagramError({ kind: 'validation' })` for anything else — including
 * loopback/private/link-local hosts — before any socket is opened.
 */
export function assertAllowedHost(host: string): asserts host is GraphHost {
  const normalized = host.trim().toLowerCase();
  if (isPrivateOrLoopback(normalized)) {
    throw new InstagramError(
      `Refusing request to non-allowlisted host "${host}" (loopback/private address)`,
      { kind: 'validation' },
    );
  }
  if (!(ALLOWED_HOSTS as readonly string[]).includes(normalized)) {
    throw new InstagramError(`Refusing request to non-allowlisted host "${host}"`, {
      kind: 'validation',
    });
  }
}

/**
 * Query-string param values `buildUrl` accepts. A value of `undefined` — or, at
 * runtime, `null` — means "no such parameter" and is skipped, never serialized.
 *
 * This annotation is a statement of INTENT, not a guarantee, and the difference
 * is load-bearing: the check inside {@link buildUrl} is what actually holds.
 * Nothing validates a params object at runtime. `core/http.ts` spreads
 * `opts.params` into the object it passes here, and the api layer fills those
 * params from Graph response bodies that `req` merely CASTS to a shape — a
 * `paging.cursors.after` typed `string | undefined` is whatever Meta put in the
 * JSON. This package also ships `.d.ts` files rather than enforcement, so a
 * JavaScript caller is bound by nothing at all. `null` is therefore listed here
 * as excluded and handled below as reachable, which is the honest reading of
 * both facts.
 */
export type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * Result invariant for {@link buildUrl}: the URL it just assembled must still be
 * the URL its contract promises. `path` is concatenated raw — deliberately, so a
 * caller can compose multi-segment paths — which leaves every api function
 * responsible for `encodeURIComponent`-ing the ids IT interpolates (CC-PROC-7).
 * This is the backstop for the one that forgets: an id is a model-supplied value,
 * and a structural character surviving into `path` changes what the assembled
 * string MEANS, silently and on the wire.
 *
 * The three ways `path` can restructure the URL:
 *
 *   - a fragment: an unencoded `#` pushes the whole query — `access_token`
 *     included — behind the `#`, and fetch does not send a fragment, so the
 *     request leaves this process UNAUTHENTICATED;
 *   - a query: an unencoded `?` opens the query string early, so caller-chosen
 *     parameters land AHEAD of the auth parameters `core/http.ts` appends;
 *   - a pathname outside `/<GRAPH_VERSION>`: the parser resolves dot segments, so
 *     `/v25.0/../me` collapses to `/me` and the version pin silently disappears.
 *
 * Checked with the same WHATWG parser `fetch` will use, on the BASE — before any
 * query string is appended, because at that point anything but a pathname can only
 * have come from `path`. Checking the base is equivalent to checking the finished
 * URL: the query `buildUrl` appends is `URLSearchParams` output, whose alphabet
 * (`A-Za-z0-9*-._+%=&`) contains neither `#` nor a second `?`, so it can add no
 * fragment, cannot move the pathname, and lands whole in `search`.
 *
 * The first two are NOT checked as `hash !== ''` / `search !== ''`: the parser
 * reports both as `''` when the component is EMPTY, so a `path` ending in a bare
 * `#` would pass — and then `buildUrl` appends `?fields=…&access_token=…` straight
 * behind that `#`, which is the very leak this guard exists to stop. What is
 * checked instead is that the base survived parsing unchanged, `origin + pathname`
 * reassembling the exact input string. That single comparison subsumes all three
 * consequences (a `#` or `?` in any position truncates `pathname`; a dot segment
 * moves it) and additionally catches every character the parser would rewrite on
 * its own — a raw space, a backslash, a control character. Percent-encoded ids are
 * untouched by the parser and compare equal, so correctly encoded call sites pass.
 *
 * Deliberately a CHECK, never a repair. It encodes, rewrites and normalises
 * nothing, so it cannot double-encode a path an api function already encoded
 * correctly. A caller that trips it has a bug in its own path template, and
 * refusing is the only safe answer — a "repaired" URL would address something the
 * caller never asked for.
 *
 * The message never echoes the path, for the same reason `api/discovery.ts` never
 * echoes a rejected handle: that string is untrusted model input, error text ends
 * up in logs and back in model context, and the likeliest way to reach this code
 * is a caller pasting a value — an access token included — where an id belongs.
 * Which invariant broke is stated instead, which is what a maintainer needs.
 */
function assertPinnedGraphPath(base: string): void {
  const parsed = new URL(base);
  // Checked first so a traversal, whose whole point is leaving the prefix, is
  // reported as the prefix escape it is rather than as a generic rewrite. The
  // trailing "/" is appended to the pathname so the version-only base (an empty
  // `path`) passes the same single prefix test as `/v25.0/<segment>`, while
  // `/v25.0extra` — a `path` that forgot its leading slash — still fails.
  if (!`${parsed.pathname}/`.startsWith(`/${GRAPH_VERSION}/`)) {
    throw new InstagramError(
      `Refusing request: the request path escaped the pinned /${GRAPH_VERSION} version prefix`,
      { kind: 'validation' },
    );
  }
  if (`${parsed.origin}${parsed.pathname}` !== base) {
    throw new InstagramError(
      'Refusing request: the request path did not survive URL parsing unchanged — an unencoded "#", "?" or "." segment in an interpolated id restructures the URL',
      { kind: 'validation' },
    );
  }
}

/**
 * Build a pinned, allowlisted Graph URL: `https://<host>/v25.0<path>?<query>`.
 * `path` already carries its leading slash and no host (per
 * {@link import('./types.js').IgRequestOptions}.path). Nullish params
 * (`undefined`, `null`) are skipped; keys and values are URL-encoded;
 * booleans/numbers are stringified.
 *
 * The assembled base is put through {@link assertPinnedGraphPath} before any
 * query is appended: a `path` that would change the URL's structure is refused,
 * never repaired. Two refusals precede the assembly itself (CC-DATA-17): an
 * allowlisted host in any spelling other than its exact allowlist literal, and a
 * `path` with no string form. Both are `InstagramError({ kind: 'validation' })`,
 * which makes that the ONLY error shape this function throws.
 *
 * The nullish skip is the only value-level guard that DROPS a parameter, and
 * deliberately so (the string-form refusal below is a refusal, not a drop). A
 * `number` that is `NaN`, `Infinity`, or large enough to print in exponent form
 * (`1e+21` — reachable, since the `since`/`until` tool inputs are unbounded
 * `z.number().int()`) is type-legal and is stringified exactly as written. Those
 * are not dropped, because unlike a nullish value they are not a statement of
 * absence: deleting a parameter the caller explicitly passed would turn a
 * caller-side bug into a request that quietly asks something else and succeeds.
 * Graph answers a malformed `since` with a 400 that names the parameter, which
 * is the diagnosis; an omitted `since` is a different, plausible, wrong answer.
 */
export function buildUrl(host: GraphHost, path: string, params?: QueryParams): string {
  assertAllowedHost(host); // defense-in-depth: never emit an off-allowlist URL.
  // CC-DATA-17 (2) — the host is on the allowlist, but only after
  // `assertAllowedHost` trimmed and lower-cased it for the comparison; what gets
  // interpolated below is the caller's raw spelling. A padded
  // `' graph.instagram.com '` therefore passed the gate and then reached
  // `new URL` in `assertPinnedGraphPath`, which threw a raw `TypeError: Invalid
  // URL` — the one failure in this module that was not an `InstagramError`.
  // Measured before this guard: a space-padded host escaped as that TypeError;
  // a tab-padded or upper-cased host was refused as an `InstagramError`, but by
  // the parse-survival check below, whose message blames the PATH for a defect
  // in the host. Both fail closed (nothing reached the wire); what was wrong was
  // the shape and the wording of the failure.
  //
  // The exact-spelling test is made HERE rather than by dropping the trim in
  // `assertAllowedHost`, because that tolerance is a pinned contract of the
  // assertion (a padded host is still recognised as allowlisted, and refused
  // as nothing else). This guard only decides what may be interpolated: an
  // allowlisted host in a spelling the URL parser would mangle is refused,
  // with the host echoed verbatim — safe here precisely because the gate above
  // has already established that, trimmed and lower-cased, it is one of the two
  // allowlist literals. The canonical spellings pass untouched, and no in-repo
  // call site can reach this line: `core/http.ts` and `core/refresh.ts` take
  // the host from the module constants in `core/auth.ts`.
  if (!(ALLOWED_HOSTS as readonly string[]).includes(host)) {
    throw new InstagramError(
      `Refusing request: host "${host}" is allowlisted only once trimmed and lower-cased and cannot be interpolated into a URL as written`,
      { kind: 'validation' },
    );
  }
  // CC-DATA-17 (1) — the same implicit ToString as CC-DATA-14 below, one line
  // earlier: `path` is declared `string`, but the declaration is erased before
  // this runs and a JavaScript caller is bound by nothing. A `null`-prototype
  // object here threw the identical raw `TypeError: Cannot convert object to
  // primitive value` out of the template literal, and a symbol its own. Only the
  // conversion is wrapped: an input WITH a usable string form (a one-element
  // array stringifies to its element, a number to its digits) goes on to the
  // path invariant exactly as before, and is accepted or refused there on what
  // it spells — this guard never widens or narrows that set. The message names
  // the argument and never echoes it, for the reason the path invariant's
  // messages do not: a value that reaches here is untrusted input.
  let pathText: string;
  try {
    pathText = `${path}`;
  } catch {
    throw new InstagramError('Refusing request: the request path cannot be converted to a string', {
      kind: 'validation',
    });
  }
  const base = `https://${host}/${GRAPH_VERSION}${pathText}`;
  assertPinnedGraphPath(base); // defense-in-depth: never emit a restructured URL.
  if (!params) return base;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // Absent, not empty: both nullish values mean "there is no such parameter",
    // and neither has a spelling on the wire. `null` is checked even though
    // {@link QueryParams} excludes it — that annotation is erased before this
    // line runs and nothing validates what arrives (CC-DATA-10). `api/media.ts`
    // carries `paging.cursors.after` forward as the next cursor, Graph may
    // serialize that key as JSON `null`, and `String(null)` then put the four
    // characters `null` on the wire: `…/999/media?fields=id&after=null`, a
    // request for the page after a cursor that does not exist. Whether a null
    // cursor should END a pagination walk is a separate question, owned by the
    // api layer; this line decides only what a value that already reached URL
    // construction may become, and "null" is not an answer. No cast is involved:
    // TypeScript permits `=== null` against a type that excludes it (TS2367 is
    // reserved for comparisons like `'a' === 'b'`), so a boundary can defend
    // itself here without weakening the declaration it defends.
    //
    // Nullish, never falsy — `0`, `false` and `''` are values a caller chose (a
    // zero offset, an explicit opt-out, a cleared filter), and dropping one
    // would silently issue a different request than the one asked for.
    //
    // Equivalent-mutant note: the pair may be written as the single loose
    // `value == null`, which is defined as exactly this test, so no test can
    // tell the spellings apart. The explicit form names both values it skips.
    if (value === undefined || value === null) continue;
    // CC-DATA-14 — the one input that used to leave this module as something
    // other than an `InstagramError` of kind `validation`. `String(value)` is a
    // ToString on a caller-controlled value, and ToString is not total: an
    // object with a `null` prototype inherits neither `toString` nor `valueOf`,
    // so the conversion threw a raw `TypeError: Cannot convert object to
    // primitive value` and that TypeError escaped `buildUrl` as itself. Nothing
    // above makes it unreachable — `QueryParams` is erased before this line runs
    // and the same unvalidated-Graph-body path that delivers a `null` cursor
    // (CC-DATA-10) delivers whatever else Meta put in the JSON.
    //
    // It REFUSES, for the reason the path invariant above refuses: a value with
    // no string form has no query spelling to invent, and coercing one — or
    // quietly dropping the parameter — would issue a request nobody asked for.
    // Only the error's SHAPE changes here, never the outcome: this request was
    // not going to be sent either way. That is also the honest measure of the
    // fix — it makes the module keep the contract its own doc comment already
    // states, rather than closing a live hole.
    //
    // The catch is deliberately wider than the `null`-prototype case that
    // motivated it: a `toString` that throws is the caller's own code raising,
    // and its exception escaped just as raw. Both mean the same thing here.
    //
    // The message names the KEY and never the value. The key is exactly what a
    // caller staring at "cannot convert object to primitive value" cannot
    // recover; the value is caller-controlled text this project treats as
    // potentially secret-bearing, the same rule the path refusal follows. The
    // original error is not attached as a `cause` either — a throwing
    // `toString` chooses its own message, and a cause travels into logs.
    let text: string;
    try {
      text = String(value);
    } catch {
      throw new InstagramError(
        `Refusing request: the value of query parameter "${key}" cannot be converted to a string`,
        { kind: 'validation' },
      );
    }
    // Equivalent-mutant note: appending versus overwriting cannot be told apart
    // here — object keys are unique, so no key is ever written twice.
    search.append(key, text);
  }
  const qs = search.toString();
  return qs === '' ? base : `${base}?${qs}`;
}
