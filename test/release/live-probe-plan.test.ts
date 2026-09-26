/**
 * The consent interlock in `scripts/live-probe.mjs`.
 *
 * That script is the only thing in this repository that can take an action
 * against a live account which cannot be taken back: it publishes a feed post
 * (published feed media CANNOT be deleted through the Graph API — only its
 * comments toggled) and it rotates the profile's access token, persisting the
 * new one over the old. Both are held back by nothing except a flag the operator
 * has to type. 1610 lines, no exports, and until this file nothing in the suite
 * opened it — the coverage gate did not notice, because a script no test runs is
 * a script no test can leave uncovered.
 *
 * What is asserted, and why it is asserted this way. The plan is compared
 * BETWEEN runs rather than against a list of probe names: a hardcoded list has
 * to be edited every time a probe is added, and the edit is made by whoever is
 * adding the probe — so the gate ends up ratified by the same change it exists
 * to check. A set difference cannot be satisfied that way. Adding a write probe
 * simply grows `--allow-writes`'s share; adding one to the `feed` lane grows the
 * set that `--allow-writes` must still refuse. The claims are:
 *
 *   - with no flag at all, some probes run and some are held, and every held one
 *     says which flag would release it;
 *   - `--allow-writes` releases a non-empty set, and the probes it still refuses
 *     are EXACTLY the ones the two irreversible flags release;
 *   - `--allow-feed-post` releases the permanent post and nothing the token flag
 *     releases; `--allow-token-refresh` the mirror of that;
 *   - both stronger flags also imply `--allow-writes`, so neither silently runs
 *     a read-only pass while the operator believes a post went out;
 *   - a misspelled probe, flag or auth path ends the process with a non-zero
 *     status, rather than running a plan that quietly contains less than asked.
 *
 * Nothing here reaches the network or a credential: `--dry-run` returns from
 * `main()` above the `dist/` import and above the env-file load, which is the
 * property that makes the plan readable on a machine that will never hold a
 * token. The child is fenced anyway — every inherited `IG_*` variable is dropped
 * and the config home is pointed at an empty temp directory — so a regression
 * that moved the credential read ABOVE the `--dry-run` return would fail here
 * rather than read the operator's real `~/.config/instagram-mcp-ai/`.
 *
 * `NODE_V8_COVERAGE` is set to the empty string for the child, and that is
 * load-bearing rather than tidiness. Under `npm run coverage`, c8 exports that
 * variable, `scripts/**` is in none of c8's default excludes, and a spawned
 * `live-probe.mjs` therefore lands in the report — measured at 44.84 % of
 * statements, which is a straight failure of `--check-coverage --statements=100`
 * on a file this suite has no intention of covering. Deleting the variable from
 * the child's `env` does NOT work: Node re-injects it into every child while
 * coverage is active (measured on Node v22.23.2 — an ordinary variable removed
 * the same way does disappear, this one comes back). The empty value is what
 * actually detaches the child: it writes no profile anywhere, and the script
 * leaves the report entirely. Catalogued as CC-PROC-136.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configHomeEnv } from '../helpers/config-home.js';

/** Locate the repo root: the nearest ancestor directory holding a `package.json`. */
function findRepoRoot(): string {
  const candidates: string[] = [process.cwd()];
  let dir = dirname(fileURLToPath(import.meta.url));
  let parent = dirname(dir);
  while (dir !== parent) {
    candidates.push(dir);
    dir = parent;
    parent = dirname(dir);
  }
  candidates.push(dir);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  throw new Error('could not locate repo root');
}

const REPO_ROOT = findRepoRoot();
const SCRIPT = join(REPO_ROOT, 'scripts', 'live-probe.mjs');
const SOURCE = readFileSync(SCRIPT, 'utf8');

/** An empty config home for the child, so a stray credential read finds nothing. */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'live-probe-plan-'));
after(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
});

/** The environment every child in this file runs with — see the file header. */
const CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('IG_')) delete env[key];
  }
  return { ...env, ...configHomeEnv(SANDBOX_HOME), NODE_V8_COVERAGE: '' };
})();

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the script with `args` and hand back what it printed and how it exited. */
function runProbe(...args: readonly string[]): Run {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: CHILD_ENV,
    encoding: 'utf8',
  });
  assert.equal(
    result.error,
    undefined,
    `the probe script could not be started: ${result.error?.message ?? ''}`,
  );
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Arguments every plan below is measured with, so the only variable between two
 * plans is the consent flag. Without them `feed-publish` is held back for want
 * of `--image-url` and the interlock assertions would pass for the wrong reason.
 * The URLs resolve nowhere and are never fetched: `.invalid` is reserved by RFC
 * 2606 exactly so that it cannot resolve.
 */
