import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAuthProvider } from '../../src/core/auth.js';
import { isInstagramError } from '../../src/core/types.js';
import type { ResolvedProfile } from '../../src/core/types.js';

const IG_HOST = 'graph.instagram.com' as const;
const FB_HOST = 'graph.facebook.com' as const;

// `core/auth` is a pure Layer-0 module: it mints an HMAC and hands back query
// params, and must never talk to Graph itself (the client owns transport). The
// guard makes any accidental call a loud failure instead of a live request.
const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('offline: core/auth must never perform network I/O');
};
after(() => {
  globalThis.fetch = realFetch;
});

/** Known (token, secret) pair with a golden HMAC-SHA256 hex digest. */
const KNOWN_TOKEN = 'EAAtESTtoken0123456789';
const KNOWN_SECRET = 's3cr3t-app-secret';
const GOLDEN_PROOF = '43cfff5530206654c5c768125fd2088b48048b671ea715767ea1f9922a12b288';

function igProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return { name: 'default', authPath: 'ig-login', accessToken: 'IGQtoken', ...overrides };
}

function fbProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: 'default',
    authPath: 'fb-login',
    accessToken: KNOWN_TOKEN,
    appSecret: KNOWN_SECRET,
    ...overrides,
  };
}

test('ig-login: the provider carries exactly path, defaultHost and authParams', () => {
  const provider = createAuthProvider(igProfile());
  // Pinned WHOLE, not field by field. Reading `provider.path` and
  // `provider.defaultHost` one at a time is blind to a field ADDED to the
  // returned provider, and that blindness was MEASURED: rewriting this return as
  // `Object.assign({ path: 'ig-login' as const, defaultHost: IG_HOST,
  // authParams: … }, { debugX: 'x' })` in `core/auth.ts` survived the entire
  // suite — 1880 tests, 0 new failures, exit 0 — so nothing anywhere observed
  // the extra key. A provider is the auth record every outgoing Graph call is
  // built from (`core/http.ts` reads it per request), which makes an undeclared
  // key exactly the thing that later shadows a same-named key in a spread, or
  // carries a credential-shaped value onto a surface that never expected one.
  // `authParams` is a fresh closure with no stable identity, so it is pinned by
  // its type; the spread still exposes any key beyond these three.
  assert.deepEqual(
    { ...provider, authParams: typeof provider.authParams },
    { path: 'ig-login', defaultHost: IG_HOST, authParams: 'function' },
  );
});

test('ig-login: authParams returns only access_token, never appsecret_proof', async () => {
  const provider = createAuthProvider(igProfile({ accessToken: 'IGQ_abc' }));
  const params = await provider.authParams(IG_HOST);
  assert.deepEqual(params, { access_token: 'IGQ_abc' });
  assert.ok(!('appsecret_proof' in params));
});

test('ig-login: still omits appsecret_proof even if addressed to graph.facebook.com', async () => {
  const provider = createAuthProvider(igProfile({ accessToken: 'IGQ_abc' }));
  const params = await provider.authParams(FB_HOST);
  assert.deepEqual(params, { access_token: 'IGQ_abc' });
});

test('fb-login: the provider carries exactly path, defaultHost and authParams', () => {
  const provider = createAuthProvider(fbProfile());
  // Pinned WHOLE for the same measured reason as the ig-login provider above:
  // `Object.assign({ path: 'fb-login' as const, defaultHost: FB_HOST,
  // authParams: … }, { debugX: 'x' })` on this return survived the entire suite
  // (1880 tests, 0 new failures, exit 0) while `path`/`defaultHost` were read one
  // field at a time. This is the signing path, so a stray key here rides along
  // with the token and the proof for the lifetime of the process.
  assert.deepEqual(
    { ...provider, authParams: typeof provider.authParams },
    { path: 'fb-login', defaultHost: FB_HOST, authParams: 'function' },
  );
});

