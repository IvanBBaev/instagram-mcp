/**
 * Tool-layer contract for Graph object-id arguments (`tools/ids.ts`).
 *
 * The api layer now percent-encodes every id it interpolates into a path, which
 * makes a hostile id harmless. This layer is the second, independent defence and
 * has a different job: refuse the value at the seam, with a message the model can
 * act on, instead of spending a Graph call on a request that cannot succeed.
 * Both halves are asserted here — the *declared* schema of every id field, and
 * the *live* refusal through `mcp/registry.ts`, which re-runs `safeParse` on the
 * raw arguments and is therefore where the rule actually bites.
 *
 * The negative direction gets equal weight on purpose: a regex that rejects a
 * real Instagram id would be a worse defect than the injection it guards against,
 * so both observed id forms are pinned as MUST-ACCEPT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult } from '../../src/mcp/define.js';
import { registerTools } from '../../src/mcp/registry.js';
import type { Logger, ResolvedProfile } from '../../src/core/types.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { testSettings } from '../helpers/settings.js';
import { allTools } from '../../src/tools/index.js';
import { GRAPH_ID_MESSAGE, GRAPH_ID_PATTERN } from '../../src/tools/ids.js';

// --- What the charset must and must not admit -------------------------------

/**
 * Ids Meta actually issues. The plain form is the 17-digit object id every
 * fixture in this repo carries; the underscore form is what Meta returns for
 * comments and media on permalinks and webhook payloads (`<user-id>_<media-id>`).
 * Both must survive the schema untouched.
 */
const REAL_IDS = ['17841400008460056', '17841400008460056_17877854240352520', '9', 'me'] as const;

/**
 * Values that must never reach the api layer. The first three are the three
 * proven consequences (fragment-truncated token, smuggled query parameters,
 * dropped version pin); the rest are the neighbouring URL metacharacters that
 * would become structural if the charset were widened later.
 */
const HOSTILE_IDS = [
  '17841#',
  '17841?access_token=STOLEN',
  '17841&fields=id',
  '../me',
  '17841/comments',
  '17841%2Fme',
  '17841.me',
  '17841 me',
  '17841@me',
  '',
] as const;

// --- Which fields carry the rule -------------------------------------------

/**
 * Every tool argument that is a Graph object id, pinned by name. Two sweeps run
 * off this list, and between them they only ever compare the pin against the
 * schemas: the first asserts every entry carries the rule, the second asserts
 * nothing else carries it. Both directions are the same fact read twice, so a
 * NEW id argument declared as a bare `z.string()` and left off this list is on
 * neither side and neither sweep says a word. The third sweep is the one that
 * catches that, and it derives its subject from the argument's NAME instead of
 * from anything written here.
 */
const ID_FIELDS: readonly (readonly [string, string])[] = [
  ['instagram_get_media', 'mediaId'],
  ['instagram_get_media_insights', 'media_id'],
  ['instagram_create_media_container', 'locationId'],
  ['instagram_create_media_container', 'children'],
  ['instagram_get_container_status', 'containerId'],
  ['instagram_publish_media', 'creationId'],
  ['instagram_post_image', 'locationId'],
  ['instagram_post_image', 'resumeContainerId'],
  ['instagram_post_reel', 'locationId'],
  ['instagram_post_reel', 'resumeContainerId'],
  ['instagram_post_story', 'resumeContainerId'],
  ['instagram_list_comments', 'mediaId'],
  ['instagram_get_comment', 'commentId'],
  ['instagram_reply_to_comment', 'commentId'],
  ['instagram_create_comment', 'mediaId'],
  ['instagram_hide_comment', 'commentId'],
  ['instagram_unhide_comment', 'commentId'],
  ['instagram_delete_comment', 'commentId'],
  ['instagram_set_comments_enabled', 'mediaId'],
  ['instagram_get_hashtag_media', 'hashtagId'],
];

/**
 * Peel `.optional()` / array wrappers so the sweep sees the string schema the
 * rule lives on. `children` is an array of ids, and three of the publishing
 * fields are optional, so both wrappers are real cases rather than defensive
 * padding.
 */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema;
  for (;;) {
    if (s instanceof z.ZodOptional) s = s.unwrap() as z.ZodTypeAny;
    else if (s instanceof z.ZodArray) s = s.element as z.ZodTypeAny;
    else return s;
  }
}

