/**
 * Contract tests for the two pieces of tool metadata the type system cannot
 * check: `annotations.readOnlyHint` and the `package` tag.
 *
 * ## Why this file exists
 *
 * `registerTools` enforces a forced-read-only package with exactly one line:
 *
 * ```ts
 * if (forceReadonly && spec.annotations.readOnlyHint !== true) continue;
 * ```
 *
 * That single predicate is what `IG_TOOL_PACKAGES=reader` and
 * `IG_PACKAGES_READONLY=<pkg>` reduce to. But `readOnlyHint` is an optional
 * boolean on a plain interface: nothing connects it to what the handler
 * actually does. The real mutation gate — `withWriteGate` in
 * `src/mcp/write-mode.ts` — is called *by the handler*, not by the registry, so
 * a write tool that declared `readOnlyHint: true` would be advertised to the
 * client as safe **and** survive the forced-read-only filter, while still
 * writing when called. Reshaping `ToolSpec` to make that unrepresentable is a
 * frozen contract (Gate G1), so the boundary is held here, by test.
 *
 * The pre-existing reader-profile assertions in `test/mcp/registry.test.ts`
 * cannot hold it: they assert `annotations.readOnlyHint === true` for every
 * registered tool, which is the filter's own predicate restated, plus a
 * hand-written list of write-tool names. Both pass unchanged if a write tool
 * flips its annotation and gets deleted from the hand-written list.
 *
 * ## How "actually performs a write" is derived
 *
 * Not from a list of tool names — a list rots and would only restate the
 * annotation it is supposed to check. Each of the 28 specs is **executed**
 * against an injected `WriteGateContext` whose seams are instrumented, and the
 * verdict is read off what the handler did with them:
 *
 * - `settings` is a `Proxy` that records property reads. `writeMode` and
 *   `allowDestructive` are read nowhere in the tool path except inside
 *   `withWriteGate`, so a read of either is a fingerprint of the gate.
 * - `confirm` records `isSupported()` / `ask()`. Only the gate consults a
 *   confirmer.
 * - the returned envelope is inspected for the gate's own payload
 *   (`structuredContent.mode` of `preview` or `refused`).
 * - `req` records every `IgRequestOptions` the handler issued.
 *
 * Nothing is written anywhere by these probes: `apply` is either absent (the
 * gate returns its preview envelope before `perform()`) or the confirmer
 * declines (the gate returns its refusal envelope before `perform()`). Since
 * `perform()` is never reached, neither is the journal append that follows it —
 * and `testSettings()` points `writeJournal` at a per-pid temp path regardless.
 * `globalThis.fetch` is poisoned for the whole file, so a handler that tried to
 * reach the network around the injected `req` seam would fail loudly here
 * rather than talk to Meta from a test run.
 *
 * ## What this does and does not catch
 *
 * It catches: a mutating tool whose handler goes through the gate but declares
 * `readOnlyHint: true`; a genuinely read-only tool that declares the gate; a new
 * write tool added without an annotation review; and — via a separate axis — a
 * handler that issued a non-`GET` request without consulting the gate at all.
 *
 * It does not catch: a write performed only *after* the point where these
 * probes stop the handler (behind an approved confirmation), a mutation that is
 * not an HTTP verb (a local file, a `dist`-side effect), or a handler whose
 * write path is unreachable with the synthesized arguments used here. The last
 * one is bounded rather than assumed: every probe must reach a classifiable
 * outcome, and a tool that cannot be classified fails the test instead of
 * silently counting as read-only.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { allTools } from '../../src/tools/index.js';
import { accountTools } from '../../src/tools/account.js';
import { mediaTools } from '../../src/tools/media.js';
import { insightsTools } from '../../src/tools/insights.js';
import { publishingTools } from '../../src/tools/publishing.js';
import { commentsTools } from '../../src/tools/comments.js';
import { discoveryTools } from '../../src/tools/discovery.js';
import { registerTools, type RegisterToolsDeps } from '../../src/mcp/registry.js';
import type { ToolResult, ToolSpec } from '../../src/mcp/define.js';
import type { WriteConfirmer, WriteGateContext } from '../../src/mcp/write-mode.js';
import type {
  IgRequestFn,
  IgRequestOptions,
  Logger,
  ResolvedProfile,
  Settings,
} from '../../src/core/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { testSettings } from '../helpers/settings.js';

const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('the tool metadata contract test must never touch the network');
};
after(() => {
  globalThis.fetch = realFetch;
});

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
};

/**
 * A Path-B profile: it satisfies every tool's `paths` filter, so no tool is
 * skipped for a reason unrelated to what this file is about.
 */
