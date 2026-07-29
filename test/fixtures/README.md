# test/fixtures — sanitized Graph response shapes

Everything in this directory is **synthetic**. No file here contains a real
access token, a real account or media ID, a real handle, a real CDN URL, or a
line of text a real person wrote. That is a hard invariant, enforced by
`test/release/fixtures.test.ts` on every run.

## Where the files come from

| Source                        | How to spot it                                              |
| ----------------------------- | ----------------------------------------------------------- |
| `scripts/capture-fixtures.mjs` | Written by an operator with live credentials; every response passed through `test/helpers/sanitize.ts` before touching disk. |
| Hand-written examples          | Carry a top-level `"_synthetic"` marker string. Never a capture. |

A capture is not a copy of the wire. `test/helpers/sanitize.ts` is a
**default-deny allowlist**: only fields it explicitly knows are copied, and even
those are rewritten —

- IDs become stable synthetic 17-digit IDs (`17800000000000001`, `…002`, …),
  consistent across every response in one capture run, so cross-references
  between fixtures still line up;
- handles become `example_account_1`, `example_account_2`, …;
- captions, comment bodies and biographies become
  `[synthetic text: N code points removed]` — the length survives, the content
  does not;
- media URLs, permalinks and profile pictures become
  `https://example.invalid/<field>/<n>` (`.invalid` is reserved by RFC 2606 and
  can never resolve);
- `paging.next` / `paging.previous` are **rebuilt** from allowlisted parts only,
  so `access_token` and `appsecret_proof` cannot survive;
- cursors and trace IDs become `SYNTHETIC_OPAQUE_1`, `…_2`, …;
- every unrecognised field is **dropped**, because an unrecognised field is
  exactly where a token or a piece of PII hides.

The sanitized value then passes through the production redactor
(`src/core/redact.ts`) and a final `assertFixtureSafe()` gate. A capture that
trips that gate is never written.

## Consequences for tests that use these fixtures

- Fixtures are for **shape**, not for values. Assert on structure, presence,
  optionality and types; never assert that a caption reads a certain way.
- A fixture may be missing fields the live API returns, if the policy in
  `test/helpers/sanitize.ts` does not list them yet. Widening the policy is a
  reviewed code change — see that file's docstring.
- Numbers, timestamps, enum strings (`media_type`, `media_product_type`) and
  counters are copied verbatim; they are Meta vocabulary, not user data.

Load them with `loadFixture('<name>.json')` from `test/helpers/fixtures.ts`.

## Adding a capture

```sh
npm run build
node scripts/capture-fixtures.mjs --dry-run   # prints what it would capture
node scripts/capture-fixtures.mjs
```

Then **read the diff before committing it**. The harness is designed so that a
leak is impossible, not so that review is unnecessary.
