/**
 * Deterministic README section generators, shared by the docs-sync test and the
 * `gen:readme` script. Pure functions only: inputs in, Markdown string out — no
 * filesystem access and no imports of README/.env.example content. Keeping this
 * module side-effect-free lets the drift test and the generator script reuse the
 * exact same rendering, so the bytes they compare are guaranteed identical.
 */
import type { ToolSpec } from '../../src/mcp/define.js';

/**
 * Escape a value for safe, correctly-rendered use inside a Markdown table cell:
 * collapse newlines, HTML-escape `&<>` (so tokens like `<handle>` are not eaten
 * as tags), and backslash-escape the cell separator `|`. Order matters — `&`
 * first so the entities introduced afterwards are not double-escaped.
 */
function escapeCell(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * First sentence of a description: everything up to and including the first
 * sentence-final `.`, `!`, or `?` (one followed by whitespace or end-of-string).
 * Periods inside tokens like `business_discovery.username` are not sentence ends
 * because they are followed by a letter, so they never split the summary.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /[.!?](\s|$)/.exec(trimmed);
  return match === null ? trimmed : trimmed.slice(0, match.index + 1);
}

/** `Read` when the tool declares `readOnlyHint`, otherwise `Write` (every
 * mutating publishing/comments tool lacks the hint, so it renders `Write`). */
function accessOf(tool: ToolSpec): 'Read' | 'Write' {
  return tool.annotations.readOnlyHint === true ? 'Read' : 'Write';
}

/** Auth-path capability: the joined `paths`, or `both` when unrestricted. */
function authPathsOf(tool: ToolSpec): string {
  return tool.paths === undefined || tool.paths.length === 0 ? 'both' : tool.paths.join(', ');
}

/**
 * Render the tool catalog as a Markdown table. Rows are ordered by package in
 * the order packages first appear in `tools` (the registry order when passed
 * `allTools`), then by tool name — a stable ordering that depends only on the
 * input array.
 */
export function renderToolTable(tools: ToolSpec[]): string {
  const packageOrder: string[] = [];
  for (const tool of tools) {
    if (!packageOrder.includes(tool.package)) packageOrder.push(tool.package);
  }
  const rank = new Map(packageOrder.map((pkg, index) => [pkg, index] as const));

  const sorted = [...tools].sort((a, b) => {
    const rankA = rank.get(a.package) ?? 0;
    const rankB = rank.get(b.package) ?? 0;
    if (rankA !== rankB) return rankA - rankB;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const header = '| Tool | Package | Auth paths | Access | Summary |';
  const divider = '| --- | --- | --- | --- | --- |';
  const rows = sorted.map((tool) => {
    const name = `\`${tool.name}\``;
    const summary = escapeCell(firstSentence(tool.description));
    return `| ${name} | ${tool.package} | ${authPathsOf(tool)} | ${accessOf(tool)} | ${summary} |`;
  });

  return [header, divider, ...rows].join('\n');
}

/**
 * Render the `.env.example` variable catalog as a Markdown table (Variable,
 * Default, Description), in file order. Only `KEY=value  # description` lines
 * become rows; blank lines, group-header comments (`# --- ... ---`), and other
 * pure-comment lines (including the commented `# IG_PROFILE_<NAME>_*` example)
 * are ignored. The `.env.example` text is passed in — this module never reads it.
 */
export function renderEnvCatalog(envExampleText: string): string {
  const header = '| Variable | Default | Description |';
  const divider = '| --- | --- | --- |';
  const rows: string[] = [];

  for (const rawLine of envExampleText.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(rawLine.trim());
    if (match === null) continue;
    const key = match[1] ?? '';
    const rest = match[2] ?? '';
    const hashIndex = rest.indexOf('#');
    const value = (hashIndex === -1 ? rest : rest.slice(0, hashIndex)).trim();
    const description = hashIndex === -1 ? '' : rest.slice(hashIndex + 1).trim();
    const defaultCell = value === '' ? '' : `\`${value}\``;
    rows.push(`| \`${key}\` | ${defaultCell} | ${escapeCell(description)} |`);
  }

  return [header, divider, ...rows].join('\n');
}
