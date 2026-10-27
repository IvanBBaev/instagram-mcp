/**
 * Icon gate. One repo-owned asset — `docs/assets/icon.png` — feeds three
 * channels, each in the form that channel's schema demands:
 *
 *   - `serverInfo.icons` (MCP `initialize`): an inline `data:` URI embedded in
 *     `src/mcp/icon.ts`, so the handshake never points a client at a URL;
 *   - `server.json` (MCP registry, schema 2025-12-11): an HTTPS URL, the only
 *     form that schema accepts — the GitHub Pages copy of the same file;
 *   - `manifest.json` (MCPB 0.3): a bundle-relative `icon.png`, which
 *     `scripts/build-mcpb.sh` copies into the bundle root.
 *
 * Any of the three can drift from the asset silently (a stale base64 string, a
 * renamed Pages path, a build script that stops copying the file), so this file
 * ties all of them back to the bytes on disk. Runs from the repo root (cwd);
 * strictly read-only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { SERVER_ICONS, SERVER_ICON_PNG_BASE64 } from '../../src/mcp/icon.js';

const repoRoot = process.cwd();
const ASSET = 'docs/assets/icon.png';
/** GitHub Pages publishes `docs/` at this base (see docs/index.html). */
const PAGES_BASE = 'https://ivanbbaev.github.io/instagram-mcp/';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const asset = readFileSync(path.join(repoRoot, ASSET));

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8')) as Record<string, unknown>;
}

test('the icon asset is a 128x128 PNG', () => {
  assert.deepEqual(asset.subarray(0, 8), PNG_SIGNATURE);
  assert.equal(asset.subarray(12, 16).toString('latin1'), 'IHDR');
  assert.equal(asset.readUInt32BE(16), 128, 'width');
  assert.equal(asset.readUInt32BE(20), 128, 'height');
});

test('serverInfo.icons embeds exactly the asset bytes as a data: URI', () => {
  assert.deepEqual(Buffer.from(SERVER_ICON_PNG_BASE64, 'base64'), asset);
  assert.deepEqual(SERVER_ICONS, [
    {
      src: `data:image/png;base64,${asset.toString('base64')}`,
      mimeType: 'image/png',
      sizes: ['128x128'],
    },
  ]);
});

test('server.json points at the Pages copy of the asset over HTTPS', () => {
  const icons = readJson('server.json').icons;
  assert.deepEqual(icons, [
    {
      src: `${PAGES_BASE}${ASSET.slice('docs/'.length)}`,
      mimeType: 'image/png',
      sizes: ['128x128'],
    },
  ]);
  // Registry schema 2025-12-11: Icon.src is an HTTPS uri of at most 255 chars.
  const src = (icons as { src: string }[])[0]?.src ?? '';
  assert.ok(src.startsWith('https://') && src.length <= 255);
});

test('manifest.json names the bundled icon, and the MCPB build copies it in', () => {
  const manifest = readJson('manifest.json');
  assert.equal(manifest.icon, 'icon.png');
  assert.deepEqual(manifest.icons, [{ src: 'icon.png', size: '128x128' }]);

  const script = readFileSync(path.join(repoRoot, 'scripts', 'build-mcpb.sh'), 'utf8');
  assert.ok(
    script.includes(`cp "$REPO/${ASSET}" "$WORK/package/icon.png"`),
    'scripts/build-mcpb.sh must copy the icon to the bundle root as icon.png',
  );
});