test('fb-login: appsecret_proof matches an independently computed HMAC-SHA256 digest', async () => {
  const provider = createAuthProvider(fbProfile());
  const params = await provider.authParams(FB_HOST);

  const independent = createHmac('sha256', KNOWN_SECRET).update(KNOWN_TOKEN).digest('hex');
  const proof = params.appsecret_proof;
  assert.ok(proof, 'appsecret_proof must be present on graph.facebook.com');
  assert.equal(params.access_token, KNOWN_TOKEN);
  assert.equal(proof, independent);
  // Golden literal — proves the digest against a value computed outside this run.
  assert.equal(proof, GOLDEN_PROOF);
  assert.match(proof, /^[0-9a-f]{64}$/);
});

test('fb-login: appsecret_proof is included only for graph.facebook.com targets', async () => {
  const provider = createAuthProvider(fbProfile());

  const fbParams = await provider.authParams(FB_HOST);
  assert.ok('appsecret_proof' in fbParams);

  // graph.instagram.com does not support appsecret_proof (docs/auth.md §1).
  const igParams = await provider.authParams(IG_HOST);
  assert.deepEqual(igParams, { access_token: KNOWN_TOKEN });
  assert.ok(!('appsecret_proof' in igParams));
});

test('fb-login: throws a validation InstagramError naming the profile when appSecret is missing', () => {
  assert.throws(
    () => createAuthProvider(fbProfile({ name: 'brand', appSecret: undefined })),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(err.kind, 'validation');
      // Providers are built per profile and a multi-account setup can have any
      // number of them. "an fb-login profile needs an app secret" leaves the
      // operator to guess which of their accounts to fix; the name is the whole
      // actionable content of the message.
      assert.match(err.message, /brand/);
      return true;
    },
  );
});

test('authParams hands back a fresh object on every call', async () => {
  // The result is a plain mutable record that leaves this module, and `fb-login`
  // *writes* into it (`appsecret_proof`) — a single shared instance would carry
  // the proof from a graph.facebook.com call into the next graph.instagram.com
  // one. `ig-login` never writes, so only the shape of the contract stops the
  // two halves of the interface from disagreeing about whether the caller owns
  // what it is given.
  for (const provider of [createAuthProvider(igProfile()), createAuthProvider(fbProfile())]) {
    const first = await provider.authParams(FB_HOST);
    const second = await provider.authParams(FB_HOST);
    assert.notEqual(first, second, `${provider.path} must not share one params object`);
    assert.deepEqual(first, second, `${provider.path} params must still be equal by value`);
  }
});

test('fb-login: throws a validation InstagramError when appSecret is empty', () => {
  assert.throws(
    () => createAuthProvider(fbProfile({ appSecret: '' })),
    (err: unknown) => isInstagramError(err) && err.kind === 'validation',
  );
});

test('fb-login: a whitespace-only app secret is refused, not signed with', () => {
  // `!appSecret` catches `undefined` and `''` but waves `'   '` through, and an
  // HMAC keyed on spaces is a perfectly well-formed 64-hex proof. Nothing local
  // fails: every Graph call then dies server-side on an `appsecret_proof`
  // mismatch, which reads as "the token is bad" and sends the operator to
  // re-run `login` instead of to the one line of config that is wrong.
  const token = 'EAAdo-not-leak-this-token';
  for (const blank of [' ', '   ', '\t', '\n', ' \t\r\n ']) {
    assert.throws(
      () => createAuthProvider(fbProfile({ accessToken: token, appSecret: blank })),
      (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /requires an app secret/);
        // The new branch is a second throw site; it inherits the same rule as
        // the first — identifiers only, never a credential value.
        assert.ok(!err.message.includes(token), `token leaked into: ${err.message}`);
        return true;
      },
      `a secret of ${JSON.stringify(blank)} must be refused`,
    );
  }
});