const BASE: readonly string[] = [
  '--image-url',
  'https://example.invalid/probe.jpg',
  '--video-url',
  'https://example.invalid/probe.mp4',
  '--discovery-username',
  'example_handle',
];

interface PlanEntry {
  name: string;
  runs: boolean;
  skipReason?: string;
}

/** The plan `--dry-run` prints, parsed into one entry per probe. */
function planOf(...args: readonly string[]): PlanEntry[] {
  const run = runProbe('--dry-run', ...BASE, ...args);
  assert.equal(run.status, 0, `--dry-run ${args.join(' ')} exited ${run.status}: ${run.stderr}`);

  const entries: PlanEntry[] = [];
  for (const line of run.stdout.split('\n')) {
    const header = /^ {2}\[(RUN |SKIP)\] (.+)$/.exec(line);
    if (header !== null) {
      entries.push({ name: header[2] ?? '', runs: header[1] === 'RUN ' });
      continue;
    }
    const reason = /^ {9}skipped : (.+)$/.exec(line);
    const current = entries.at(-1);
    if (reason !== null && current !== undefined) current.skipReason = reason[1];
  }

  // Every comparison below is between sets drawn from this scrape, and two empty
  // sets satisfy all of them. If the plan's layout changes, the file has to fail
  // here rather than go green on nothing (CC-PROC-112).
  assert.ok(
    entries.length >= 20,
    `only ${entries.length} probes were scraped out of the plan; the layout moved, and every ` +
      'set comparison in this file is vacuously true on an empty scrape',
  );
  return entries;
}

/** The names the plan marks `[RUN ]`. */
function running(plan: readonly PlanEntry[]): Set<string> {
  return new Set(plan.filter((entry) => entry.runs).map((entry) => entry.name));
}

/** `a \ b` — the members of `a` that `b` does not hold. */
function without(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  return new Set([...a].filter((name) => !b.has(name)));
}

/** Sorted, so a failure message reads the same on every run. */
function listed(names: ReadonlySet<string>): string {
  return [...names].sort().join(', ');
}

test('without a consent flag the plan holds probes back and names the flag that would release each', () => {
  const plan = planOf();

  assert.ok(running(plan).size > 0, 'a plan with nothing to run at all is not a read-only plan');

  const held = plan.filter((entry) => !entry.runs);
  assert.ok(
    held.length > 0,
    'no probe is held back on a bare run — either every gate is open, or the plan stopped ' +
      'printing the mark this file reads',
  );

  for (const entry of held) {
    const reason = entry.skipReason ?? '';
    assert.notEqual(reason, '', `${entry.name} is held back and the plan does not say why`);
    // The operator reads this line to find out what to type next. A reason that
    // names no flag ("not now", "unavailable") is a dead end, and the natural
    // response to a dead end is to reach for the flag that opens everything.
    assert.match(
      reason,
      /--[a-z][a-z-]*/,
      `${entry.name} is held back with "${reason}", which names no flag to release it`,
    );
  }
});

