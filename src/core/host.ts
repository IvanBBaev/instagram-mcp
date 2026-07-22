/**
 * SSRF host allowlist, version pin, and URL builder (Layer 0). Pure — no
 * network, no clock. The single gate every outgoing Graph URL passes through
 * (docs/security.md §3, docs/architecture.md §5).
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
 */
export const ALLOWED_HOSTS: readonly GraphHost[] = ['graph.instagram.com', 'graph.facebook.com'];

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
  const colons = (h.match(/:/g) ?? []).length;
  if (colons === 1) {
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

/** Query-string param values `buildUrl` accepts. `undefined` values are skipped. */
export type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * Build a pinned, allowlisted Graph URL: `https://<host>/v25.0<path>?<query>`.
 * `path` already carries its leading slash and no host (per
 * {@link import('./types.js').IgRequestOptions}.path). `undefined` params are
 * skipped; keys and values are URL-encoded; booleans/numbers are stringified.
 */
export function buildUrl(host: GraphHost, path: string, params?: QueryParams): string {
  assertAllowedHost(host); // defense-in-depth: never emit an off-allowlist URL.
  const base = `https://${host}/${GRAPH_VERSION}${path}`;
  if (!params) return base;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.append(key, String(value));
  }
  const qs = search.toString();
  return qs === '' ? base : `${base}?${qs}`;
}