const probeProfile: ResolvedProfile = {
  name: 'probe',
  authPath: 'fb-login',
  accessToken: 'probe-token',
  accountId: '17841400000000000',
  appId: 'probe-app',
  appSecret: 'probe-secret',
};

// --- argument synthesis ----------------------------------------------------

/*
 * Handlers can only be driven with arguments their own schema accepts, and the
 * arguments are derived from that schema rather than tabulated per tool: a
 * hand-written args table is the same rotting artefact as a hand-written list
 * of write tools, one step removed. Candidates are proposed per zod type and
 * the first one the schema itself accepts (`safeParse`) wins, so a field with a
 * refinement — the `https://` media URLs, the id patterns, the numeric ranges —
 * selects its own sample instead of needing a special case here.
 */
const STRING_CANDIDATES: readonly string[] = [
  '17841400000000000',
  'https://example.invalid/asset.jpg',
  'sample',
];
const NUMBER_CANDIDATES: readonly number[] = [1, 0, 2];

/** zod 3 keeps its discriminator on `_def.typeName`; tests may read internals. */
function typeNameOf(schema: unknown): string {
  return (schema as any)?._def?.typeName ?? '';
}

/** Candidate values for a schema, cheapest and most likely first. */
function candidatesFor(schema: z.ZodTypeAny): unknown[] {
  const def = (schema as any)._def;
  switch (typeNameOf(schema)) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return candidatesFor(def.innerType);
    case 'ZodEffects':
      // A refinement/transform wrapper: propose what the inner type proposes and
      // let the outer `safeParse` reject the ones the refinement rejects.
      return candidatesFor(def.schema);
    case 'ZodString':
      return [...STRING_CANDIDATES];
    case 'ZodNumber':
      return [...NUMBER_CANDIDATES];
    case 'ZodBoolean':
      // `false` first: paging/`fetchAll`-style flags default to the cheap path.
      return [false, true];
    case 'ZodEnum':
      return [...(def.values as unknown[])];
    case 'ZodLiteral':
      return [def.value];
    case 'ZodArray': {
      const item = sampleValue(def.type);
      const min = Math.max(Number(def.minLength?.value ?? 1), 1);
      return [Array.from({ length: min }, () => item)];
    }
    case 'ZodObject': {
      const shape = def.shape() as z.ZodRawShape;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) out[key] = sampleValue(field);
      return [out];
    }
    default:
      return [];
  }
}

/**
 * One value the schema accepts. Returns `undefined` when no candidate passes,
 * which surfaces as a strict-parse failure in {@link synthesizeArgs} rather than
 * as a quietly degraded probe.
 */
function sampleValue(schema: z.ZodTypeAny): unknown {
  for (const candidate of candidatesFor(schema)) {
    if (schema.safeParse(candidate).success) return candidate;
  }
  return undefined;
}

/**
 * Arguments for one spec, minus `apply` (the probe sets that itself) and minus
 * any field the synthesizer could not satisfy — omission is correct for an
 * optional field and is caught by the strict parse below for a required one.
 */
function synthesizeArgs(spec: ToolSpec): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(spec.input)) {
    if (key === 'apply') continue;
    const value = sampleValue(field);
    if (value !== undefined) args[key] = value;
  }
  return args;
}

