/**
 * Argv discipline for the entry (Layer: cli), split out of `src/index.ts`
 * (docs/v2-analysis.md §6). `assertUsage` runs before anything else in `main`,
 * so a usage error is reported as one (exit 2), never as whatever a misread
 * line would do next (CC-PROC-71), and no refused token reaches stderr
 * unmasked (CC-PROC-208).
 */
import { createRedactor } from '../core/redact.js';
import { escapeControls } from '../core/untrusted.js';

/** The subcommands the entry routes; anything else on argv[2] is refused. */
export const SUBCOMMANDS = ['login', 'doctor', 'refresh'] as const;

export const USAGE_TEXT = `Usage:
  instagram-mcp-ai                        Start the MCP server (transport from IG_TRANSPORT).
  instagram-mcp-ai login --path <ig|fb>   Obtain and persist a long-lived token (login --help).
  instagram-mcp-ai doctor                 Health-check the active profile (exit 0 when healthy).
  instagram-mcp-ai refresh                Refresh the active profile's long-lived token.
`;

/**
 * Argv discipline for the entry, before anything else runs: a usage error must
 * be reported as one, not as whatever the misread line happens to do next.
 *
 * Without this, `instagram-mcp-ai docter` (a typo) fell through to "no
 * subcommand" and started the stdio server — a process that sits on stdin
 * waiting for JSON-RPC, which from a terminal looks like a hang — and
 * `doctor --bogus` ran the doctor with the stray token dropped, so a
 * mistyped flag was indistinguishable from a clean run. Both are refused with
 * exit 2 (the usage code the `login` parser already uses for its own unknown
 * arguments), naming the offending token. `--help`/`-h` on their own print the
 * usage and exit 0. Returns only when the line is one of the routed shapes.
 */
/**
 * How a refused argv token is named on stderr: cut at its first `=` and passed
 * through the token-shape backstop of the redactor (CC-PROC-208).
 *
 * Both refusals below echo a token the operator did not mean to pass, and a
 * launcher's stderr is not the operator's terminal: an MCP host writes it to
 * its own log file. The stray-argument refusal already dropped the value after
 * an `=`; the unknown-subcommand refusal echoed the whole token, so a client
 * config carrying `"args": ["--access-token=EAA…"]` copied the token into that
 * log. The flag part is what tells the operator what was wrong; the value is
 * the one part that could be a secret. A bare token (`args: ["EAA…"]`) has no
 * `=` to cut at, so the redactor's shape patterns are what mask it — nothing is
 * registered yet at this point, so the shapes are all it can know. Last, every
 * control character is written as a JSON escape (`\uXXXX`): the token is
 * echoed inside quotes, and an ANSI sequence or a newline in it would otherwise
 * repaint the terminal or end the refusal early and forge a line beneath it.
 */
function argvName(token: string): string {
  const eq = token.indexOf('=');
  return escapeControls(String(createRedactor()(eq === -1 ? token : token.slice(0, eq))));
}

export function assertUsage(argv: string[]): void {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined) return;
  if (subcommand === '--help' || subcommand === '-h') {
    process.stderr.write(USAGE_TEXT);
    process.exit(0);
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    process.stderr.write(
      `instagram-mcp-ai: unknown subcommand '${argvName(subcommand)}'.\n\n${USAGE_TEXT}`,
    );
    process.exit(2);
  }
  // `login` parses its own line; `doctor` and `refresh` take nothing at all.
  // Only the first stray token is named, and only as `argvName` shows it: a
  // `--flag=value` typed here is a flag no command takes, and the value after
  // the `=` is the one part of the line that could be a secret.
  const stray = rest[0];
  if (subcommand !== 'login' && stray !== undefined) {
    process.stderr.write(
      `${subcommand}: unknown argument '${argvName(stray)}'; ${subcommand} takes no arguments.\n\n${USAGE_TEXT}`,
    );
    process.exit(2);
  }
}
