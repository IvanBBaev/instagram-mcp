/**
 * Workflow skills over the MCP Skills extension (`io.modelcontextprotocol/skills`,
 * SEP-2640). The same four workflows `mcp/prompts.ts` ships as prompts, written
 * as Agent Skills (`skills/<name>/SKILL.md` in the package) so a skills-aware
 * client can discover them with `skills/list`, fetch one with `skills/get` and
 * read its files as `skill://<name>/<path>` resources.
 *
 * Gated exactly like the prompts: a skill is served only when every
 * `instagram_*` tool its files name is exposed by this server, so a client
 * never gets a workflow that points at a tool it cannot call. The tool names
 * are scraped from the skill text rather than declared a second time; the
 * test suite pins every scraped name to a real tool and each skill's set to
 * its prompt's `tools`.
 *
 * The bundle is read lazily, once per process, on the first skills request: the
 * extension's handlers are async, so `attachSkills` itself stays synchronous and
 * does no I/O, and a client that never asks for skills costs nothing.
 *
 * `SkillsExtension.attach` is marked experimental in SDK 2.4.0 ("how an
 * extension is wired to a server may change in a minor release").
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import {
  SkillsExtension,
  type Skill,
  type SkillResourceEntry,
  type SkillSource,
} from '@modelcontextprotocol/server/ext/skills';
import { nodeSkillFiles } from '@modelcontextprotocol/server/ext/skills/node';

/** The packaged skill folder: `<package>/skills`, from `dist/src/mcp/`. */
export const SKILLS_ROOT = fileURLToPath(new URL('../../../skills', import.meta.url));

const SKILL_SCHEME = 'skill://';
const TOOL_NAME = /\binstagram_[a-z0-9_]+\b/g;

/** One loaded skill: its catalog entry, its files' text by URI, the tools it names. */
export interface BundledSkill {
  skill: Skill;
  files: ReadonlyMap<string, string>;
  tools: readonly string[];
}

/**
 * Load and validate every skill under `root` (strict: a frontmatter problem is
 * an error, not a warning) and read each file's text. Entries come back sorted
 * by URI.
 */
export async function loadBundledSkills(root: string = SKILLS_ROOT): Promise<BundledSkill[]> {
  const catalog = await SkillsExtension.load(nodeSkillFiles(root), { strict: true });
  return Promise.all(
    catalog.entries.map(async (skill) => {
      const files = new Map<string, string>();
      // A catalog built from files always lists them; 'dynamic' is for custom sources.
      for (const resource of skill.resources as readonly SkillResourceEntry[]) {
        const path = resource.uri.slice(SKILL_SCHEME.length).split('/');
        files.set(resource.uri, await readFile(join(root, ...path), 'utf8'));
      }
      const tools = new Set<string>();
      for (const text of files.values()) {
        for (const match of text.matchAll(TOOL_NAME)) tools.add(match[0]);
      }
      return { skill, files, tools: [...tools].sort() };
    }),
  );
}

let bundled: Promise<BundledSkill[]> | undefined;

/** The packaged skills, loaded once per process. */
export function bundledSkills(): Promise<BundledSkill[]> {
  bundled ??= loadBundledSkills();
  return bundled;
}

/**
 * A `SkillSource` over `load()` that serves only the skills whose every named
 * tool is in `registered`. A hidden skill is absent from `skills/list`, and
 * `skills/get` and resource reads treat it as unknown.
 */
export function gatedSkillSource(
  registered: readonly string[],
  load: () => Promise<BundledSkill[]> = bundledSkills,
): SkillSource {
  const exposed = new Set(registered);
  const visible = async (): Promise<BundledSkill[]> =>
    (await load()).filter((entry) => entry.tools.every((tool) => exposed.has(tool)));
  return {
    list: async () => ({ skills: (await visible()).map((entry) => entry.skill) }),
    get: async (uri) => (await visible()).find((entry) => entry.skill.uri === uri)?.skill,
    read: async (uri) => {
      for (const entry of await visible()) {
        const text = entry.files.get(uri);
        if (text !== undefined) return { text, mimeType: 'text/markdown' };
      }
      return undefined;
    },
  };
}

/**
 * Attach the Skills extension to `server`, gated by the tools `registerTools`
 * exposed. Must run before the server connects. A no-op for anything that is
 * not a real `McpServer`: `registerTools` accepts McpServer-shaped stubs in unit
 * tests, and the extension needs the real server's request plumbing.
 */
export function attachSkills(server: McpServer, registered: readonly string[]): void {
  if (!(server instanceof McpServer)) return;
  new SkillsExtension({ source: gatedSkillSource(registered) }).attach(server);
}
