/**
 * Regenerate the `tools` array of the MCPB manifest (`manifest.json`) from the
 * live tool registry.
 *
 * Run via `npm run gen:manifest`, which builds first so the COMPILED generator
 * and tool registry exist under `dist/`. This script imports those built
 * artifacts, replaces (or inserts, right after `server`) the manifest's `tools`
 * array with `renderManifestTools(allTools)`, and writes `manifest.json` back
 * through Prettier so the file stays `format:check`-clean. The drift test in
 * `test/release/mcpb-manifest.test.ts` compares against the same helper. It is
 * a plain ESM script, deliberately outside `tsconfig` (`scripts/**` is not
 * compiled).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as prettier from 'prettier';
import { allTools } from '../dist/src/tools/index.js';
import { renderManifestTools } from '../dist/test/helpers/doc-generators.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'manifest.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const tools = renderManifestTools(allTools);

let next;
if ('tools' in manifest) {
  // Assigning an existing key keeps its position in the object.
  next = { ...manifest, tools };
} else {
  // Insert after `server`, the position the MCPB schema documents it in.
  next = {};
  for (const [key, value] of Object.entries(manifest)) {
    next[key] = value;
    if (key === 'server') next.tools = tools;
  }
  if (!('tools' in next)) next.tools = tools;
}

const options = (await prettier.resolveConfig(manifestPath)) ?? {};
const text = await prettier.format(JSON.stringify(next, null, 2), {
  ...options,
  filepath: manifestPath,
});
writeFileSync(manifestPath, text);

console.log(`manifest.json tools array regenerated (${tools.length} tools).`);
