/**
 * Tool-package barrel (Layer 3). Aggregates every domain package's read-only
 * tool surface into one ordered `ToolSpec[]` for `mcp/registry.ts` to register.
 * Adding a package = one import + one spread here (keep the array order stable
 * so the exposed tool list is deterministic).
 *
 * Import boundary: tool packages only — never `api/*`, `core/http`, or `mcp/*`
 * beyond the shared `ToolSpec` type re-exported from `define.ts`.
 */
import type { ToolSpec } from '../mcp/define.js';
import { accountTools } from './account.js';
import { mediaTools } from './media.js';
import { insightsTools } from './insights.js';

/** The complete v1 read-path tool surface, in a stable, deterministic order. */
export const allTools: ToolSpec[] = [...accountTools, ...mediaTools, ...insightsTools];