test('fb-login: a secret with surrounding whitespace is used VERBATIM, never trimmed', async () => {
  // The deliberate half of the rule above: blank is rejected, but a secret that
  // merely *has* whitespace is not silently repaired. Trimming would sign with a
  // key the operator never configured — and would do it invisibly, since the
  // proof still looks correct. `core/config.ts` and `cli/login.ts` already trim
  // every profile field on the way in, so this module's job is to use what it is
  // handed, not to launder it a second time.
  const padded = `  ${KNOWN_SECRET}\n`;
  const params = await createAuthProvider(fbProfile({ appSecret: padded })).authParams(FB_HOST);
  assert.equal(
    params.appsecret_proof,
    createHmac('sha256', padded).update(KNOWN_TOKEN).digest('hex'),
  );
  assert.notEqual(params.appsecret_proof, GOLDEN_PROOF, 'the secret must not have been trimmed');
});

test('fb-login: an app id present on the profile is never accepted in place of the secret', () => {
  // `appId` sits next to `appSecret` on the profile and is a plausible-looking
  // stand-in, but it is public: signing with it would produce a proof any
  // observer could forge. A missing secret has to stay a hard failure.
  assert.throws(
    () => createAuthProvider(fbProfile({ appSecret: undefined, appId: '1234567890' })),
    (err: unknown) => isInstagramError(err) && err.kind === 'validation',
  );
});

test('ig-login: a profile that happens to carry an app secret still sends the bare token', async () => {
  // Nothing stops an operator from filling IG_APP_SECRET on an ig-login profile.
  // The proof rule is host-driven, and graph.instagram.com rejects the param, so
  // the stray secret must not pull the profile onto the signing path.
  const provider = createAuthProvider(
    igProfile({ accessToken: 'IGQ_abc', appSecret: KNOWN_SECRET, appId: '42' }),
  );
  assert.equal(provider.path, 'ig-login');
  assert.equal(provider.defaultHost, IG_HOST);
  assert.deepEqual(await provider.authParams(IG_HOST), { access_token: 'IGQ_abc' });
  assert.deepEqual(await provider.authParams(FB_HOST), { access_token: 'IGQ_abc' });
});

test('fb-login: the validation message names the path, the quoted profile and the missing input', () => {
  assert.throws(
    () => createAuthProvider(fbProfile({ name: 'brand', appSecret: undefined })),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      // This message is the operator's only repair instruction, so all four
      // parts carry weight: which auth path is at fault, which profile (quoted,
      // so a blank name is still visible as an empty slot), that an app secret
      // is what is missing, and what it would have been used for.
      assert.match(err.message, /^fb-login profile "brand" requires an app secret/);
      assert.match(err.message, /appsecret_proof/);
      return true;
    },
  );
});

test('fb-login: a blank profile name still surfaces as an empty quoted slot', () => {
  assert.throws(
    () => createAuthProvider(fbProfile({ name: '', appSecret: undefined })),
    (err: unknown) =>
      isInstagramError(err) && err.message.startsWith('fb-login profile "" requires an app secret'),
  );
});

test('fb-login: the validation message names the env var that has to be set', () => {
  // "Profile X needs an app secret" tells the operator what is wrong and leaves
  // them to work out where to put it — and the answer differs per profile: the
  // default profile reads the bare `IG_*` var, every named one reads a
  // `IG_PROFILE_<NAME>_*` var. The scheme is `config.ts`'s `envVarFor`, the same
  // function the parser uses, so the remedy cannot drift from the lookup.
  const cases: ReadonlyArray<[string, string]> = [
    ['default', 'IG_APP_SECRET'],
    ['brand', 'IG_PROFILE_BRAND_APP_SECRET'],
    ['Second-Studio', 'IG_PROFILE_SECOND-STUDIO_APP_SECRET'],
  ];
  for (const [name, expectedVar] of cases) {
    assert.throws(
      () => createAuthProvider(fbProfile({ name, appSecret: undefined })),
      (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.ok(
          err.message.includes(expectedVar),
          `profile '${name}' must be told to set ${expectedVar}; got: ${err.message}`,
        );
        return true;
      },
    );
  }
});