// --- the probe -------------------------------------------------------------

interface ProbeConfig {
  label: string;
  writeMode: Settings['writeMode'];
  allowDestructive: boolean;
  /** Passed as the `apply` argument when the tool declares that field. */
  apply?: boolean;
}

/**
 * The gate's behaviour depends on `IG_WRITE_MODE` and `IG_ALLOW_DESTRUCTIVE`,
 * so the verdict is taken across the whole cross product plus an explicit
 * `apply: true` run. A classification that held only in the mode this suite
 * happens to run under would be worth nothing; every probe must agree.
 */
const PROBES: readonly ProbeConfig[] = [
  { label: 'preview / destructive denied', writeMode: 'preview', allowDestructive: false },
  { label: 'apply / destructive allowed', writeMode: 'apply', allowDestructive: true },
  { label: 'apply / destructive denied', writeMode: 'apply', allowDestructive: false },
  {
    label: 'explicit apply:true / destructive allowed',
    writeMode: 'preview',
    allowDestructive: true,
    apply: true,
  },
];

interface Observation {
  /** Every `Settings` key the handler (or the gate) read during the call. */
  settingsRead: Set<string>;
  /** `isSupported` / `ask` in call order. */
  confirmCalls: string[];
  requests: IgRequestOptions[];
  /** `structuredContent.mode`, the gate's own envelope discriminator. */
  mode: unknown;
  isError: boolean;
  thrown?: string;
  args: Record<string, unknown>;
}

async function runProbe(spec: ToolSpec, config: ProbeConfig): Promise<Observation> {
  const settingsRead = new Set<string>();
  const settings = new Proxy(
    testSettings({ writeMode: config.writeMode, allowDestructive: config.allowDestructive }),
    {
      get(target, property, receiver) {
        if (typeof property === 'string') settingsRead.add(property);
        return Reflect.get(target, property, receiver);
      },
    },
  );

  const requests: IgRequestOptions[] = [];
  const req: IgRequestFn = async <T>(options: IgRequestOptions): Promise<T> => {
    requests.push(options);
    // The quota read refuses an envelope without `quota_usage` rather than
    // reporting 0, so it alone is answered with one; every other tool keeps
    // the empty body.
    if (options.path.endsWith('/content_publishing_limit')) {
      return { data: [{ quota_usage: 0 }] } as T;
    }
    return {} as T;
  };

  const confirmCalls: string[] = [];
  const confirm: WriteConfirmer = {
    isSupported() {
      confirmCalls.push('isSupported');
      return true;
    },
    async ask() {
      confirmCalls.push('ask');
      // Declining keeps the probe on the safe side of the gate: `withWriteGate`
      // returns its refusal envelope without ever calling `perform()`, so no
      // mutation is attempted and nothing is appended to the write journal.
      return { action: 'decline' };
    },
  };

  const ctx: WriteGateContext = {
    req,
    settings,
    profile: probeProfile,
    clock: fakeClock(0),
    log: noopLog,
    confirm,
  };

  const args = synthesizeArgs(spec);
  if (config.apply !== undefined && Object.hasOwn(spec.input, 'apply')) args.apply = config.apply;

  // A synthesizer gap must fail the test, not silently produce a handler that
  // bails out early and therefore looks read-only.
  const parsed = z.object(spec.input).strict().safeParse(args);
  assert.equal(
    parsed.success,
    true,
    `synthesized arguments for ${spec.name} do not satisfy its own input schema: ` +
      `${JSON.stringify(args)}`,
  );

  let result: ToolResult | undefined;
  let thrown: string | undefined;
  try {
    result = await spec.handler(args, ctx);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }

  return {
    settingsRead,
    confirmCalls,
    requests,
    mode: result?.structuredContent?.mode,
    isError: result?.isError === true,
    thrown,
    args,
  };
}

type Verdict = 'write' | 'read' | 'unclassifiable';

