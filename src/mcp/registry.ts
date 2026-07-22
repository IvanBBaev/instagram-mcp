/**
 * Tool registry & PACKAGES manifest (Layer 2). The single source of truth that
 * turns the tools-as-data surface into MCP registrations. See
 * docs/architecture.md §3 (PACKAGES manifest, `.strict()`, package-selection env
 * vars) and §4 (planned packages).
 *
 * Deliberately decoupled from concrete infrastructure: the tool list and the
 * per-profile request factory are *injected* (see {@link RegisterToolsDeps}), so
 * this module never imports `core/http`, `core/auth`, or `tools/*`. The
 * composition root (`index.ts`) supplies the real implementations; unit tests
 * supply fakes. That keeps registration testable without a live HTTP client and
 * lets the composition root be written in parallel.
 *
 * Resolution order (architecture §3, CC-CFG-7): package profile → deny → forced
 * read-only, then D1 capability filtering by the active profile's auth path,
 * then per-call strict re-validation (unknown args are rejected, never dropped).
 */
import { z } from 'zod';
import type { ToolAnnotationSet, ToolContext, ToolResult, ToolSpec } from './define.js';
import { errorResult } from './result.js';
import { InstagramError } from '../core/types.js';
import type { IgRequestFn, Logger, ResolvedProfile, Settings } from '../core/types.js';
import { resolveProfile, withAccount } from '../core/config.js';
import { toInstagramError } from '../core/errors.js';
import type { Clock } from '../core/clock.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// --- PACKAGES manifest ------------------------------------------------------

/** One package's manifest entry: its name and the tools tagged with it. */
export interface PackageManifest {
  name: string;
  tools: ToolSpec[];
}

/**
 * Group tools by their `package` tag into the PACKAGES manifest. Pure and
 * deterministic: packages are returned in ascending name order, and each
 * package's tools keep their input order. Grouping *by* the tag makes the
 * "every spec matches its manifest entry" invariant hold by construction.
 *
 * @throws InstagramError `kind: 'validation'` for a spec with an empty package.
 */
export function buildManifest(tools: ToolSpec[]): PackageManifest[] {
  const groups = new Map<string, ToolSpec[]>();
  for (const spec of tools) {
    const pkg = typeof spec.package === 'string' ? spec.package.trim() : '';
    if (pkg === '') {
      throw new InstagramError(
        `Tool '${spec.name}' has an empty package tag; every ToolSpec must declare a non-empty package.`,
        { kind: 'validation' },
      );
    }
    const list = groups.get(pkg) ?? [];
    list.push(spec);
    groups.set(pkg, list);
  }

  return [...groups.keys()].sort().map((name) => ({ name, tools: groups.get(name) ?? [] }));
}

// --- Package selection ------------------------------------------------------

/**
 * Package profiles for `IG_TOOL_PACKAGES` (architecture §3/§4). Each lists the
 * curated package universe for that profile; selection intersects it with the
 * packages actually present in the manifest, so a profile may name a package
 * that has not shipped yet without error. `all` is handled separately (every
 * package in the manifest). For v1 only `account`, `media`, `insights` exist —
 * all three sit in `core`.
 */
export const PACKAGE_PROFILES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  core: ['account', 'media', 'publishing', 'comments', 'insights'],
  reader: ['account', 'media', 'insights', 'comments', 'discovery'],
  publisher: ['account', 'media', 'publishing', 'comments'],
});

/** Split a comma list into trimmed, lowercased, non-empty tokens. */
function parseList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the active package names and the forced-read-only package names from
 * the environment, per architecture §3:
 *   `IG_TOOL_PACKAGES` (profile `core` default | `reader` | `publisher` | `all`,
 *   or an explicit comma list of package names)
 *   → minus `IG_PACKAGES_DENY`
 *   → `IG_PACKAGES_READONLY` marked read-only (applied at registration).
 *
 * An explicit list naming a package absent from the manifest is a hard error.
 * Deny / read-only names are tolerated when absent (removing or masking a
 * package that is not present is harmless and keeps CC-CFG-7 forward-compatible).
 *
 * @throws InstagramError `kind: 'validation'` for an unknown explicit package.
 */
export function selectPackages(
  manifest: PackageManifest[],
  env: NodeJS.ProcessEnv,
): { active: Set<string>; readonly: Set<string> } {
  const available = new Set(manifest.map((p) => p.name));
  const raw = (env.IG_TOOL_PACKAGES ?? '').trim();
  const selection = raw === '' ? 'core' : raw;
  const lower = selection.toLowerCase();

  let active: Set<string>;
  if (!selection.includes(',') && (lower === 'all' || lower in PACKAGE_PROFILES)) {
    if (lower === 'all') {
      active = new Set(available);
    } else {
      const profile = PACKAGE_PROFILES[lower] ?? [];
      active = new Set(profile.filter((p) => available.has(p)));
    }
  } else {
    // Explicit comma-separated list of package names.
    const names = parseList(selection);
    for (const name of names) {
      if (!available.has(name)) {
        throw new InstagramError(
          `IG_TOOL_PACKAGES names unknown package '${name}'; available packages: ` +
            `${[...available].sort().join(', ') || '(none)'} ` +
            `(or use a profile: core | reader | publisher | all).`,
          { kind: 'validation' },
        );
      }
    }
    active = new Set(names);
  }

  for (const name of parseList(env.IG_PACKAGES_DENY)) active.delete(name);

  const readonly = new Set(parseList(env.IG_PACKAGES_READONLY));
  return { active, readonly };
}

// --- Registration -----------------------------------------------------------