/** True when this schema enforces {@link GRAPH_ID_PATTERN}. */
function carriesIdRule(schema: z.ZodTypeAny): boolean {
  const inner = unwrap(schema);
  if (!(inner instanceof z.ZodString)) return false;
  return inner._def.checks.some(
    (c) => c.kind === 'regex' && c.regex.source === GRAPH_ID_PATTERN.source,
  );
}

const byName = new Map(allTools.map((t) => [t.name, t]));

test('every argument pinned as a Graph object id actually carries the id rule', () => {
  for (const [tool, field] of ID_FIELDS) {
    const spec = byName.get(tool);
    assert.ok(spec, `${tool} is part of the surface`);
    const schema = spec.input[field];
    assert.ok(schema, `${tool}.${field} exists`);
    assert.ok(carriesIdRule(schema), `${tool}.${field} validates as a Graph object id`);
  }
});

test('no OTHER tool argument silently carries the id rule', () => {
  // The pin is bidirectional: applying the id charset to a field that is not an
  // id (a caption, a cursor, a hashtag query) would reject perfectly valid input
  // and is exactly the over-strict failure this rule must not cause.
  const found: string[] = [];
  for (const spec of allTools) {
    for (const [field, schema] of Object.entries(spec.input)) {
      if (carriesIdRule(schema)) found.push(`${spec.name}.${field}`);
    }
  }
  assert.deepEqual(
    found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ID_FIELDS.map(([t, f]) => `${t}.${f}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
});

/**
 * The house naming convention for a Graph object id, as an argument name wears
 * it: `mediaId` in camelCase, `media_id` in the snake_case the Graph fields use,
 * `id`/`ids` on its own. Deliberately not `/id$/i`, which would also claim
 * `valid` and every other word that happens to end in those two letters.
 */
const ID_NAME = /(?:^ids?$|_ids?$|[a-z0-9]Ids?$)/;

/**
 * The one id argument whose name does not advertise it: an array of container
 * ids, named for what the carousel calls them. The derived sweep below cannot
 * see it, and does not need to — the bidirectional sweep above names it.
 */
const ID_FIELD_NOT_NAMED_LIKE_ONE = 'instagram_create_media_container.children';

test('every argument NAMED like a Graph object id carries the id rule', () => {
  // This is the direction the two sweeps above cannot have. They both read the
  // schemas, so they agree with each other about an argument that was never
  // declared with `graphObjectId()` and never listed: it is simply absent from
  // both sides. The name is the one piece of evidence that survives that
  // omission, and the convention is exact here rather than approximate — every
  // argument named like an id carries the rule today, with no exemption list.
  const named: string[] = [];
  const bare: string[] = [];
  for (const spec of allTools) {
    for (const [field, schema] of Object.entries(spec.input)) {
      if (!ID_NAME.test(field)) continue;
      named.push(`${spec.name}.${field}`);
      if (!carriesIdRule(schema)) bare.push(`${spec.name}.${field}`);
    }
  }

  assert.deepEqual(
    bare,
    [],
    `these arguments are named like Graph object ids but declare a bare string: ` +
      `${bare.join(', ')}. Nothing then refuses a hostile id at the seam, and the api ` +
      `encoder is left as the only thing between it and a request path. Declare them with ` +
      `graphObjectId() and add them to ID_FIELDS.`,
  );

  // Floor, and the only one that can fail: the check above is a claim about a
  // set this regex selects, so a pattern that stopped matching the convention
  // would report an empty list of offenders forever. Every pinned id argument
  // but the one named exception must be inside that set.
  assert.deepEqual(
    ID_FIELDS.map(([t, f]) => `${t}.${f}`).filter((n) => !named.includes(n)),
    [ID_FIELD_NOT_NAMED_LIKE_ONE],
    'ID_NAME no longer matches the id arguments this file pins by hand, so the sweep above ' +
      'selects the wrong set and passes over whatever it stopped recognising.',
  );
});

test('pagination cursors and free-text arguments are deliberately NOT id-constrained', () => {
  // A Graph cursor is an opaque base64-ish blob that legitimately contains "=",
  // "+" and "/". It rides in the query string, where URLSearchParams encodes it,
  // so it is not part of the path-injection surface — and constraining it would
  // break real paging on the second page of every listing.
  const cursor = 'QVFIUmJ1c3Rlcg==+slash/inside';
  for (const tool of ['instagram_list_media', 'instagram_list_comments']) {
    const schema = byName.get(tool)?.input.after;
    assert.ok(schema, `${tool}.after exists`);
    assert.equal(schema.safeParse(cursor).success, true, `${tool}.after accepts a real cursor`);
  }
  // The hashtag SEARCH term is free text with its own normalisation ("#tag").
  const hashtag = byName.get('instagram_search_hashtag')?.input.hashtag;
  assert.ok(hashtag);
  assert.equal(hashtag.safeParse('#nofilter').success, true);
});

// --- The charset itself -----------------------------------------------------

test('every id field accepts the id forms Instagram actually issues', () => {
  for (const [tool, field] of ID_FIELDS) {
    const schema = unwrap(byName.get(tool)!.input[field]!);
    for (const id of REAL_IDS) {
      const parsed = schema.safeParse(id);
      assert.equal(parsed.success, true, `${tool}.${field} accepts ${id}`);
      // Unchanged, not merely accepted: zod must not be trimming or coercing an
      // id on its way to a URL.
      assert.equal(parsed.success && parsed.data, id, `${tool}.${field} returns ${id} verbatim`);
    }
  }
});

test('every id field rejects the values that would rewrite the URL', () => {
  for (const [tool, field] of ID_FIELDS) {
    const schema = unwrap(byName.get(tool)!.input[field]!);
    for (const hostile of HOSTILE_IDS) {
      assert.equal(
        schema.safeParse(hostile).success,
        false,
        `${tool}.${field} rejects ${JSON.stringify(hostile)}`,
      );
    }
  }
});

/**
 * Values one edit away from a real id that the rule must still refuse: the
 * same digits wrapped in whitespace, a sign, or in digits from another script.
 * `HOSTILE_IDS` proves the charset refuses URL metacharacters; this list proves
 * nothing in the chain silently REPAIRS a near miss into an accepted id. A
 * `.trim()` inserted ahead of the pattern would turn `' 178…'` into a valid
 * request for an id the model never quite named, and a widened charset that
 * admits `+` would let `+178…` through — a value `URLSearchParams` and a Graph
 * path treat differently.
 */
const NEAR_MISS_IDS = [
  ' 17841400008460056',
  '17841400008460056 ',
  '\t17841400008460056',
  '17841400008460056\n',
  '+17841400008460056',
  '\uFF11\uFF17\uFF18\uFF14\uFF11', // fullwidth digits
  '\u0661\u0667\u0668\u0664\u0661', // Arabic-Indic digits
] as const;

test('every id field refuses a near miss instead of repairing it', () => {
  for (const [tool, field] of ID_FIELDS) {
    const schema = unwrap(byName.get(tool)!.input[field]!);
    for (const nearMiss of NEAR_MISS_IDS) {
      assert.equal(
        schema.safeParse(nearMiss).success,
        false,
        `${tool}.${field} refuses ${JSON.stringify(nearMiss)}`,
      );
    }
  }
});

test('an id that looks numeric is passed through verbatim, never coerced', () => {
  // Graph ids are opaque strings that happen to be made of digits. Leading
  // zeros and an exponent-looking form are within the charset and must reach the
  // URL exactly as given: any numeric coercion on the way would rewrite
  // `0017…` to `17…` and `1e5` to `100000`, i.e. address a different object.
  const schema = unwrap(byName.get('instagram_get_media')!.input.mediaId!);
  for (const id of ['0017841400008460056', '1e5'] as const) {
    const parsed = schema.safeParse(id);
    assert.equal(parsed.success, true, `${id} is within the charset`);
    assert.equal(parsed.success && parsed.data, id, `${id} is returned verbatim`);
  }
});

test('an over-long id is refused rather than sent', () => {
  // 64 characters is comfortably above the longest form Meta issues (the
  // underscore-joined pair is 35) and below anything that would bloat a URL or a
  // log line. Both sides of the boundary are pinned so a future edit has to be
  // deliberate.
  const schema = unwrap(byName.get('instagram_get_media')!.input.mediaId!);
  assert.equal(schema.safeParse('1'.repeat(64)).success, true);
  assert.equal(schema.safeParse('1'.repeat(65)).success, false);
});

// --- The live seam ----------------------------------------------------------

/**
 * Everything above pins what the specs *declare*. `mcp/registry.ts` is what
 * actually runs `safeParse` on the raw arguments, so these drive the real
 * registration path: a declared rule nobody enforces would pass every assertion
 * above and still ship the defect.
 */

type RegisterCb = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

function registerAll(): Map<string, RegisterCb> {
  const cbs = new Map<string, RegisterCb>();
  const server = {
    registerTool(name: string, _config: unknown, cb: RegisterCb) {
      cbs.set(name, cb);
      return {};
    },
  } as unknown as McpServer;

  // Both auth paths, because the discovery tools are `paths: ['fb-login']` and
  // would not be registered at all against an ig-login-only profile list.
  const igProfile: ResolvedProfile = { name: 'default', authPath: 'ig-login', accessToken: 'tok' };
  const fbProfile: ResolvedProfile = {
    name: 'fb',
    authPath: 'fb-login',
    accessToken: 'tok',
    appId: 'app',
    appSecret: 'secret',
  };
  registerTools({
    server,
    tools: allTools,
    profiles: [igProfile, fbProfile],
    defaultProfileName: 'default',
    settings: testSettings(),
    clock: fakeClock(1_700_000_000_000),
    log: silent,
    // No network in this suite. A rejected id must never get this far; a valid
    // id must, and the marker below is how the accepting direction is told apart
    // from the rejecting one.
    makeRequest: () => () => Promise.reject(new Error('NO-NETWORK-MARKER')),
    env: { IG_TOOL_PACKAGES: 'all' },
    confirm: { isSupported: () => false, ask: () => Promise.reject(new Error('unused')) },
  });
  return cbs;
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => c.text).join('\n');
}

test('the registry refuses a hostile id before any request is built', async () => {
  const cbs = registerAll();
  for (const [tool, field] of ID_FIELDS) {
    const cb = cbs.get(tool);
    assert.ok(cb, `${tool} is registered`);
    // `children` is an array of ids, so the hostile value has to go inside it —
    // the element schema is what carries the rule.
    const value: unknown = field === 'children' ? ['17841#injected'] : '17841#injected';
    const res = await cb({ [field]: value });
    assert.equal(res.isError, true, `${tool} refuses the call`);
    const text = textOf(res);
    assert.ok(text.includes(field), `${tool} names the offending argument: ${text}`);
    assert.ok(text.includes(GRAPH_ID_MESSAGE), `${tool} states the rule: ${text}`);
    assert.equal(
      text.includes('NO-NETWORK-MARKER'),
      false,
      `${tool} never reached the request seam`,
    );
  }
});

test('the refusal never echoes the value it refused', async () => {
  // An id argument is exactly where a caller pastes a token by mistake. Quoting
  // the offending value back would copy that secret into the transcript and into
  // every log of it, so the message carries the RULE and not the input.
  const cbs = registerAll();
  const credentialShaped = 'EAAG#SECRET-TOKEN-DO-NOT-ECHO-0123456789';
  const res = await cbs.get('instagram_get_media')!({ mediaId: credentialShaped });
  assert.equal(res.isError, true);
  const text = textOf(res);
  assert.equal(text.includes(credentialShaped), false, `the value is not echoed: ${text}`);
  assert.equal(text.includes('SECRET-TOKEN-DO-NOT-ECHO'), false, `not even in part: ${text}`);
});

test('the rejection text states the rule, in the words the model is actually handed', () => {
  // Every other assertion about this message spells it `GRAPH_ID_MESSAGE`, so the
  // message is only ever compared against itself: emptying the constant, or
  // swapping it for any other sentence, leaves them all green. It is the ONLY
  // thing the model is told when an id is refused — `mcp/registry.ts` renders zod
  // issue messages and never the offending value — so its wording is the contract
  // and has to name the charset, the bound and the way out.
  assert.equal(
    GRAPH_ID_MESSAGE,
    'must be an Instagram object id: 1-64 characters, letters, digits, "_" or "-" only ' +
      '(use an id returned by a previous call; "/", "?", "#", "&", "." and spaces are not ids)',
  );
  assert.ok(
    GRAPH_ID_MESSAGE.includes('1-64') && GRAPH_ID_PATTERN.source.includes('{1,64}'),
    'the bound the text quotes is the bound the pattern enforces',
  );
});

test('a legitimate id is NOT refused by the live seam', async () => {
  // The regression that would matter most: the schema quietly rejecting real
  // ids. Both observed forms must get past validation and reach the request
  // seam — which is what the network marker proves.
  const cbs = registerAll();
  for (const id of ['17841400008460056', '17841400008460056_17877854240352520']) {
    const res = await cbs.get('instagram_get_media')!({ mediaId: id });
    const text = textOf(res);
    assert.equal(text.includes('Invalid arguments'), false, `${id} passes validation: ${text}`);
    assert.ok(text.includes('NO-NETWORK-MARKER'), `${id} reached the request seam: ${text}`);
  }
});
