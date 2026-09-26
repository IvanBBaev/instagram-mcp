/**
 * `account` package tool specs (Layer 3) — read-only profile / token surface.
 * Names, inputs and Graph semantics follow docs/tools.md ("Package `account`");
 * the package tag matches the PACKAGES manifest in docs/architecture.md §4.
 *
 * Tools are data ({@link ToolSpec}); handlers go through the `api/account`
 * layer (never `core/http` directly) and shape a {@link ToolResult} with the
 * `mcp/result` builders. Untrusted, account-controlled free text (username,
 * name, bio, website, IG handle) is wrapped with `fence()` before it reaches
 * the model (docs/security.md §7). InstagramError from the api layer is left to
 * propagate — the registry owns the catch and maps it.
 */
import { z } from 'zod';
import { defineTool, type ToolSpec } from '../mcp/define.js';
import { json, fence } from '../mcp/result.js';
import {
  debugToken,
  getAccount,
  listLinkedAccounts,
  summarizeDataAccessExpiry,
  summarizeTokenExpiry,
} from '../api/account.js';
import { TOKEN_EXPIRES_AT_SUFFIX, envVarFor } from '../core/config.js';
import { InstagramError } from '../core/types.js';

const PACKAGE = 'account';

// `api/account` CASTS the Graph body rather than validating it, so a field typed
// `string | undefined` or `number | undefined` holds "whatever Meta put in the
// JSON". A `null` name reached `fence()` and threw `TypeError: … .split` from
// inside the handler (rendered as an `upstream` Instagram error), and a `null`
// count or URL failed structured-output validation (`MCP error -32602`) — the
// whole profile, or the whole token diagnostic, lost over one field. Every such
// field is `.optional()`, so a value of the wrong type is reported as absent,
// the same rule `tools/discovery` applies to a stranger's profile (CC-PROC-172).

/** Fence an optional untrusted string, leaving anything that is not a string
 * absent so it renders as absent rather than a fenced empty box or a crash. */
function fenceOptional(value: unknown): string | undefined {
  return typeof value === 'string' ? fence(value) : undefined;
}