test('fb-login: the blank-secret message carries the same remedy as the missing-secret one', () => {
  // The two failures have one repair, so they must not read differently — an
  // operator who set the var to spaces needs the variable named just as much as
  // one who never set it.
  const messageFor = (appSecret: string | undefined): string => {
    try {
      createAuthProvider(fbProfile({ name: 'brand', appSecret }));
    } catch (err) {
      assert.ok(isInstagramError(err));
      return err.message;
    }
    throw new Error('expected createAuthProvider to throw');
  };
  assert.equal(messageFor('   '), messageFor(undefined));
  assert.match(messageFor('   '), /IG_PROFILE_BRAND_APP_SECRET/);
});

test('fb-login: the validation error never quotes the access token', () => {
  const token = 'EAAdo-not-leak-this-token';
  assert.throws(
    () => createAuthProvider(fbProfile({ accessToken: token, appSecret: undefined })),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      // Validation errors are logged and returned to MCP clients as text; a
      // token pasted into the message would outlive every redaction layer.
      assert.ok(!err.message.includes(token), `token leaked into: ${err.message}`);
      return true;
    },
  );
});

test('fb-login: graph.facebook.com params carry exactly access_token and appsecret_proof', async () => {
  const provider = createAuthProvider(fbProfile());
  const params = await provider.authParams(FB_HOST);
  assert.deepEqual(Object.keys(params).sort(), ['access_token', 'appsecret_proof']);
});

test('fb-login: the proof tracks both the token and the secret, not a fixed value', async () => {
  const OTHER_TOKEN = 'EAAotherTOKEN9876543210';
  const OTHER_SECRET = 'another-app-secret';

  const base = await createAuthProvider(fbProfile()).authParams(FB_HOST);
  const swappedToken = await createAuthProvider(fbProfile({ accessToken: OTHER_TOKEN })).authParams(
    FB_HOST,
  );
  const swappedSecret = await createAuthProvider(fbProfile({ appSecret: OTHER_SECRET })).authParams(
    FB_HOST,
  );

  assert.notEqual(base.appsecret_proof, swappedToken.appsecret_proof);
  assert.notEqual(base.appsecret_proof, swappedSecret.appsecret_proof);
  // Both directions are checked independently so a proof keyed on the wrong one
  // of the two inputs cannot hide behind "it changed, therefore it is derived".
  assert.equal(
    swappedToken.appsecret_proof,
    createHmac('sha256', KNOWN_SECRET).update(OTHER_TOKEN).digest('hex'),
  );
  assert.equal(
    swappedSecret.appsecret_proof,
    createHmac('sha256', OTHER_SECRET).update(KNOWN_TOKEN).digest('hex'),
  );
});

test('callers own the params object: tampering with one result cannot bleed into the next', async () => {
  for (const provider of [createAuthProvider(igProfile()), createAuthProvider(fbProfile())]) {
    const first = await provider.authParams(FB_HOST);
    first.access_token = 'tampered';
    delete first.appsecret_proof;

    const second = await provider.authParams(FB_HOST);
    assert.notEqual(
      second.access_token,
      'tampered',
      `${provider.path} handed back a params object the caller had already edited`,
    );
    if (provider.path === 'fb-login') {
      assert.ok(second.appsecret_proof, 'fb-login must re-attach the proof on every call');
    }
  }
});

/**
 * A token that is a fixed point of nothing: padded, mixed-case and NFKC-unstable
 * (`Ｆ` → `F`, `Ⅻ` → `XII`, `ﬁ` → `fi`). Obviously fake, so it can never be
 * mistaken for a live credential, while still separating "forwarded byte for
 * byte" from every silent repair — `trim`, `normalize`, a case fold, a slice —
 * that a plain lowercase-ASCII fixture would survive unchanged.
 */
const ADVERSARIAL_TOKEN = '  IGQ-Ｆake-Ⅻ-ﬁxture-NOT-A-REAL-TOKEN  ';

