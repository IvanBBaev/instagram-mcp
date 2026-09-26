/**
 * The scope contract shared by the two CLIs (Layer: composition root).
 *
 * `login` decides what to *ask* for; `doctor` decides what to *say* about what
 * was granted. Those are the same table read from two directions, and while it
 * lived only inside `login.ts` the second direction did not exist: `doctor`
 * printed the granted scopes and stopped, even though the setup guide and
 * `docs/security.md` both told operators that `doctor` flags over-granted scopes
 * so they can be trimmed. This module is the single table, so the promise the
 * docs make is the promise the code keeps.
 *
 * Scope drift is worth reporting in both directions and for different reasons.
 * A **missing** scope is a tool that will fail later against a token that
 * otherwise works — the permission error surfaces at the first `comments` or
 * `insights` call, long after login, and reads like a Meta outage. An **extra**
 * scope is a standing grant the server never exercises: it widens the blast
 * radius of a leaked token, and on a Business app it drags the whole app into an
 * App Review it does not otherwise need.
 */
import type { AuthPath } from '../core/types.js';

/**
 * Default granular scopes per path (docs/auth.md §1) — the set `login` requests
 * when `--scopes` is not given, and the set `doctor` measures a granted token
 * against.
 *
 * One scope each path *supports* is deliberately absent: the messaging scope
 * (`instagram_business_manage_messages` on Path A, `instagram_manage_messages` on
 * Path B). No tool in `allTools` calls a messaging endpoint and none is planned
 * for v1 — M6 messaging is DEFER (docs/messaging.md) — so requesting it asks the
 * operator to grant a permission the server cannot exercise. That is not free:
 * DM access is the most sensitive thing this consent screen can ask for, and it
 * is on the short list of permissions Meta's reviewers will not approve for an
 * unpublished app (docs/messaging.md §App Review), so carrying it here can fail a
 * review the server does not otherwise need. Nothing is lost by dropping it —
 * `--scopes` still passes any scope through verbatim, so an operator preparing
 * for a messaging build can ask for it explicitly.
 */
export const DEFAULT_SCOPES: Record<AuthPath, readonly string[]> = Object.freeze({
  'ig-login': Object.freeze([
    'instagram_business_basic',
    'instagram_business_content_publish',
    'instagram_business_manage_comments',
    'instagram_business_manage_insights',
  ]),
  'fb-login': Object.freeze([
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_comments',
    'instagram_manage_insights',
    'pages_show_list',
    'pages_read_engagement',
    'business_management',
  ]),
});

/**
 * Scopes Facebook Login attaches to every token whether or not the app asked for
 * them. Reporting these as over-granted would be noise on every single Path B
 * run, and noise on every run is how a real finding gets ignored — so they are
 * excluded by name, with the reason recorded, rather than by a pattern that
 * might also swallow something that matters.
 *
 * A frozen array rather than the frozen `ReadonlySet` this was until 2026-09-23.
 * The list SUPPRESSES findings, so widening it at runtime is the quiet way to
 * make a real over-grant invisible — push a scope here and `doctor` stops
 * reporting a token that carries it. `Object.freeze` cannot defend that on a
 * `Set`: a Set's members live in internal slots rather than own properties, so
 * `.add()` on a frozen Set succeeds silently, and does so even under strict mode
 * (measured 2026-09-23 — no throw, member added). The guard read like the one
 * `ALLOWED_HOSTS` carries and was decoration. On a frozen array the cast that
 * gets past `readonly` throws, which is the same guarantee `core/host.ts` makes
 * for the SSRF allowlist and for the same reason.
 */
export const ALWAYS_GRANTED_SCOPES: readonly string[] = Object.freeze(['public_profile']);

/** What a granted scope set is missing, and what it carries beyond the need. */
export interface ScopeDrift {
  /** Requested-by-default scopes the token does not carry. */
  readonly missing: readonly string[];
  /** Scopes the token carries that this server never exercises. */
  readonly extra: readonly string[];
}

/**
 * Compare a token's granted scopes against what the path actually needs.
 *
 * Both lists come back sorted so the rendered output is stable run to run —
 * `debug_token` does not promise an order, and an operator diffing two `doctor`
 * runs should see a change only when the grant changed.
 *
 * @param path    The auth path the profile uses; it selects the expected set.
 * @param granted Scopes reported by `debug_token`, in whatever order it used.
 */
export function classifyScopes(path: AuthPath, granted: readonly string[]): ScopeDrift {
  const expected = new Set(DEFAULT_SCOPES[path]);
  const held = new Set(granted);
  return {
    missing: [...expected].filter((scope) => !held.has(scope)).sort(),
    extra: [...held]
      .filter((scope) => !expected.has(scope) && !ALWAYS_GRANTED_SCOPES.includes(scope))
      .sort(),
  };
}