/** The gate fingerprints observed in one probe, named for the failure message. */
function gateSignals(observation: Observation): string[] {
  const signals: string[] = [];
  // `writeMode` and `allowDestructive` are read in exactly one place in the tool
  // path — `withWriteGate`. Reading either means the handler entered the gate.
  if (observation.settingsRead.has('writeMode')) signals.push('settings.writeMode read');
  if (observation.settingsRead.has('allowDestructive')) {
    signals.push('settings.allowDestructive read');
  }
  if (observation.confirmCalls.length > 0) {
    signals.push(`confirmer used (${observation.confirmCalls.join(', ')})`);
  }
  if (observation.mode === 'preview' || observation.mode === 'refused') {
    signals.push(`gate envelope mode=${String(observation.mode)}`);
  }
  return signals;
}

function verdictOf(observation: Observation): Verdict {
  if (gateSignals(observation).length > 0) return 'write';
  // No gate, but the handler did not complete either: the probe learned nothing
  // and must say so rather than default to the permissive answer.
  if (observation.thrown !== undefined) return 'unclassifiable';
  if (observation.isError) return 'unclassifiable';
  return 'read';
}

interface Classification {
  spec: ToolSpec;
  /** The single verdict all probes agreed on, or `unclassifiable`. */
  verdict: Verdict;
  perProbe: { config: ProbeConfig; observation: Observation; verdict: Verdict }[];
}

async function classifyAll(): Promise<Classification[]> {
  const out: Classification[] = [];
  for (const spec of allTools) {
    const perProbe: Classification['perProbe'] = [];
    for (const config of PROBES) {
      const observation = await runProbe(spec, config);
      perProbe.push({ config, observation, verdict: verdictOf(observation) });
    }
    const verdicts = new Set(perProbe.map((p) => p.verdict));
    const agreed = [...verdicts];
    out.push({
      spec,
      verdict: agreed.length === 1 && agreed[0] !== undefined ? agreed[0] : 'unclassifiable',
      perProbe,
    });
  }
  return out;
}

/** Probes are executed once and shared: 28 tools x 4 configurations. */
let classification: Promise<Classification[]> | undefined;
function classified(): Promise<Classification[]> {
  classification ??= classifyAll();
  return classification;
}

// --- axis 1: derived behaviour vs the declared readOnlyHint ----------------

test('every tool classifies the same way under every write-mode configuration', async () => {
  const results = await classified();
  assert.equal(results.length, 28, 'the probe must cover the whole v1 surface');

  for (const { spec, perProbe } of results) {
    const disagreement = perProbe.map((p) => `${p.config.label}: ${p.verdict}`);
    const distinct = new Set(perProbe.map((p) => p.verdict));
    assert.equal(
      distinct.size,
      1,
      `${spec.name} classifies differently depending on IG_WRITE_MODE / ` +
        `IG_ALLOW_DESTRUCTIVE, so the verdict below would be an accident of how ` +
        `this suite happens to be configured — ${disagreement.join(' | ')}`,
    );
    for (const probe of perProbe) {
      assert.notEqual(
        probe.verdict,
        'unclassifiable',
        `${spec.name} could not be classified under "${probe.config.label}": ` +
          `thrown=${probe.observation.thrown ?? '(none)'} isError=${String(probe.observation.isError)} ` +
          `args=${JSON.stringify(probe.observation.args)}. A probe that cannot reach an ` +
          `outcome proves nothing about the tool, and must not be read as "read-only".`,
      );
    }
  }
});