/** The value when it has the type the output schema declares, else `undefined`. */
function stringOrAbsent(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberOrAbsent(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function booleanOrAbsent(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** A scope list only when it really is a list of strings; other entries drop. */
function scopesOrAbsent(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : undefined;
}

/** A plain object — the only shape a `/me/accounts` row can be read from. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The note published beside `omittedWithoutId` on `/me/accounts`. */
function omittedPagesNote(count: number): string {
  return (
    `omitted ${count} ${count === 1 ? 'item' : 'items'} Instagram returned without a usable id ` +
    '(nothing can address an object with no id), so /me/accounts returned more entries than ' +
    'items lists'
  );
}

// --- instagram_get_account -------------------------------------------------

/**
 * The id `get_account` publishes. `id` is the one field its output schema
 * requires, and the body is cast, so a profile Meta returned with `id` absent,
 * `null` or not a string failed the whole call as MCP error -32602. When the
 * read addressed a configured account id, that id IS the node read and is
 * published; a read through the `me` alias has nothing to fall back on, so it
 * fails with an error that says what was wrong instead of a schema mismatch.
 */
function profileId(wireId: unknown, requested: string | undefined): string {
  if (typeof wireId === 'string' && wireId !== '') return wireId;
  // `core/config` maps a blank account id to `undefined`, so a configured one
  // is never empty here.
  if (requested !== undefined) return requested;
  throw new InstagramError(
    'Instagram returned the account profile without a usable id, and no account id is ' +
      'configured to identify it. Retry, or configure the account id for this profile.',
    { kind: 'upstream' },
  );
}

const getAccountTool = defineTool({
  name: 'instagram_get_account',
  title: 'Get account profile',
  description:
    'Fetch the profile of the operated Instagram professional account: username, display name, ' +
    'biography, website, profile-picture URL, and follower / following / media counts. Read-only ' +
    '(GET /{ig-id}). Fields the account hides or that Meta omits are simply absent. Username, name, ' +
    'biography and website are account-controlled free text and are returned inside an untrusted ' +
    'content fence.',
  package: PACKAGE,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {},
  output: {
    id: z.string().describe('The Instagram professional-account ID.'),
    username: z.string().optional().describe('IG handle (fenced untrusted text).'),
    name: z.string().optional().describe('Display name (fenced untrusted text).'),
    biography: z.string().optional().describe('Profile biography (fenced untrusted text).'),
    website: z.string().optional().describe('Profile website (fenced untrusted text).'),
    profilePictureUrl: z.string().optional().describe('CDN URL of the profile picture.'),
    followersCount: z.number().optional().describe('Follower count; absent if unavailable.'),
    followsCount: z.number().optional().describe('Following count; absent if unavailable.'),
    mediaCount: z.number().optional().describe('Number of published media; absent if unavailable.'),
  },
  logFields: (args) => ({ account: args.account }),
  handler: async (_args, ctx) => {
    const profile = await getAccount(ctx.req, { igId: ctx.profile.accountId ?? 'me' });
    const structured = {
      id: profileId(profile.id, ctx.profile.accountId),
      username: fenceOptional(profile.username),
      name: fenceOptional(profile.name),
      biography: fenceOptional(profile.biography),
      website: fenceOptional(profile.website),
      profilePictureUrl: stringOrAbsent(profile.profilePictureUrl),
      followersCount: numberOrAbsent(profile.followersCount),
      followsCount: numberOrAbsent(profile.followsCount),
      mediaCount: numberOrAbsent(profile.mediaCount),
    };
    return json(structured, { pretty: ctx.settings.prettyJson });
  },
});

// --- instagram_list_linked_accounts (Path B only) --------------------------

const listLinkedAccountsTool = defineTool({
  name: 'instagram_list_linked_accounts',
  title: 'List linked accounts',
  description:
    'Enumerate the Facebook Pages this token can act on and the Instagram business account linked ' +
    'to each (GET /me/accounts). Read-only. Available only on the Facebook-login auth path ' +
    '(fb-login / Path B); the Instagram-login path has no Page graph to enumerate. Page names and ' +
    'IG handles are account-controlled free text and are returned inside an untrusted content fence. ' +
    'Every page is followed up to the server item cap (IG_MAX_ITEMS); when the cap is reached while more ' +
    'Pages remained, paging.truncated is true and paging.after (when present) resumes the listing. ' +
    'An entry Instagram returns that is not a Page object is left out, and omittedWithoutId plus ' +
    'note say how many were.',
  package: PACKAGE,
  paths: ['fb-login'],
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {
    after: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Opaque pagination cursor from a previous response's paging.after. Omit to start from the " +
          'first Page.',
      ),
  },
  output: {
    items: z
      .array(
        z.object({
          pageId: z.string().optional().describe('Facebook Page ID.'),
          pageName: z.string().optional().describe('Page name (fenced untrusted text).'),
          igId: z.string().optional().describe('Linked IG business-account ID, if any.'),
          igUsername: z.string().optional().describe('Linked IG handle (fenced untrusted text).'),
        }),
      )
      .describe('Pages the token can act on, with their linked IG business accounts.'),
    paging: z.object({ after: z.string().optional(), truncated: z.boolean() }).passthrough(),
    omittedWithoutId: z.number().int().optional(),
    note: z.string().optional(),
  },
  logFields: (args) => ({ account: args.account, hasCursor: args.after !== undefined }),
  handler: async (args, ctx) => {
    const page = await listLinkedAccounts(ctx.req, ctx.settings.maxItems, args.after);
    // A `null` or scalar entry is not a Page: it has no id to act on and no field
    // to publish, so it is left out — and counted, so a token that can act on
    // three Pages does not read as one that can act on two (CC-COM-16). An
    // object row stays even without a `pageId`: every row field is optional on
    // purpose (see the output schema's contract test).
    const rows = page.items.filter(isRecordObject);
    const items = rows.map((row) => ({
      pageId: stringOrAbsent(row.pageId),
      pageName: fenceOptional(row.pageName),
      igId: stringOrAbsent(row.igId),
      igUsername: fenceOptional(row.igUsername),
    }));
    // Same publishing rule as `instagram_list_media`: a capped walk says so, and
    // a cursor or note is published only when the api layer offered one — an
    // `undefined`-valued key would read as "here is your next cursor".
    const paging: Record<string, unknown> = { truncated: page.truncated };
    if (page.after !== undefined) paging.after = page.after;
    const payload: Record<string, unknown> = { items, paging };
    const notes: string[] = [];
    if (page.note !== undefined) notes.push(page.note);
    const omitted = page.items.length - rows.length;
    if (omitted > 0) {
      payload.omittedWithoutId = omitted;
      notes.push(omittedPagesNote(omitted));
    }
    if (notes.length > 0) payload.note = notes.join('; ');
    return json(payload, { pretty: ctx.settings.prettyJson });
  },
});

// --- instagram_token_status ------------------------------------------------

const tokenStatusTool = defineTool({
  name: 'instagram_token_status',
  title: 'Token status',
  description:
    'Report the active credential: auth path (A = ig-login / B = fb-login), whether a token is ' +
    'configured, the resolved account ID, and — on Path B, via debug_token — validity, granted ' +
    'scopes, absolute expiry and days-left (with a refresh warning as the threshold nears). Path A ' +
    'has no token-introspection endpoint, so its expiry is the one the login/refresh CLI recorded ' +
    '(IG_TOKEN_EXPIRES_AT), and unknown when none is recorded. Read-only.',
  package: PACKAGE,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {},
  output: {
    profile: z.string().describe('Active profile name.'),
    authPath: z.string().describe("Auth path: 'ig-login' (A) or 'fb-login' (B)."),
    tokenConfigured: z.boolean().describe('Whether an access token is configured for the profile.'),
    accountId: z.string().optional().describe('Resolved IG account ID, when known.'),
    appConfigured: z.boolean().describe('Whether Meta-app credentials (app ID) are configured.'),
    isValid: z.boolean().optional().describe('debug_token validity (Path B only).'),
    scopes: z.array(z.string()).optional().describe('Granted scopes (Path B only).'),
    expiryState: z
      .string()
      .describe("Expiry state: 'unknown' | 'never' | 'valid' | 'expiring_soon' | 'expired'."),
    expiresAt: z
      .string()
      .optional()
      .describe('ISO 8601 absolute token expiry (Path B: debug_token; Path A: recorded expiry).'),
    daysLeft: z.number().optional().describe('Whole days until expiry, when the expiry is known.'),
    dataAccessExpiresAt: z
      .string()
      .optional()
      .describe(
        'ISO 8601 end of the Path-B data-access window, when Meta reports one. Absent when ' +
          'Meta omits it or reports 0 (no data-access expiry).',
      ),
    warning: z.string().optional().describe('Actionable remediation, when any applies.'),
    rateLimitBudget: z
      .object({
        available: z.boolean().describe('Whether a usage snapshot is available here.'),
        note: z.string().describe('Explanation of the snapshot source / availability.'),
      })
      .describe('Rate-limit budget snapshot (see integration notes in the tool source).'),
  },
  logFields: (args) => ({ account: args.account }),
  handler: async (_args, ctx) => {
    const { profile, settings, clock } = ctx;
    const base = {
      profile: profile.name,
      authPath: profile.authPath,
      tokenConfigured: profile.accessToken.length > 0,
      accountId: profile.accountId,
      appConfigured: profile.appId !== undefined && profile.appId.length > 0,
      // The last-seen X-App-Usage / X-Business-Use-Case-Usage snapshot lives in
      // the HTTP client and is not exposed through ToolContext in this build.
      // Surfaced honestly rather than fabricated — see integration notes.
      rateLimitBudget: {
        available: false,
        note: 'Usage headers are parsed by the HTTP client; the last-seen snapshot is not exposed through the tool context yet.',
      },
    };

    if (profile.authPath === 'fb-login') {
      const info = await debugToken(ctx.req, { inputToken: profile.accessToken });
      const expiry = summarizeTokenExpiry({
        expiresAtSec: info.expiresAtSec,
        nowMs: clock.now(),
        refreshAfterDays: settings.refreshAfterDays,
      });
      // `data_access_expires_at` is unvalidated wire data from the SAME payload
      // as `expires_at`. It is summarized by `summarizeDataAccessExpiry`, which
      // `doctor` shares, so the two diagnostics cannot disagree about it: `0`
      // and an omitted field publish nothing (CC-DATA-113), a value that is not
      // a representable instant is omitted with a warning naming it (CC-AUTH-20,
      // CC-AUTH-45, CC-AUTH-71), and a window that has already closed keeps its
      // date and adds a warning of its own (CC-AUTH-12, CC-AUTH-77). The
      // warning goes ALONGSIDE — never instead of — whatever the token expiry
      // summary already had to say.
      const dataAccess = summarizeDataAccessExpiry({
        dataAccessExpiresAtSec: info.dataAccessExpiresAtSec,
        nowMs: clock.now(),
      });
      const dataAccessExpiresAt = dataAccess.expiresAt;
      // Equivalent-mutant note: `(w) => w` filters identically here — both
      // sources are either `undefined` or a sentence built from non-empty
      // literals, so no empty string can reach the filter. The predicate is
      // documentation, not a load-bearing narrowing: `warnings` is read only
      // through `.length` and `.join(' ')`, and both accept
      // `(string | undefined)[]`, so deleting it compiles clean (measured
      // 2026-09-23: tsc exit 0, no diagnostics). It stays because it states the
      // invariant the filter establishes.
      const warnings = [expiry.warning, dataAccess.warning].filter(
        (w): w is string => w !== undefined,
      );
      const structured = {
        ...base,
        isValid: booleanOrAbsent(info.isValid),
        scopes: scopesOrAbsent(info.scopes),
        expiryState: expiry.state,
        expiresAt: expiry.expiresAt,
        daysLeft: expiry.daysLeft,
        dataAccessExpiresAt,
        warning: warnings.length === 0 ? undefined : warnings.join(' '),
      };
      return json(structured, { pretty: settings.prettyJson });
    }

    // Path A (ig-login): no debug_token endpoint, so the only expiry available is
    // the one `login`/`refresh` recorded beside the token (`IG_TOKEN_EXPIRES_AT`,
    // read back by `core/config.ts`); without a record it is unknown (CC-AUTH-7).
    // `recordedIn` makes the warning say so: the record is file metadata about
    // the token `login`/`refresh` stored, not a fact read off this token.
    const expiry = summarizeTokenExpiry({
      expiresAtSec: profile.tokenExpiresAtSec,
      nowMs: clock.now(),
      refreshAfterDays: settings.refreshAfterDays,
      recordedIn: envVarFor(profile.name, TOKEN_EXPIRES_AT_SUFFIX),
      recordUnverified: profile.tokenExpiryUnverified === true,
    });
    const structured = {
      ...base,
      expiryState: expiry.state,
      expiresAt: expiry.expiresAt,
      daysLeft: expiry.daysLeft,
      warning: expiry.warning,
    };
    return json(structured, { pretty: settings.prettyJson });
  },
});

/** The `account` package tool surface, imported by the registry integration. */
export const accountTools: readonly ToolSpec[] = Object.freeze([
  getAccountTool,
  listLinkedAccountsTool,
  tokenStatusTool,
]);
