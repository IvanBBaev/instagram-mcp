/**
 * Docs gate for the four operator-facing guides that no test guarded:
 * `docs/setup-guide.md`, `docs/troubleshooting.md`, `docs/mcpb-install.md` and
 * `docs/plugin-install.md`.
 *
 * `docs-sync.test.ts` ties the README catalogs to `allTools` and `.env.example`,
 * and `env-catalog.test.ts` ties `.env.example` back to the source. Both stop at
 * the README. The guides are where an operator actually follows instructions —
 * they name env vars to set, scopes to request in the Meta app, and tools to call
 * when something looks wrong — and every one of those names is a promise that
 * rots silently when the code moves.
 *
 * Three classes are checked, each in the direction that helps the operator:
 *
 *   - **A phantom env var**: a knob a guide tells you to set that nothing reads.
 *     `IG_FB_ACCESS_TOKEN` was exactly this in the manifests (see
 *     `env-catalog.test.ts`); the guides are the other place it survived. A guide
 *     may still NAME one, but only inside the sentence that denies it exists —
 *     `docs/plugin-install.md` teaches that mistake, which is the opposite of
 *     instructing it. Same shape as the rejected-flag rule at the bottom.
 *   - **A phantom tool**: a guide telling you to call something the server does
 *     not register. Renaming a tool passes every other suite in this repo while
 *     leaving the troubleshooting steps pointing at a name that no longer exists.
 *   - **A phantom command or flag**: a step telling the operator to run an npm
 *     script or pass a CLI flag that does not exist. This is the class an operator
 *     hits first, before any credential is even configured.
 *   - **A scope list that disagrees with the code**: §5 of the setup guide tells
 *     the operator which scopes to add to their Meta app, and states that they
 *     are what `login` requests. If the two drift, the operator either grants a
 *     permission the server never asks for or misses one it needs — and the
 *     failure surfaces as an opaque Graph permission error much later.
 *
 * The scope check imports `DEFAULT_SCOPES` rather than scanning for it. That is not
 * a self-comparison: the constant is one side of the pair and the guide read off
 * disk is the other, so the assertion still fails when either moves without the
 * other. It used to be a source scan because the table was private to `login.ts`;
 * it is now a shared module (`src/cli/scopes.ts`) that `doctor` reads too, so the
 * scan bought nothing but a parser that breaks when the declaration is reformatted.
 *
 * `docs/plugin-install.md` joined the list on 2026-09-23. It is the sibling of
 * `docs/mcpb-install.md` — the same operator, the same decision, the other of the
 * two install routes — and it was left out silently, so nothing checked the env
 * names, tool names, npm scripts or flags it spells. Bringing it in cost three
 * named exemptions and one new rule, all below. None of them weakens what the
 * other three guides were already held to, and `--scope` is why the foreign-flag
 * table now records WHICH guide an exemption is for.
 *
 * The test process runs from the repo root, so every path resolves from cwd.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { allTools } from '../src/tools/index.js';
import { DEFAULT_SCOPES } from '../src/cli/scopes.js';

/** The operator-facing guides, none of which had a drift guard before this file. */
const GUIDES = [
  'docs/setup-guide.md',
  'docs/troubleshooting.md',
  'docs/mcpb-install.md',
  'docs/plugin-install.md',
] as const;

/**
 * `instagram_*` tokens that are neither a tool nor a scope. Kept as an explicit
 * list with a reason each, so a genuinely stale name cannot hide behind a blanket
 * "well, some tokens are not tools".
 */
const NON_TOOL_NON_SCOPE_TOKENS: ReadonlyMap<string, string> = new Map([
  [
    'instagram_business_account',
    'Graph field on a Page node, read during fb-login account resolution',
  ],
  [
    'instagram_business_manage_messages',
    'Meta app scope that Path A supports but `login` deliberately does not request — ' +
      'M6 messaging is DEFER (docs/messaging.md); reachable with `login --scopes`',
  ],
  [
    'instagram_manage_messages',
    'the same deliberately unrequested messaging scope under its Path B name',
  ],
]);

