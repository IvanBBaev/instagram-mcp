/**
 * `refresh` CLI command (Layer: cli), split out of `src/index.ts`
 * (docs/v2-analysis.md §6): exchange the active profile's long-lived token for a
 * fresh one, persist it to the profile's env file and report where it went on
 * stderr. The composition root resolves the profile and injects the clock;
 * this module owns the order of mint → register → persist (F-4).
 */
import { refreshToken } from '../core/refresh.js';
import { registerSecret } from '../core/redact.js';
import { writeCredentials } from '../core/config-write.js';
import { expiryLabel } from '../core/time.js';
import type { ResolvedProfile } from '../core/types.js';

export interface RefreshDeps {
  profile: ResolvedProfile;
  /** Wall-clock milliseconds, from the entry's clock. */
  nowMs: number;
}

/** Run `refresh`; resolves to the process exit code. A failure rejects. */
export async function runRefresh(deps: RefreshDeps): Promise<number> {
  const { profile } = deps;
  // No Graph seam here on purpose: the token-exchange endpoints authenticate
  // themselves, and the seam would append `access_token`/`appsecret_proof` on
  // top of that — see the transport note in core/refresh.ts.
  const refreshed = await refreshToken({
    authPath: profile.authPath,
    accessToken: profile.accessToken,
    appId: profile.appId,
    appSecret: profile.appSecret,
    // Equivalent-mutant note: dropping `nowMs` cannot be separated by any
    // input — `core/refresh.ts` defaults it to `Date.now()`, which is what
    // `systemClock.now()` returns, so the only difference is the sub-
    // millisecond gap between the two reads and the rendered expiry is floored
    // to whole seconds. It stays because the composition root is the one place
    // that injects the clock: every other timestamp in a run comes from
    // `clock`, and a `refresh` that quietly read the wall clock instead is how
    // a substituted clock would stop applying to precisely the path that mints
    // credentials.
    nowMs: deps.nowMs,
  });
  // F-4 (docs/security.md §2, core/redact.ts): the exchange has just minted a
  // LIVE long-lived credential, and it is a value the redactor cannot know on
  // sight — a Page token or a rotated secret routinely looks like nothing in
  // particular, and the `EAA…`/`IG…` shape backstop is best-effort only. Until
  // it is registered, every string built from here to process exit carries it
  // in the clear: the persist below (whose fs errors quote the file it was
  // rewriting), any log line added to this path, an unhandled rejection Node
  // prints itself. So it is registered HERE — between the mint and the first
  // thing that can touch it — not after the write, which would leave a failed
  // rotation as the one case where the new token is still unmasked.
  // `createRedactor` reads the registry live, so the logger the entry built starts
  // masking it without being rebuilt.
  //
  // `login` mints at the same point in its own flow and deliberately does NOT
  // register (CC-AUTH-24). `src/index.ts` dispatches it at its `subcommand ===
  // 'login'` branch and exits from there, before the entry's logger exists, so nothing
  // in that process ever builds a redactor for a registration to reach. Its
  // guarantee is local instead: it prints no token at all, and its only
  // unbounded output — `login failed: <message>` — carries a Graph
  // `error.message`, never the request URL or the raw response body, and is
  // passed through a redactor built there from the app secret, the code and
  // every token that run minted.
  registerSecret(refreshed.accessToken);
  const written = await writeCredentials(profile.name, {
    accessToken: refreshed.accessToken,
    authPath: profile.authPath,
    accountId: profile.accountId,
    appId: profile.appId,
    appSecret: profile.appSecret,
    expiresAtSec: refreshed.expiresAtSec,
  });
  process.stderr.write(
    `Refreshed ${profile.authPath} token for profile '${profile.name}' -> ${written.path} ` +
      `(expires: ${expiryLabel(refreshed.expiresAtSec)}).\n`,
  );
  return 0;
}
