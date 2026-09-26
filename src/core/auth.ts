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
import { envVarFor } from './config.js';
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
 *   no usable `appSecret` — absent, or blank once trimmed. The proof cannot be
 *   computed, so the profile is unusable; the message names the env var to set.
 */
export function createAuthProvider(profile: ResolvedProfile): AuthProvider {
  const { authPath, accessToken } = profile;

  if (authPath === 'ig-login') {
    return {
      // Equivalent-mutant note: `path: profile.authPath` is indistinguishable
      // from this literal. The branch is only entered when the destructured
      // `authPath` is 'ig-login', both read the same never-mutated profile, and
      // the property is evaluated eagerly here — no observable field differs.
      path: 'ig-login',
      defaultHost: IG_HOST,
      // graph.instagram.com carries the bare token only (docs/auth.md §1 Path A).
      authParams: () => Promise.resolve({ access_token: accessToken }),
    };
  }

  // fb-login: the app secret is mandatory to mint appsecret_proof.
  // Equivalent-mutant note: defaulting this to `?? ''` changes nothing — the
  // empty string is blank after trimming, so the guard below still throws the
  // identical error for a missing secret.
  const appSecret = profile.appSecret;
  // A blank-but-present secret is REJECTED, never trimmed into shape. Trimming
  // would sign with a value the operator never configured, and the resulting
  // proof is indistinguishable from a correct one until Graph rejects it
  // server-side. Note the secret is deliberately used VERBATIM below: `config.ts`
  // and `cli/login.ts` already trim every profile field on the way in, so a
  // whitespace-only secret reaching here means the config layer was bypassed —
  // exactly the case a second, silent repair would hide.
  if (appSecret === undefined || appSecret.trim() === '') {
    throw new InstagramError(
      `fb-login profile "${profile.name}" requires an app secret to compute appsecret_proof; ` +
        `set ${envVarFor(profile.name, 'APP_SECRET')} to the Meta app secret.`,
      { kind: 'validation' },
    );
  }
  // Equivalent-mutant note: moving this call inside `authParams` is unobservable
  // — `appsecretProof` is pure over two `const` captures, so every call would
  // return this exact digest. Only the wasted work per request differs, and no
  // assertion on the returned params can see that.
  const proof = appsecretProof(accessToken, appSecret);

  return {
    path: 'fb-login',
    defaultHost: FB_HOST,
    // appsecret_proof only on graph.facebook.com (docs/auth.md §1, security.md §5).
    authParams: (host: GraphHost): Promise<Record<string, string>> => {
      const params: Record<string, string> = { access_token: accessToken };
      // Equivalent-mutant note: `host !== IG_HOST` survives the suite, but not for
      // the reason the spelling suggests. `GraphHost` is erased before this line
      // runs, this provider is exported, and `http.ts` hands `authParams` the
      // caller's RAW host spelling after `assertAllowedHost` has compared only a
      // trimmed, lower-cased copy — so `' graph.instagram.com '` already separates
      // the two, with no third host required: `!==` would attach the proof to an
      // Instagram target. Nothing reaches the wire, because `buildUrl` re-tests
      // that exact spelling against the allowlist (CC-DATA-17 (2)) and throws
      // first. THAT guard, not the arity of the type, is what makes the mutant
      // unobservable. `===` stays because the proof belongs to
      // graph.facebook.com, not to "anything that is not Instagram".
      if (host === FB_HOST) params.appsecret_proof = proof;
      // Equivalent-mutant note: resolving `{ ...params }` instead is unobservable
      // — `params` is a flat local record nothing else holds a reference to, so a
      // copy carries the same keys and values with equally fresh identity.
      return Promise.resolve(params);
    },
  };
}