test('--allow-writes releases the write lanes and still refuses exactly what the irreversible flags own', () => {
  const bare = running(planOf());
  const writes = planOf('--allow-writes');
  const opened = running(writes);

  // Consent adds; it never takes away. A flag that reshuffled the plan instead
  // of extending it would make every difference below mean something else.
  assert.equal(
    listed(without(bare, opened)),
    '',
    'a probe that runs WITHOUT --allow-writes stopped running with it',
  );
  assert.ok(
    without(opened, bare).size > 0,
    '--allow-writes released nothing, so either the write lanes were already open or the flag ' +
      'no longer reaches them',
  );

  const feedOnly = without(running(planOf('--allow-feed-post')), opened);
  const tokenOnly = without(running(planOf('--allow-token-refresh')), opened);
  const stillHeld = new Set(writes.filter((entry) => !entry.runs).map((entry) => entry.name));

  // The load-bearing line of the file. `--allow-writes` is the flag an operator
  // reaches for to "let it do its thing"; what it must NOT quietly include is the
  // permanent post and the token rotation. Stating it as an equality rather than
  // two memberships also closes the other direction: a probe held back under
  // --allow-writes that NEITHER stronger flag releases is unreachable, and a
  // probe released by a stronger flag that --allow-writes already ran is a gate
  // that has stopped gating.
  //
  // What the equality alone cannot see, because both of its sides are read out of
  // the same binary: a gate that collapses BOTH. Measured on 2026-09-23 — rewrite
  // the feed lane's gate to read `allowWrites` and this assertion still passes
  // (`feedOnly` empties, `stillHeld` loses the same name), while the next test's
  // `feedOnly.size > 0` fails. The two tests are one interlock; neither half is
  // the whole of it.
  assert.equal(
    listed(stillHeld),
    listed(new Set([...feedOnly, ...tokenOnly])),
    'the probes --allow-writes refuses are no longer the probes the two irreversible flags own',
  );

  for (const entry of writes.filter((probe) => !probe.runs)) {
    assert.match(
      entry.skipReason ?? '',
      /--allow-(feed-post|token-refresh)/,
      `under --allow-writes, ${entry.name} is held back with a reason that names neither ` +
        'irreversible flag',
    );
  }
});

test('each irreversible flag releases its own probes and none that the other one releases', () => {
  const writes = running(planOf('--allow-writes'));
  const feed = running(planOf('--allow-feed-post'));
  const token = running(planOf('--allow-token-refresh'));

  const feedOnly = without(feed, writes);
  const tokenOnly = without(token, writes);

  assert.ok(feedOnly.size > 0, '--allow-feed-post releases nothing --allow-writes did not already');
  assert.ok(
    tokenOnly.size > 0,
    '--allow-token-refresh releases nothing --allow-writes did not already',
  );

  // The two consents are for two different irreversible acts, and consenting to
  // one is not consent to the other: an operator who typed --allow-feed-post has
  // accepted a permanent post, not the rotation of the credential the rest of
  // their tooling is holding.
  assert.equal(
    listed(new Set([...feedOnly].filter((name) => token.has(name)))),
    '',
    '--allow-token-refresh releases a probe that only --allow-feed-post should',
  );
  assert.equal(
    listed(new Set([...tokenOnly].filter((name) => feed.has(name)))),
    '',
    '--allow-feed-post releases a probe that only --allow-token-refresh should',
  );
});

test('the irreversible flags imply --allow-writes instead of running a read-only pass', () => {
  // Without the implication the stronger flag alone is the worst shape available:
  // the operator has consented to the most expensive act in the harness and gets
  // a pass that skips the cheap ones, while the report reads as a full run.
  const bare = running(planOf());
  const writeProbes = without(running(planOf('--allow-writes')), bare);

  for (const [flag, plan] of [
    ['--allow-feed-post', running(planOf('--allow-feed-post'))],
    ['--allow-token-refresh', running(planOf('--allow-token-refresh'))],
  ] as const) {
    assert.equal(
      listed(new Set([...writeProbes].filter((name) => !plan.has(name)))),
      '',
      `${flag} does not imply --allow-writes: it leaves write probes held back`,
    );
  }
});