test('no tool that goes through the write gate declares readOnlyHint: true', async () => {
  // The forced-read-only filter in `registerTools` keeps a tool whose
  // `readOnlyHint === true`. A gated (mutating) tool that declared it would be
  // exposed by `IG_TOOL_PACKAGES=reader` and by every `IG_PACKAGES_READONLY`
  // package, and advertised to the MCP client as safe to call unattended.
  const offenders = (await classified())
    .filter((c) => c.verdict === 'write' && c.spec.annotations.readOnlyHint === true)
    .map((c) => {
      const first = c.perProbe[0];
      const why = first === undefined ? '' : ` (${gateSignals(first.observation).join('; ')})`;
      return `${c.spec.name}${why}`;
    });

  assert.deepEqual(
    offenders,
    [],
    'these tools pass their mutation through withWriteGate yet claim readOnlyHint: true, ' +
      'so a forced-read-only package would still register them',
  );
});

test('no tool that declares readOnlyHint: true goes through the write gate', async () => {
  // The other direction. It is the same set of tools stated the other way
  // round, but it fails with the other error message, and it is the one that
  // catches the harmless-looking edit: a read tool that grows a gated branch
  // keeps its `readOnlyHint: true` and stays in the reader profile.
  const gated = (await classified())
    .filter((c) => c.spec.annotations.readOnlyHint === true && c.verdict !== 'read')
    .map((c) => `${c.spec.name} -> ${c.verdict}`);

  assert.deepEqual(gated, [], 'a tool advertised as read-only reached the write gate');
});

test('the two axes agree for all 28 tools, in both directions', async () => {
  // The summary form: one table, so a failure shows which tool moved and which
  // way, rather than only that some set was non-empty.
  const table = (await classified()).map((c) => ({
    name: c.spec.name,
    derived: c.verdict,
    declaredReadOnly: c.spec.annotations.readOnlyHint === true,
  }));
  const mismatched = table.filter((row) => (row.derived === 'read') !== row.declaredReadOnly);
  assert.deepEqual(mismatched, []);
});

test('every tool declares readOnlyHint explicitly, write tools included', async () => {
  // The three assertions above all read the hint as `readOnlyHint === true`, so
  // they are blind to the difference between `false` and absent: a write tool
  // that omits the field passes every one of them. Behaviourally that is fine
  // today — the registry filter tests `!== true` and the MCP spec defaults the
  // hint to false — but it is not the same *declaration*. An absent hint reaches
  // the client as an absent hint, and to the next reviewer it is indistinguish-
  // able from "nobody considered it", which is exactly the state a new tool is
  // added in. Requiring the literal makes the omission a test failure instead of
  // a silent default, so annotating a new write tool is a step you cannot skip.
  //
  // Stated over all 28 rather than only the write ones: it costs nothing (every
  // read tool already declares `true`) and it also catches a read tool whose
  // hint is present but `undefined`. Writes are where it bites in practice.
  const undeclared = (await classified())
    .filter((c) => typeof c.spec.annotations.readOnlyHint !== 'boolean')
    .map((c) => `${c.spec.name} (observed as a ${c.verdict} tool)`);

  assert.deepEqual(
    undeclared,
    [],
    'these tools leave annotations.readOnlyHint undeclared; state it explicitly ' +
      '(`false` for a write tool, `true` for a read tool) rather than relying on the default',
  );
});

test('every write tool declares destructiveHint, and it matches what the gate is asked', async () => {
  // The MCP spec defaults an absent `destructiveHint` to TRUE on a tool that is
  // not read-only, so a reversible write tool that omits it is advertised to the
  // client as destructive — the opposite of an honest annotation. The expected
  // value is derived, not listed: `withWriteGate` reads `allowDestructive` only
  // for an intent marked `destructive`, so a read of it under any probe is the
  // handler asking for a destructive write.
  const mismatched = (await classified())
    .filter((c) => c.verdict === 'write')
    .flatMap((c) => {
      const derived = c.perProbe.some((p) => p.observation.settingsRead.has('allowDestructive'));
      const declared = c.spec.annotations.destructiveHint;
      return declared === derived
        ? []
        : [`${c.spec.name} (declares ${String(declared)}, gate saw destructive=${derived})`];
    });

  assert.deepEqual(mismatched, []);
});

