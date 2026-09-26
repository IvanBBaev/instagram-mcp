import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  assertNotShellSpelling,
  expandHomeTilde,
  homeDirectory,
  homeTilde,
} from '../../src/core/home-path.js';
import { InstagramError } from '../../src/core/types.js';

test('homeTilde matches only the home directory’s own ~, per platform', () => {
  const posix = homeTilde('linux');
  for (const hit of ['~', '~/', '~/a']) assert.ok(posix.test(hit), hit);
  for (const miss of ['~user', '~\\a', 'a~', ' ~', '~~']) assert.ok(!posix.test(miss), miss);
  const win = homeTilde('win32');
  for (const hit of ['~', '~/a', '~\\a']) assert.ok(win.test(hit), hit);
  for (const miss of ['~user', 'a~\\', '~~']) assert.ok(!win.test(miss), miss);
});

test('expandHomeTilde spells the home out and leaves everything else alone', () => {
  assert.equal(expandHomeTilde('~', 'linux'), homedir());
  assert.equal(expandHomeTilde('~/a/b', 'linux'), join(homedir(), 'a', 'b'));
  assert.equal(expandHomeTilde('~\\a', 'win32'), join(homedir(), '\\a'));
  assert.equal(expandHomeTilde('~\\a', 'linux'), '~\\a');
  assert.equal(expandHomeTilde('~user/a', 'linux'), '~user/a');
  assert.equal(expandHomeTilde('rel/~', 'linux'), 'rel/~');
});

/** The message `assertNotShellSpelling` throws for `value`, or `undefined`. */
function refusal(value: string): string | undefined {
  try {
    assertNotShellSpelling(value, 'SRC', 'for the test');
    return undefined;
  } catch (err) {
    assert.ok(err instanceof InstagramError);
    assert.equal(err.kind, 'validation');
    return err.message;
  }
}

test('assertNotShellSpelling refuses only a leading ~, $ or %', () => {
  for (const bad of ['~', '~user', '$HOME', '${HOME}/x', '%APPDATA%']) {
    assert.equal(
      refusal(bad),
      `SRC is ${JSON.stringify(bad)}, which only a shell can expand — it is not a path ` +
        'this server can use for the test; set it to an absolute path',
    );
  }
  for (const ok of ['/abs', 'rel', 'a$b', 'a%b', 'a~b', ' $x'])
    assert.equal(refusal(ok), undefined);
});

test('a $ or % past the start is part of a real name, not a shell spelling', () => {
  // Pins the decision documented on SHELL_SPELLING: only a leading spelling can
  // turn the value into a relative name. These are all names an operator can
  // really have, and refusing them would stop the server from starting.
  for (const ok of [
    '\\\\host\\C$\\Users\\me\\ig.env',
    'C:\\$Recycle.Bin\\ig.env',
    'D:\\$WINDOWS.~BT\\ig.env',
    '/data/100%/ig.env',
    '/data/a%20b/ig.env',
    '/data/$HOME/ig.env',
  ])
    assert.equal(refusal(ok), undefined, ok);
});

test('a refused value is echoed with invisible and control characters escaped', () => {
  // Control characters are escaped by JSON.stringify; format characters (a bidi
  // override, a Unicode tag) and U+2028/U+2029 are not, and would otherwise reach
  // the stderr line verbatim.
  // A soft hyphen (U+00AD) pins the zero padding of a code below U+1000.
  const message = refusal('$A\u202eB\u2028C\u2029D\u{E0041}E\u001bF\u00adG') ?? '';
  assert.ok(
    message.startsWith('SRC is "$A\\u202eB\\u2028C\\u2029D\\udb40\\udc41E\\u001bF\\u00adG", which'),
    message,
  );
  assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(message), message);
});

/** Run `run` with `$HOME` and `%USERPROFILE%` set to `home`, restoring both after. */
function withHome(home: string, run: () => void): void {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a home directory that is not absolute is refused, naming the variable (CC-CFG-69)', () => {
  // `os.homedir()` returns `$HOME` verbatim whenever it is set, blank and relative
  // values included, so a `~` spelled out against it — or a default under it —
  // would be a RELATIVE path that follows the cwd: `HOME="   "` turned a `~`
  // config dir into `<cwd>/   /instagram-mcp-ai/.env`.
  for (const home of ['   ', '', 'rel/home', './home']) {
    withHome(home, () => {
      assert.equal(homedir(), home, 'premise: the home directory follows the environment');
      for (const [platform, variable] of [
        ['linux', 'HOME'],
        ['win32', 'USERPROFILE'],
      ] as const) {
        const message =
          `the home directory is ${JSON.stringify(home)} (from ${variable}), which is not an ` +
          'absolute path, so a file under it would be looked for in whatever directory the ' +
          `process was started from; set ${variable} to an absolute path`;
        for (const run of [
          () => homeDirectory(platform),
          () => expandHomeTilde('~', platform),
          () => expandHomeTilde('~/x', platform),
        ]) {
          assert.throws(run, (err: unknown) => {
            assert.ok(err instanceof InstagramError);
            assert.equal(err.kind, 'validation');
            assert.equal(err.message, message);
            return true;
          });
        }
      }
      // Only a value that uses the home consults it.
      assert.equal(expandHomeTilde('/abs/x', 'linux'), '/abs/x');
      assert.equal(expandHomeTilde('~user/x', 'linux'), '~user/x');
    });
  }
  const absolute = join(homedir(), 'elsewhere');
  withHome(absolute, () => assert.equal(homeDirectory('linux'), absolute));
});
