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
  summarizeTokenExpiry,
} from '../api/account.js';

const PACKAGE = 'account';

/** Fence an optional untrusted string, leaving `undefined` untouched so absent
 * Graph fields render as absent rather than a fenced empty box. */
function fenceOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : fence(value);
}

// --- instagram_get_account -------------------------------------------------

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
      id: profile.id,
      username: fenceOptional(profile.username),
      name: fenceOptional(profile.name),
      biography: fenceOptional(profile.biography),
      website: fenceOptional(profile.website),
      profilePictureUrl: profile.profilePictureUrl,
      followersCount: profile.followersCount,
      followsCount: profile.followsCount,
      mediaCount: profile.mediaCount,
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
    'IG handles are account-controlled free text and are returned inside an untrusted content fence.',
  package: PACKAGE,
  paths: ['fb-login'],
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {},
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
  },
  logFields: (args) => ({ account: args.account }),
  handler: async (_args, ctx) => {
    const linked = await listLinkedAccounts(ctx.req);
    const items = linked.map((row) => ({
      pageId: row.pageId,
      pageName: fenceOptional(row.pageName),
      igId: row.igId,
      igUsername: fenceOptional(row.igUsername),
    }));
    return json({ items }, { pretty: ctx.settings.prettyJson });
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
    'has no token-introspection endpoint, so expiry is reported honestly as unknown. Read-only.',
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
    expiresAt: z.string().optional().describe('ISO 8601 absolute token expiry (Path B).'),
    daysLeft: z.number().optional().describe('Whole days until expiry (Path B).'),
    dataAccessExpiresAt: z
      .string()
      .optional()
      .describe('ISO 8601 end of the Path-B data-access window, when provided.'),
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
      const structured = {
        ...base,
        isValid: info.isValid,
        scopes: info.scopes,
        expiryState: expiry.state,
        expiresAt: expiry.expiresAt,
        daysLeft: expiry.daysLeft,
        dataAccessExpiresAt:
          info.dataAccessExpiresAtSec === undefined
            ? undefined
            : new Date(info.dataAccessExpiresAtSec * 1000).toISOString(),
        warning: expiry.warning,
      };
      return json(structured, { pretty: settings.prettyJson });
    }

    // Path A (ig-login): no debug_token endpoint — expiry is unknown (CC-AUTH-7).
    const expiry = summarizeTokenExpiry({
      expiresAtSec: undefined,
      nowMs: clock.now(),
      refreshAfterDays: settings.refreshAfterDays,
    });
    const structured = {
      ...base,
      expiryState: expiry.state,
      warning: expiry.warning,
    };
    return json(structured, { pretty: settings.prettyJson });
  },
});

/** The `account` package tool surface, imported by the registry integration. */
export const accountTools: ToolSpec[] = [getAccountTool, listLinkedAccountsTool, tokenStatusTool];
