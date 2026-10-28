/**
 * Comment tool specs (Layer 3) — the `comments` package, including the media
 * comment toggle. The tools live in two modules by concern:
 * `tools/comments-read.ts` (the fenced reads) and `tools/comments-write.ts`
 * (the gated writes). This module keeps the package's public name: it exports
 * the aggregate `commentsTools`, reads first, in the order the registry and its
 * pinned tool-order tests expect.
 */
import type { ToolSpec } from '../mcp/define.js';
import { commentsReadTools } from './comments-read.js';
import { commentsWriteTools } from './comments-write.js';

/**
 * The comments surface: all twelve tools carry `package: 'comments'`, the media
 * comment toggle included (see its definition). The registry groups by tag.
 */
export const commentsTools: readonly ToolSpec[] = Object.freeze([
  ...commentsReadTools,
  ...commentsWriteTools,
]);