test('no handler issued a mutating HTTP request outside the gate', async () => {
  // An independent axis. The gate fingerprint above cannot see a handler that
  // mutates through `ctx.req` without consulting `withWriteGate` at all — that
  // tool would be classified `read` and would look perfectly consistent with a
  // `readOnlyHint: true` annotation. The request seam is what catches it.
  const violations: string[] = [];
  for (const { spec, perProbe } of await classified()) {
    for (const probe of perProbe) {
      for (const request of probe.observation.requests) {
        if (request.method !== 'GET') {
          violations.push(
            `${spec.name} issued ${request.method} ${request.path} under "${probe.config.label}"`,
          );
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'a handler reached a non-GET Graph call on a path the write gate never saw',
  );
});

test('the declared `apply` argument picks out exactly the derived write tools', async () => {
  // A third, independent derivation: `apply` is the gate's own opt-in argument,
  // declared in the tool's input shape rather than observed at runtime. Two
  // derivations from different evidence agreeing is what makes the runtime one
  // trustworthy; if they ever diverge, one of them is describing the tool wrong.
  const results = await classified();
  const declaresApply = results
    .filter((c) => Object.hasOwn(c.spec.input, 'apply'))
    .map((c) => c.spec.name);
  const derivedWrites = results.filter((c) => c.verdict === 'write').map((c) => c.spec.name);
  assert.deepEqual(declaresApply, derivedWrites);
  assert.equal(derivedWrites.length, 11, 'the v1 surface has 11 gated write tools');
});

// --- the payoff: what the registry actually registers ----------------------

/** Runs the real `registerTools` against a recording registrar. */
function registeredUnder(env: NodeJS.ProcessEnv): string[] {
  const server = {
    registerTool() {
      return {};
    },
  } as unknown as McpServer;
  const req: IgRequestFn = async <T>(): Promise<T> => ({}) as T;
  const deps: RegisterToolsDeps = {
    server,
    tools: allTools,
    profiles: [probeProfile],
    defaultProfileName: probeProfile.name,
    settings: testSettings(),
    clock: fakeClock(0),
    log: noopLog,
    makeRequest: () => req,
    env,
  };
  return registerTools(deps).registered;
}

test('a forced-read-only surface exposes exactly the tools derived as read-only', async () => {
  // This is the assertion the whole file exists for: not "every registered tool
  // has readOnlyHint: true" (which restates the filter), but "every registered
  // tool was observed not to write, and every tool observed not to write is
  // still registered".
  const derivedReads = (await classified())
    .filter((c) => c.verdict === 'read')
    .map((c) => c.spec.name);

  const registered = registeredUnder({
    IG_TOOL_PACKAGES: 'all',
    IG_PACKAGES_READONLY: 'account,comments,discovery,insights,media,publishing',
  });

  assert.deepEqual([...registered].sort(), [...derivedReads].sort());
});

test('the reader profile registers only tools derived as read-only', async () => {
  // `reader` is in READONLY_PROFILES, so it forces every package it selects
  // read-only. It selects fewer packages than `all`, hence subset rather than
  // equality — but nothing that writes may appear in it.
  const byName = new Map((await classified()).map((c) => [c.spec.name, c.verdict]));
  const registered = registeredUnder({ IG_TOOL_PACKAGES: 'reader' });

  assert.ok(registered.length > 0, 'the reader profile must expose something');
  for (const name of registered) {
    assert.equal(byName.get(name), 'read', `the reader profile registered ${name}, a write tool`);
  }
});

// --- axis 2: the package tag vs the module the tool is defined in ----------

/*
 * The package tag is free-form metadata on the spec; the module a tool is
 * defined in is where a maintainer looks for it. Where the two disagree, every
 * `IG_TOOL_PACKAGES` / `IG_PACKAGES_DENY` / `IG_PACKAGES_READONLY` value an
 * operator would reason about from the source tree points at the wrong package.
 * The mismatch below is deliberate (see the comment at the tool's definition),
 * so this section pins it rather than corrects it: moving the tool would change
 * the published surface and the profile counts, which is the owner's call.
 */
const MODULES: readonly (readonly [string, readonly ToolSpec[]])[] = [
  ['account', accountTools],
  ['media', mediaTools],
  ['insights', insightsTools],
  ['publishing', publishingTools],
  ['comments', commentsTools],
  ['discovery', discoveryTools],
];

/** The module a spec is defined in, by object identity — not by its own tag. */
function definingModule(spec: ToolSpec): string[] {
  return MODULES.filter(([, tools]) => tools.includes(spec)).map(([name]) => name);
}

test('every tool is defined in exactly one package module', () => {
  for (const spec of allTools) {
    assert.deepEqual(
      definingModule(spec).length,
      1,
      `${spec.name} is exported by ${JSON.stringify(definingModule(spec))}`,
    );
  }
});

test('the package tag differs from the defining module for exactly one tool', () => {
  const mismatches = allTools
    .filter((spec) => definingModule(spec)[0] !== spec.package)
    .map((spec) => ({
      name: spec.name,
      definedIn: definingModule(spec)[0],
      taggedAs: spec.package,
    }));

  // Written out, not derived: this is the whole point of the pin. A second
  // cross-package tool — or this one moving — has to be an edit here.
  assert.deepEqual(mismatches, [
    { name: 'instagram_set_comments_enabled', definedIn: 'comments', taggedAs: 'media' },
  ]);
});

test('IG_PACKAGES_DENY=comments does not reach the comment switch, IG_PACKAGES_DENY=media does', () => {
  // The consequence of the tag, made executable. An operator who wants "no
  // comment mutations" denies `comments` and still ships a tool that turns
  // commenting off on any media object.
  const denyComments = registeredUnder({
    IG_TOOL_PACKAGES: 'all',
    IG_PACKAGES_DENY: 'comments',
  });
  assert.ok(
    denyComments.includes('instagram_set_comments_enabled'),
    'IG_PACKAGES_DENY=comments is expected to miss the media-tagged comment switch',
  );
  assert.equal(denyComments.includes('instagram_delete_comment'), false);

  const denyMedia = registeredUnder({ IG_TOOL_PACKAGES: 'all', IG_PACKAGES_DENY: 'media' });
  assert.equal(denyMedia.includes('instagram_set_comments_enabled'), false);
  // ...and it takes the two genuine media read tools with it.
  assert.equal(denyMedia.includes('instagram_list_media'), false);
  assert.equal(denyMedia.includes('instagram_get_media'), false);
  assert.ok(denyMedia.includes('instagram_delete_comment'));
});

test('IG_PACKAGES_READONLY=comments leaves the comment switch writable', () => {
  const readonlyComments = registeredUnder({
    IG_TOOL_PACKAGES: 'all',
    IG_PACKAGES_READONLY: 'comments',
  });
  assert.ok(
    readonlyComments.includes('instagram_set_comments_enabled'),
    'forcing the comments package read-only is expected to miss the media-tagged switch',
  );
  assert.equal(readonlyComments.includes('instagram_delete_comment'), false);

  const readonlyMedia = registeredUnder({
    IG_TOOL_PACKAGES: 'all',
    IG_PACKAGES_READONLY: 'media',
  });
  assert.equal(readonlyMedia.includes('instagram_set_comments_enabled'), false);
});

test('an explicit IG_TOOL_PACKAGES=comments list omits the comment switch', () => {
  const commentsOnly = registeredUnder({ IG_TOOL_PACKAGES: 'comments' });
  assert.equal(commentsOnly.includes('instagram_set_comments_enabled'), false);

  const mediaOnly = registeredUnder({ IG_TOOL_PACKAGES: 'media' });
  assert.deepEqual(mediaOnly, [
    'instagram_list_media',
    'instagram_get_media',
    'instagram_set_comments_enabled',
  ]);
});