export interface RegisterToolsDeps {
  server: McpServer;
  tools: ToolSpec[];
  profiles: ResolvedProfile[];
  defaultProfileName: string;
  settings: Settings;
  clock: Clock;
  log: Logger;
  /** The one network seam, per profile. Injected by the composition root so the
   *  registry stays decoupled from core/http + core/auth. */
  makeRequest: (profile: ResolvedProfile) => IgRequestFn;
  env?: NodeJS.ProcessEnv; // defaults to process.env
}

/**
 * Structural view of the one `McpServer` method the registry drives. The tool
 * callback is re-validated internally, so its args are `unknown` here and the
 * result is our {@link ToolResult} (a subset of the SDK `CallToolResult`).
 * `deps.server` is reached through this shape so tests can pass a small stub.
 */
interface ToolRegistrar {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: z.ZodRawShape;
      outputSchema?: z.ZodRawShape;
      annotations?: ToolAnnotationSet;
    },
    cb: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>,
  ): unknown;
}

/**
 * The framework-injected multi-account selector added to every tool's input
 * schema (architecture §6). Optional; absent means the default profile.
 */
const accountField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Name of the configured account profile to operate as (multi-account). Omit to use the ' +
      'default profile (IG_ACTIVE_PROFILE).',
  );

/** Build the human message for a strict-schema rejection (CC-CFG-6). */
function validationMessage(spec: ToolSpec, error: z.ZodError, validKeys: string[]): string {
  const unknownKeys: string[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') unknownKeys.push(...issue.keys);
  }
  const valid = validKeys.join(', ') || '(none)';
  if (unknownKeys.length > 0) {
    return `Unknown argument(s) [${unknownKeys.join(', ')}] for tool '${spec.name}'; valid arguments: ${valid}.`;
  }
  const detail = error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return `Invalid arguments for tool '${spec.name}': ${detail}.`;
}

/** Register one surviving tool on the server with its strict per-call wrapper. */
function registerOne(registrar: ToolRegistrar, deps: RegisterToolsDeps, spec: ToolSpec): void {
  const inputSchema: z.ZodRawShape = { ...spec.input, account: accountField };
  const strictSchema = z.object(inputSchema).strict();
  const validKeys = Object.keys(inputSchema);

  const config: {
    title?: string;
    description?: string;
    inputSchema?: z.ZodRawShape;
    outputSchema?: z.ZodRawShape;
    annotations?: ToolAnnotationSet;
  } = {
    title: spec.title,
    description: spec.description,
    inputSchema,
    annotations: spec.annotations,
  };
  if (spec.output !== undefined) config.outputSchema = spec.output;

  const cb = async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
    // 1. Strict parse — unknown args are a validation error, never dropped.
    const parsed = strictSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return errorResult(
        new InstagramError(validationMessage(spec, parsed.error, validKeys), {
          kind: 'validation',
          cause: parsed.error,
        }),
      );
    }
    const args = parsed.data as Parameters<typeof spec.handler>[0];

    // 2. Resolve the profile inside the active-account context so nested code
    //    (currentAccount()) sees the right account.
    const name = args.account ?? deps.defaultProfileName;
    return withAccount(name, async () => {
      try {
        const profile = resolveProfile(deps.profiles, name);

        // 3. Call-time capability guard (defense in depth — filtering already
        //    excluded a mismatched tool at registration).
        if (spec.paths !== undefined && !spec.paths.includes(profile.authPath)) {
          return errorResult(
            new InstagramError(
              `Tool '${spec.name}' is not available on the '${profile.authPath}' auth path ` +
                `(profile '${name}'); it requires ${spec.paths.join(' or ')}.`,
              { kind: 'permission' },
            ),
          );
        }

        // 4. Build the per-call context (the request seam is injected).
        const ctx: ToolContext = {
          req: deps.makeRequest(profile),
          settings: deps.settings,
          clock: deps.clock,
          profile,
          log: deps.log.child({ tool: spec.name, account: name }),
        };

        // 5. Run the handler; it returns a ready ToolResult.
        return await spec.handler(args, ctx);
      } catch (err) {
        // 6. Handlers may throw; the registry renders it as an error result.
        return errorResult(toInstagramError(err));
      }
    });
  };

  registrar.registerTool(spec.name, config, cb);
}

/**
 * Register every surviving tool on the server: build the manifest, resolve the
 * active packages / forced-read-only set, filter by the active profile's auth
 * path (D1) and by forced read-only, and register the rest. Returns the names
 * actually registered (for logging + tests) and the manifest.
 */
export function registerTools(deps: RegisterToolsDeps): {
  registered: string[];
  manifest: PackageManifest[];
} {
  const env = deps.env ?? process.env;
  const manifest = buildManifest(deps.tools);
  const { active, readonly } = selectPackages(manifest, env);
  const activeProfile = resolveProfile(deps.profiles, deps.defaultProfileName);
  const registrar = deps.server as unknown as ToolRegistrar;

  const registered: string[] = [];
  for (const pkg of manifest) {
    if (!active.has(pkg.name)) continue;
    const forceReadonly = readonly.has(pkg.name);
    for (const spec of pkg.tools) {
      // D1 capability filtering: `paths === undefined` means both auth paths.
      if (spec.paths !== undefined && !spec.paths.includes(activeProfile.authPath)) continue;
      // Forced read-only: drop any non-read-only tool in the package.
      if (forceReadonly && spec.annotations.readOnlyHint !== true) continue;
      registerOne(registrar, deps, spec);
      registered.push(spec.name);
    }
  }

  return { registered, manifest };
}
