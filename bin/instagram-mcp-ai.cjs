#!/usr/bin/env node
'use strict';

/**
 * CommonJS launcher for instagram-mcp-ai.
 *
 * It runs before the ESM entry so it can enforce the Node floor even on
 * runtimes too old to *parse* the ESM graph (static imports load eagerly, so a
 * guard placed inside that graph could never run). Its only jobs are:
 *   1. Guard the Node major version (>= 22).
 *   2. Hand off to the built ESM entry (dist/src/index.js), which reads
 *      process.argv itself (login/doctor/refresh subcommands, else a transport).
 *
 * Intentionally tiny, dependency-free, and written in old-Node-safe syntax.
 */

var MIN_NODE_MAJOR = 22;

var major = parseInt(process.versions.node.split('.')[0], 10);
if (!Number.isNaN(major) && major < MIN_NODE_MAJOR) {
  process.stderr.write(
    'instagram-mcp-ai requires Node.js >= ' +
      MIN_NODE_MAJOR +
      ', but this runtime is ' +
      process.versions.node +
      '.\nUse a newer runtime, e.g.: nvm install 22 && nvm use 22\n',
  );
  process.exit(1);
}

// Resolve the built ESM entry (dist/src/index.js) to a file:// URL so dynamic
// import works regardless of the platform path separator, then let it run.
var entryUrl = require('node:url').pathToFileURL(
  require('node:path').join(__dirname, '..', 'dist', 'src', 'index.js'),
).href;

import(entryUrl).catch(function (err) {
  process.stderr.write(
    'instagram-mcp-ai failed to load: ' + (err && err.stack ? err.stack : String(err)) + '\n',
  );
  process.exit(1);
});