/** The first capture group of every match, skipping any that did not capture. */
function captured(matches: IterableIterator<RegExpMatchArray>): string[] {
  return [...matches].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

/**
 * Flags in the guides that belong to another program, with the program named. Any
 * other `--flag` must be one the shipped CLI actually parses.
 *
 * `only` confines an entry to one guide, and `--scope` is why it exists: in
 * `docs/plugin-install.md` it is `claude plugin install`'s scope selector, while in
 * `docs/setup-guide.md` §7 it is the near miss `login` refuses with exit 2 and may
 * appear ONLY inside that refusal. A table keyed on the flag alone would have had to
 * pick one meaning, and picking "foreign" would have switched §7's rule off for every
 * guide at once.
 */
const FOREIGN_FLAGS: ReadonlyMap<string, { readonly owner: string; readonly only?: string }> =
  new Map([
    ['--omit', { owner: '`npm install`' }],
    ['--plugin-dir', { owner: 'the `claude` CLI, which side-loads one plugin directory' }],
    ['--plugin-url', { owner: 'the `claude` CLI, the `--plugin-dir` sibling' }],
    ['--scope', { owner: '`claude plugin install`', only: 'docs/plugin-install.md' }],
  ]);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * An `IG_*` token, anchored so it cannot start mid-identifier. The same
 * lookbehind is settled in `test/env-catalog.test.ts` for the same reason, and
 * this file drifted from it: unanchored, `DOTENV_CONFIG_DEBUG` in
 * `docs/troubleshooting.md` reads as `IG_DEBUG` and the guide gets accused of
 * naming a phantom variable, while `XDG_CONFIG_HOME` in `.env.example` would
 * quietly enter the allowlist as `IG_HOME` and let a real phantom through.
 * Both halves of the gate scrape with it, because over-broad on the allowlist
 * side is the direction that fails open.
 */
const IG_TOKEN = /(?<![A-Za-z0-9_])IG_[A-Z][A-Z0-9_]*/g;

/**
 * `IG_*` names a guide may spell although nothing reads them, mapped to the phrase
 * that has to be on the same line. The mention must be a DENIAL:
 * `docs/plugin-install.md` names `IG_FB_ACCESS_TOKEN` to say it does not exist and
 * that a manifest spelling it describes a variable no code reads. Exempting the name
 * outright would also exempt the next line that told somebody to set it, so the
 * exemption is positional — exactly the rejected-flag rule at the bottom of this file.
 */
const DENIED_ENV_NAMES: ReadonlyMap<string, string> = new Map([
  ['IG_FB_ACCESS_TOKEN', 'There is no'],
]);

/** Every `IG_*` token named anywhere in `.env.example`. */
function envExampleNames(): ReadonlySet<string> {
  return new Set(read('.env.example').match(IG_TOKEN) ?? []);
}

/** The scope table as the shipped CLIs use it, one entry per auth path. */
function defaultScopes(): readonly (readonly [string, readonly string[]])[] {
  const table = Object.entries(DEFAULT_SCOPES);
  assert.ok(table.length > 0, 'DEFAULT_SCOPES declares no auth path at all');
  return table;
}

/**
 * The body of the "Required scopes" section, located by its heading text rather
 * than its number so renumbering the guide does not silently empty the guard.
 */
function requiredScopesSection(): string {
  const guide = read('docs/setup-guide.md');
  const heading = /^## .*Required scopes.*$/m.exec(guide);
  assert.notEqual(heading, null, 'setup-guide.md no longer has a "Required scopes" section');
  const rest = guide.slice((heading?.index ?? 0) + (heading?.[0].length ?? 0));
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The scopes that section lists for one auth path, in document order. The path is
 * matched on its name in backticks, so re-wording the prose around it does not
 * break the guard, and a renamed path does.
 */
function guideScopes(path: string): readonly string[] {
  const section = requiredScopesSection();
  const heading = section.indexOf(`\`${path}\``);
  assert.notEqual(heading, -1, `setup-guide.md "Required scopes" no longer names \`${path}\``);
  const rest = section.slice(heading);
  const next = rest.search(/\n\*\*Path /);
  const block = next === -1 ? rest : rest.slice(0, next);
  return captured(block.matchAll(/^- `([a-z_]+)`/gm));
}

test('the operator guides name only env vars the server actually reads', () => {
  const known = envExampleNames();
  const denied = new Set<string>();
  for (const guide of GUIDES) {
    for (const [index, line] of read(guide).split('\n').entries()) {
      for (const name of new Set(line.match(IG_TOKEN) ?? [])) {
        if (known.has(name)) continue;
        const where = `${guide}:${index + 1}`;
        const denial = DENIED_ENV_NAMES.get(name);
        assert.ok(
          denial !== undefined,
          `${where} tells the operator to set ${name}, which is absent from .env.example — ` +
            `either it is a phantom variable or .env.example is missing a real knob.`,
        );
        assert.ok(
          line.includes(denial),
          `${where} names ${name}, which nothing reads, on a line that does not deny it ` +
            `exists. A phantom variable belongs only inside the sentence that refuses it.`,
        );
        denied.add(name);
      }
    }
  }

  // The other direction (docs/corner-cases.md CC-PROC-139). An entry whose guide
  // stopped denying the name exempts a variable nobody decided to exempt any more —
  // including the case where `.env.example` grew it and the denial became a lie.
  assert.deepEqual(
    [...DENIED_ENV_NAMES.keys()].filter((name) => !denied.has(name)),
    [],
    'these DENIED_ENV_NAMES entries match no denial in any guide. Drop the entry, or find out ' +
      'why the guide stopped denying the name — if .env.example now defines it, the guide is ' +
      'denying a variable that exists',
  );
});

test('the operator guides name only tools the server actually registers', () => {
  const toolNames = new Set(allTools.map((spec) => spec.name));
  const scopes = new Set(defaultScopes().flatMap(([, list]) => [...list]));
  const used = new Set<string>();
  for (const guide of GUIDES) {
    for (const token of new Set(read(guide).match(/instagram_[a-z_]+/g) ?? [])) {
      if (scopes.has(token)) continue;
      if (NON_TOOL_NON_SCOPE_TOKENS.has(token)) {
        used.add(token);
        continue;
      }
      assert.ok(
        toolNames.has(token),
        `${guide} refers to \`${token}\`, which is neither a registered tool, a scope ` +
          `\`login\` requests, nor a listed exception. A tool rename left the guide behind.`,
      );
    }
  }

  // The other direction (docs/corner-cases.md CC-PROC-139). The scope check runs
  // first on purpose: an entry the table calls "deliberately not requested" that
  // `login` has since started requesting stops matching here, and that is drift —
  // the reason written next to it is no longer true.
  assert.deepEqual(
    [...NON_TOOL_NON_SCOPE_TOKENS.keys()].filter((token) => !used.has(token)),
    [],
    'these NON_TOOL_NON_SCOPE_TOKENS entries match nothing in the guides. Drop the entry, or ' +
      'find out why — a token that became a real scope or tool no longer needs an exception, ' +
      'and a guide that stopped naming one never needed it',
  );
});

test('setup-guide §5 lists exactly the scopes `login` requests, per path', () => {
  for (const [path, scopes] of defaultScopes()) {
    assert.deepStrictEqual(
      guideScopes(path),
      [...scopes],
      `setup-guide.md §5 and DEFAULT_SCOPES disagree for \`${path}\`. The guide is what the ` +
        `operator pastes into the Meta app, so a drift here costs a failed call much later.`,
    );
  }
});

test('the operator guides run only npm scripts that exist', () => {
  const scripts = new Set(
    Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>),
  );
  for (const guide of GUIDES) {
    for (const [, name] of read(guide).matchAll(/npm run ([a-z:_-]+)/g)) {
      assert.ok(
        name !== undefined && scripts.has(name),
        `${guide} tells the operator to run \`npm run ${name}\`, which package.json ` +
          `does not define. The step fails on the operator's first attempt.`,
      );
    }
  }
});

test('the operator guides pass only flags the CLI actually parses', () => {
  const loginSource = read('src/cli/login.ts');
  const declared = new Set(captured(loginSource.matchAll(/'(--[a-z-]+)'/g)));
  // `doctor` contributes nothing today, and that is asserted rather than left to
  // an empty loop. Measured 2026-09-23: `src/cli/doctor.ts` holds no `'--flag'`
  // literal and reads no `process.argv` — it takes no arguments at all. Sweeping
  // it anyway therefore looked like coverage while adding none, and the day
  // `doctor` grows its first flag the silent version would have started feeding
  // `declared` from a lexical sweep without anyone deciding whether the parser
  // ACCEPTS those flags or is written to REFUSE them. That is the distinction the
  // `NEAR_MISSES` subtraction below exists for, and it is `login`-specific. So
  // this fails instead, and its failure is the prompt to make that decision.
  const doctorFlags = captured(read('src/cli/doctor.ts').matchAll(/'(--[a-z-]+)'/g));
  assert.deepEqual(
    doctorFlags,
    [],
    'src/cli/doctor.ts now spells command-line flags. Decide which of them the command really ' +
      'parses (rather than names in a message), feed those into `declared`, and give the ' +
      "refused ones the same subtraction `login`'s NEAR_MISSES table gets",
  );

  // A lexical sweep of the source cannot tell a flag the parser ACCEPTS from one it
  // is written to REFUSE. `login`'s `NEAR_MISSES` table spells three rejected
  // slips as string literals — `--scope`, `--auth-path`, `--auth-mode` — so until
  // 2026-09-23 they were in `declared`, and a guide telling the operator to pass
  // `--auth-mode` passed this gate while the command it documents exits 2. The
  // table's keys are subtracted back out, and a guide may still SHOW them, but only
  // inside the refusal line: quoting `login: unknown argument '--scope' …` is how
  // `docs/setup-guide.md` §7 teaches the mistake, and that is the opposite of
  // instructing it.
  const rejected = new Set(captured(loginSource.matchAll(/\['(--[a-z-]+)', '--[a-z-]+'\]/g)));
  assert.ok(rejected.size > 0, 'the NEAR_MISSES table moved — this subtraction now does nothing');
  for (const flag of rejected) {
    assert.ok(declared.delete(flag), `${flag} is a near miss the sweep above never picked up`);
  }

  const foreignSeen = new Set<string>();
  for (const guide of GUIDES) {
    const lines = read(guide).split('\n');
    for (const [index, line] of lines.entries()) {
      for (const flag of new Set(line.match(/(?<![-\w])--[a-z][a-z-]*/g) ?? [])) {
        const foreign = FOREIGN_FLAGS.get(flag);
        if (foreign !== undefined && (foreign.only === undefined || foreign.only === guide)) {
          foreignSeen.add(flag);
          continue;
        }
        const where = `${guide}:${index + 1}`;
        if (rejected.has(flag)) {
          assert.ok(
            line.includes('unknown argument'),
            `${where} names \`${flag}\`, which \`login\` refuses with exit 2. Show it only ` +
              `inside the refusal it produces, never as a step the operator is told to run.`,
          );
          continue;
        }
        assert.ok(
          declared.has(flag),
          `${where} documents \`${flag}\`, which no CLI in src/cli parses and which is not ` +
            `listed as another program's flag. A renamed flag left the guide behind.`,
        );
      }
    }
  }

  // The other direction (docs/corner-cases.md CC-PROC-139), and a tripwire under the
  // scrape itself: if the walk above ever stopped reading the guides, every assertion
  // inside it would pass vacuously and this is the one that would not.
  assert.deepEqual(
    [...FOREIGN_FLAGS.keys()].filter((flag) => !foreignSeen.has(flag)),
    [],
    'these FOREIGN_FLAGS entries match no flag in the guide they exempt. Drop the entry, or ' +
      'find out why the guide stopped naming it — an `only` entry also stops matching when ' +
      'the flag moves to a different guide, where its owner may not be the same program',
  );
});
