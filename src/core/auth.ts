/**
 * Auth providers (Layer 0). An {@link AuthProvider} contributes the auth query
 * params for one outgoing Graph call. Two paths, per docs/auth.md §1:
 *
 *  - `ig-login`  → host `graph.instagram.com`; params are `{ access_token }`.
 *    `appsecret_proof` is **not supported** on graph.instagram.com and is never
 *    added (docs/auth.md §1 Path A).
 *  - `fb-login`  → host `graph.facebook.com`; params are `{ access_token,
 *    appsecret_proof, appsecret_time }`, the TIME-BOUND proof (CC-AUTH-15):
 *    `appsecret_time` is the call's unix time in whole seconds and
 *    `appsecret_proof = HMAC-SHA256(key = app_secret, access_token + '|' +
 *    appsecret_time)` hex-encoded (docs/auth.md §1 Path B, docs/security.md §5).
 *
 * The `appsecret_proof` is contributed **only when the target host is
 * graph.facebook.com** — the interface takes the host precisely so the rule is
 * host-driven, not path-driven (an fb-login token addressing graph.instagram.com
 * still omits it). Providers are deterministic over (profile, clock): the
 * proof is minted per call from the injected clock's `now()`.
 *
 * Why per call, not once (CC-AUTH-15). Until 2026-09-30 the proof was the
 * plain `HMAC(access_token, app_secret)`, computed once at construction — static
 * for the token's whole lifetime, so anyone who observed one outgoing query
 * string (a proxy log, a crash dump, a pasted URL) held a proof that replayed
 * for as long as the token lived. Graph's time-bound form signs
 * `access_token|appsecret_time` and refuses a stale `appsecret_time`, which
 * bounds that replay window to Meta's tolerance rather than to the token's
 * 60 days. It costs one query parameter and one HMAC per call.
 */
import { createHmac } from 'node:crypto';
import { systemClock } from './clock.js';
import type { Clock } from './clock.js';
import { envVarFor } from './config.js';
import { InstagramError } from './types.js';
import type { AuthProvider, GraphHost, ResolvedProfile } from './types.js';

const IG_HOST: GraphHost = 'graph.instagram.com';
const FB_HOST: GraphHost = 'graph.facebook.com';

/**
 * Compute the hex-encoded time-bound `appsecret_proof` for a (token, secret,
 * time) triple: the HMAC key is the app secret and the message is the token and
 * the `appsecret_time` joined by `|` (CC-AUTH-15).
 */
function appsecretProof(accessToken: string, appSecret: string, time: string): string {
  return createHmac('sha256', appSecret).update(`${accessToken}|${time}`).digest('hex');
}

/**
 * Build the {@link AuthProvider} for a resolved account profile.
 *
 * `clock` supplies the `appsecret_time` of each Path B call (CC-AUTH-15); the
 * composition root hands in its own clock so a substituted one reaches the
 * signing path too.
 *
 * @throws {InstagramError} `kind: 'validation'` when an `fb-login` profile has
 *   no usable `appSecret` — absent, or blank once trimmed. The proof cannot be
 *   computed, so the profile is unusable; the message names the env var to set.
 */
export function createAuthProvider(
  profile: ResolvedProfile,
  clock: Pick<Clock, 'now'> = systemClock,
): AuthProvider {
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
      if (host === FB_HOST) {
        // Minted per call, from this call's instant (CC-AUTH-15). Whole seconds,
        // floored: Graph reads `appsecret_time` as a unix timestamp, and a
        // fractional or millisecond value is not one. The SAME string is both
        // signed and sent — a second `now()` read could straddle a second
        // boundary and sign a time the request does not carry.
        const time = String(Math.floor(clock.now() / 1000));
        params.appsecret_proof = appsecretProof(accessToken, appSecret, time);
        params.appsecret_time = time;
      }
      // Equivalent-mutant note: resolving `{ ...params }` instead is unobservable
      // — `params` is a flat local record nothing else holds a reference to, so a
      // copy carries the same keys and values with equally fresh identity.
      return Promise.resolve(params);
    },
  };
}
