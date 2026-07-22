/**
 * Auth providers (Layer 0). An {@link AuthProvider} contributes the auth query
 * params for one outgoing Graph call. Two paths, per docs/auth.md §1:
 *
 *  - `ig-login`  → host `graph.instagram.com`; params are `{ access_token }`.
 *    `appsecret_proof` is **not supported** on graph.instagram.com and is never
 *    added (docs/auth.md §1 Path A).
 *  - `fb-login`  → host `graph.facebook.com`; params are `{ access_token,
 *    appsecret_proof }`, where `appsecret_proof = HMAC-SHA256(access_token,
 *    app_secret)` hex-encoded (docs/auth.md §1 Path B, docs/security.md §5).
 *
 * The `appsecret_proof` is contributed **only when the target host is
 * graph.facebook.com** — the interface takes the host precisely so the rule is
 * host-driven, not path-driven (an fb-login token addressing graph.instagram.com
 * still omits it). Providers are pure/deterministic: a given profile always
 * yields the same params, so the proof is computed once at construction.
 */
import { createHmac } from 'node:crypto';
import { InstagramError } from './types.js';
import type { AuthProvider, GraphHost, ResolvedProfile } from './types.js';

const IG_HOST: GraphHost = 'graph.instagram.com';
const FB_HOST: GraphHost = 'graph.facebook.com';

/** Compute the hex-encoded `appsecret_proof` for a (token, secret) pair. */
function appsecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/**
 * Build the {@link AuthProvider} for a resolved account profile.
 *
 * @throws {InstagramError} `kind: 'validation'` when an `fb-login` profile has
 *   no `appSecret` — the proof cannot be computed, so the profile is unusable.
 */
export function createAuthProvider(profile: ResolvedProfile): AuthProvider {
  const { authPath, accessToken } = profile;

  if (authPath === 'ig-login') {
    return {
      path: 'ig-login',
      defaultHost: IG_HOST,
      // graph.instagram.com carries the bare token only (docs/auth.md §1 Path A).
      authParams: () => Promise.resolve({ access_token: accessToken }),
    };
  }

  // fb-login: the app secret is mandatory to mint appsecret_proof.
  const appSecret = profile.appSecret;
  if (!appSecret) {
    throw new InstagramError(
      `fb-login profile "${profile.name}" requires an app secret to compute appsecret_proof`,
      { kind: 'validation' },
    );
  }
  const proof = appsecretProof(accessToken, appSecret);

  return {
    path: 'fb-login',
    defaultHost: FB_HOST,
    // appsecret_proof only on graph.facebook.com (docs/auth.md §1, security.md §5).
    authParams: (host: GraphHost): Promise<Record<string, string>> => {
      const params: Record<string, string> = { access_token: accessToken };
      if (host === FB_HOST) params.appsecret_proof = proof;
      return Promise.resolve(params);
    },
  };
}