test('a misspelled probe, flag or auth path ends the run instead of silently probing less', () => {
  for (const [args, expected] of [
    [['--only', 'no-such-probe'], /Unknown probe or lane: no-such-probe/],
    [['--bogus-flag'], /Unknown argument: --bogus-flag/],
    [['--auth-path', 'nope'], /--auth-path must be ig-login or fb-login/],
  ] as const) {
    const run = runProbe('--dry-run', ...args);
    // Exit status first: a plan that printed an explanation and exited 0 is a
    // green CI step, and `--only` is how a lane gets re-run after a failure —
    // a typo there would report "nothing failed" having probed nothing.
    assert.equal(run.status, 1, `${args.join(' ')} exited ${run.status}, not 1`);
    assert.match(run.stderr, expected, `${args.join(' ')} did not say what was wrong`);
    assert.doesNotMatch(
      run.stdout,
      /^ {2}\[RUN /m,
      `${args.join(' ')} listed probes to run despite failing`,
    );
  }

  // The control the three cases above need: the same shape with a name that does
  // exist has to exit 0 and produce a real, narrower plan. Without it, a script
  // that rejected every invocation would pass this test (CC-PROC-112).
  const control = runProbe('--dry-run', '--only', 'read');
  assert.equal(control.status, 0, `--only read exited ${control.status}: ${control.stderr}`);
  const selected = new Set(
    [...control.stdout.matchAll(/^ {2}\[RUN \] (.+)$/gm)].map((match) => match[1] ?? ''),
  );
  assert.ok(selected.size > 0, '--only read selected no probe at all');
  const everything = running(planOf());
  assert.equal(
    listed(without(selected, everything)),
    '',
    '--only read selected a probe that is not in the full plan',
  );
  assert.ok(selected.size < everything.size, '--only read did not narrow the plan');
});

/** A `--flag` token, anchored so it cannot start inside a longer word. */
const FLAG = /(?<![-\w])--[a-z][a-z-]*/g;

/** The `--flag` tokens `parseArgs` compares an argument against, one per branch. */
function parsedFlags(): Set<string> {
  return new Set(
    [...SOURCE.matchAll(/arg === '(--[a-z][a-z-]*)'/g)].map((match) => match[1] ?? ''),
  );
}

test('the usage text and the argument parser document the same set of flags', () => {
  // Two directions, two different failures. A flag in `USAGE` that `parseArgs`
  // does not know is worse than a typo: the script exits 2 on its own
  // documentation, and the operator's next move is to drop the flag they were
  // told to pass — which, for `--dry-run`, means running the thing for real. A
  // flag the parser accepts and the usage never mentions is an undocumented way
  // to reach the write lanes. The short `-h` is out of scope for both halves,
  // deliberately: one character is not a namespace worth scraping.
  const opened = SOURCE.indexOf('const USAGE = `');
  assert.notEqual(opened, -1, 'the USAGE literal moved; this scrape now reads nothing');
  const closed = SOURCE.indexOf('`;', opened);
  assert.notEqual(closed, -1, 'the USAGE literal is unterminated; this scrape now reads nothing');

  const documented = new Set(SOURCE.slice(opened, closed).match(FLAG) ?? []);
  const parsed = parsedFlags();

  assert.ok(parsed.size > 5, `only ${parsed.size} flags were scraped out of parseArgs`);
  assert.equal(
    listed(without(documented, parsed)),
    '',
    'the usage text offers a flag the parser rejects',
  );
  assert.equal(
    listed(without(parsed, documented)),
    '',
    'the parser accepts a flag the usage text never mentions',
  );
});

test('every argument a probe declares as required names a flag the parser accepts', () => {
  // `staticGate` turns a `requires: ['imageUrl']` entry into the string
  // `needs --image-url` by camel-to-kebab, with nothing checking that a flag by
  // that name exists. A probe declaring `requires: ['mediaId']` would print
  // `needs --media-id` and hold itself back forever, telling the operator to
  // pass an argument the parser answers with `Unknown argument` — and the
  // operator's way out of a probe that will not run is the flag that opens
  // everything.
  const parsed = parsedFlags();

  // The observed half: what the plan actually prints, gate conversion included.
  // Every consent flag is on and no URL is passed, which is the only shape where
  // the argument gates are the ones doing the holding.
  const held = runProbe('--dry-run', '--allow-feed-post', '--allow-token-refresh');
  assert.equal(held.status, 0, `the argument-gate plan exited ${held.status}: ${held.stderr}`);
  const printed = new Set(
    [...held.stdout.matchAll(/^ {9}skipped : needs (--[a-z-]+)$/gm)].map((match) => match[1] ?? ''),
  );
  assert.ok(printed.size > 0, 'no probe is held back for a missing argument; this scrape is dead');
  for (const flag of printed) {
    assert.ok(parsed.has(flag), `the plan asks for "${flag}", which parseArgs does not accept`);
  }

  // The declared half, which the observed one cannot reach: `staticGate` returns
  // on the FIRST missing requirement, so `--video-url` — second in the one probe
  // that names it — is never printed while `--image-url` is also missing. Reading
  // the declarations directly is what covers it.
  const required = new Set(
    [...SOURCE.matchAll(/requires: \[([^\]]*)\]/g)]
      .flatMap((match) => (match[1] ?? '').split(','))
      .map((name) => name.trim().replace(/'/g, ''))
      .filter((name) => name !== ''),
  );
  assert.ok(required.size > 0, 'no probe declares a requirement; this scrape reads nothing');
  for (const name of required) {
    const flag = `--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
    assert.ok(
      parsed.has(flag),
      `a probe requires "${name}", which the plan spells "needs ${flag}" — a flag parseArgs ` +
        'does not accept',
    );
  }
});
