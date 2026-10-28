/**
 * Multi-account fan-out tool specs (Layer 3, V3-F1): one report across the
 * configured profiles of ONE operator. "Multi-account" here is one operator
 * with many accounts, never "multi-tenant" (many operators) — the analysis
 * keeps the two terms apart (docs/v3-analysis.md §4.3).
 *
 * The tool reads other profiles only through `ctx.profiles`, which the
 * registry attaches when the operator opts in with `IG_FANOUT_PROFILES`, and
 * which lists only the profiles that variable allows (the per-profile allow
 * list). Without it the tool degrades to the one profile it was called with
 * (the same read `instagram_get_account` makes, so nothing new is exposed) and
 * says so: `fanout` is `false` and `note` names the variable, so a one-row
 * report never reads as "you have one account".
 *
 * Each profile is read through `profiles.contextFor(name)`, the context the
 * registry would have built for `account: name` — that profile's own `req` and,
 * for any future write, its own write-gate seams, so per-profile gating is the
 * ordinary `withWriteGate` path. This module offers reads only. The D1 auth-path
 * check is not applied by `contextFor`; `GET /{ig-id}` is valid on both paths,
 * so no profile is filtered out here (a future path-bound fan-out read must
 * filter on `ProfileSummary.authPath` first).
 */
import { z } from 'zod';
import { defineTool, type ToolSpec } from '../mcp/define.js';
import { fence, json } from '../mcp/result.js';
import { getAccount } from '../api/account.js';
import { toInstagramError } from '../core/errors.js';
import { toProfileSummary, type ProfileSummary } from '../core/types.js';
import type { ToolContext } from '../mcp/define.js';

const PACKAGE = 'account';

/** The value when it has the type the output schema declares, else `undefined`
 * (`api/account` casts the Graph body; see `tools/account.ts`). */
function numberOrAbsent(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

const profileRow = z.object({
  name: z.string().describe('Configured profile name.'),
  authPath: z.enum(['ig-login', 'fb-login']).describe('Auth path of the profile.'),
  accountId: z.string().optional().describe('Configured IG account id, when one is set.'),
  ok: z.boolean().describe('Whether the profile read succeeded.'),
  igId: z.string().optional().describe('The IG professional-account id Instagram returned.'),
  username: z.string().optional().describe('IG handle (fenced untrusted text).'),
  followersCount: z.number().optional().describe('Follower count; absent if unavailable.'),
  followsCount: z.number().optional().describe('Following count; absent if unavailable.'),
  mediaCount: z.number().optional().describe('Number of published media; absent if unavailable.'),
  error: z
    .object({ kind: z.string(), message: z.string() })
    .optional()
    .describe('Why this profile could not be read; the other profiles are unaffected.'),
});

type ProfileRow = z.infer<typeof profileRow>;

/** One profile to read, and how to get the context that reads it. */
interface Target {
  summary: ProfileSummary;
  context: () => Promise<ToolContext>;
}

/** Why a report without `IG_FANOUT_PROFILES` has one row. */
export const FANOUT_OFF_NOTE =
  'Cross-account reports are off, so only the selected profile is listed. Set ' +
  'IG_FANOUT_PROFILES to * (every configured profile) or to a comma-separated list of ' +
  'profile names, then restart the server.';

const accountsOverviewTool = defineTool({
  name: 'instagram_get_accounts_overview',
  title: 'Get accounts overview',
  description:
    'One report across the configured account profiles: for each profile the operator opted in ' +
    'with IG_FANOUT_PROFILES, its IG handle and follower / following / media counts, plus totals. ' +
    'Read-only (GET /{ig-id} per profile, one profile at a time). A profile that fails is reported ' +
    'with its error and does not fail the others. Without IG_FANOUT_PROFILES only the selected ' +
    'profile is reported, fanout is false and note says why. ' +
    'Handles are account-controlled free text and are returned inside an untrusted content fence.',
  package: PACKAGE,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {},
  output: {
    fanout: z.boolean().describe('Whether IG_FANOUT_PROFILES opted profiles in for this report.'),
    note: z.string().optional().describe('Present when fanout is false: how to turn it on.'),
    profiles: z.array(profileRow).describe('One row per opted-in profile, default first.'),
    totals: z
      .object({
        profiles: z.number(),
        ok: z.number(),
        failed: z.number(),
        followersCount: z.number(),
        mediaCount: z.number(),
      })
      .describe('Counts summed over the profiles read successfully; an absent count adds 0.'),
  },
  logFields: (args) => ({ account: args.account }),
  handler: async (_args, ctx) => {
    const directory = ctx.profiles;
    const targets: readonly Target[] =
      directory === undefined
        ? [{ summary: toProfileSummary(ctx.profile), context: () => Promise.resolve(ctx) }]
        : directory.list().map((summary) => ({
            summary,
            context: () => directory.contextFor(summary.name),
          }));
    const rows: ProfileRow[] = [];
    // Sequential on purpose: one profile's calls never compete with another's
    // for the shared per-host concurrency budget, and the rows keep the
    // configuration order.
    for (const { summary, context } of targets) {
      const base = { name: summary.name, authPath: summary.authPath, accountId: summary.accountId };
      try {
        const profileCtx = await context();
        const profile = await getAccount(profileCtx.req, {
          igId: profileCtx.profile.accountId ?? 'me',
        });
        rows.push({
          ...base,
          ok: true,
          igId: typeof profile.id === 'string' ? profile.id : undefined,
          username: typeof profile.username === 'string' ? fence(profile.username) : undefined,
          followersCount: numberOrAbsent(profile.followersCount),
          followsCount: numberOrAbsent(profile.followsCount),
          mediaCount: numberOrAbsent(profile.mediaCount),
        });
      } catch (err) {
        const e = toInstagramError(err);
        rows.push({ ...base, ok: false, error: { kind: e.kind, message: e.message } });
      }
    }
    const succeeded = rows.filter((r) => r.ok);
    const structured = {
      fanout: directory !== undefined,
      note: directory === undefined ? FANOUT_OFF_NOTE : undefined,
      profiles: rows,
      totals: {
        profiles: rows.length,
        ok: succeeded.length,
        failed: rows.length - succeeded.length,
        followersCount: succeeded.reduce((sum, r) => sum + (r.followersCount ?? 0), 0),
        mediaCount: succeeded.reduce((sum, r) => sum + (r.mediaCount ?? 0), 0),
      },
    };
    return json(structured, { pretty: ctx.settings.prettyJson });
  },
});

/** Every fan-out tool; registered in `tools/index.ts` after the six packages. */
export const fanoutTools: readonly ToolSpec[] = Object.freeze([accountsOverviewTool]);