test('ig-login: the token reaches Graph byte for byte, never repaired on the way out', async () => {
  // Catches a `.trim()` / `.normalize()` / case fold inserted on the outgoing
  // `access_token`. The token is opaque to this module: only Meta knows which
  // bytes make it valid, and a locally repaired one comes back as a generic
  // "invalid access token" that sends the operator to re-run `login` instead of
  // to the character that was eaten here. Every other fixture in this file is
  // plain ASCII, so none of them can tell the two apart.
  const provider = createAuthProvider(igProfile({ accessToken: ADVERSARIAL_TOKEN }));
  assert.deepEqual(await provider.authParams(IG_HOST), { access_token: ADVERSARIAL_TOKEN });
  assert.deepEqual(await provider.authParams(FB_HOST), { access_token: ADVERSARIAL_TOKEN });
});

test('fb-login: the token is both forwarded AND signed byte for byte', async () => {
  // Two failures with one shape: repairing the token before it goes on the query
  // (Graph rejects it), or repairing it before the HMAC (the proof is a
  // well-formed 64-hex digest of the wrong string, so Graph rejects the call
  // with an `appsecret_proof` mismatch that reads as "your token is bad"). The
  // second is the harder one to trace, so it is asserted against the digest of
  // the repaired token explicitly, not merely against "some digest".
  const provider = createAuthProvider(
    fbProfile({ accessToken: ADVERSARIAL_TOKEN, appSecret: KNOWN_SECRET }),
  );
  const params = await provider.authParams(FB_HOST);
  assert.equal(params.access_token, ADVERSARIAL_TOKEN);
  assert.equal(
    params.appsecret_proof,
    createHmac('sha256', KNOWN_SECRET).update(ADVERSARIAL_TOKEN).digest('hex'),
  );
  assert.notEqual(
    params.appsecret_proof,
    createHmac('sha256', KNOWN_SECRET).update(ADVERSARIAL_TOKEN.trim()).digest('hex'),
    'the proof must be keyed on the token as configured, not on a trimmed copy',
  );
});

test('fb-login: the blank-secret refusal is one exact sentence, profile name as written', () => {
  // The whole message is the deliverable, so the whole message is pinned: a
  // fragment match leaves the remedy clause ("set <VAR> to the Meta app secret")
  // free to drift into naming the wrong thing, and the operator has nothing else
  // to act on. The name is deliberately mixed-case — it is echoed as the
  // operator wrote it, while `envVarFor` uppercases it for the variable, and a
  // single fold applied to the quoted half would go unnoticed against the
  // all-lowercase `brand` used everywhere else in this file.
  assert.throws(
    () => createAuthProvider(fbProfile({ name: 'Second-Studio', appSecret: undefined })),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(
        err.message,
        'fb-login profile "Second-Studio" requires an app secret to compute appsecret_proof; ' +
          'set IG_PROFILE_SECOND-STUDIO_APP_SECRET to the Meta app secret.',
      );
      return true;
    },
  );
});

test('an auth path that merely starts with "ig" is not the ig-login path', () => {
  // `ig-basic-display` is a real, retired Instagram auth path that persisted
  // configs still carry, and `authPath` reaches here from that config — a
  // hand-edit can widen it past the union. Matching on a prefix would hand such
  // a profile the Path A provider: bare token, no `appsecret_proof`, and no
  // complaint. This module fails CLOSED instead — anything that is not exactly
  // `ig-login` takes the fb-login branch, where a missing app secret is a loud,
  // offline refusal (`core/refresh.ts` pins the same rule for the same reason).
  const legacy = 'ig-basic-display' as unknown as ResolvedProfile['authPath'];
  assert.throws(
    () => createAuthProvider(fbProfile({ authPath: legacy, appSecret: undefined })),
    (err: unknown) => isInstagramError(err) && err.kind === 'validation',
  );
  const provider = createAuthProvider(fbProfile({ authPath: legacy }));
  assert.equal(provider.path, 'fb-login');
  assert.equal(provider.defaultHost, FB_HOST);
});
