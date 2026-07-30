# M6 Messaging — Design Review

> Gated design review required by [roadmap.md](roadmap.md) M6 before any DM code
> is written. This document produces a **recommendation and a verdict**, not an
> implementation. Facts reflect Meta docs as of 2026-07 (Graph API v25.0).
> **Documentation-verification pass 2026-07-30:** every endpoint/scope/shape
> question in §2 was resolved from official Meta documentation and now carries a
> *[verified &lt;date&gt; — source]* stamp; what remains is marked
> `[verify — needs a live call: …]` in the style of
> [corner-cases.md](corner-cases.md), always naming the call that would settle
> it. An unverified policy detail is never stated here as fact.
>
> **Verdict: DEFER (NO-GO for v1).** See §7 for the conditions that flip it.

## 1. Why this review exists

Messaging is the only planned package whose failure mode is not "a tool returns
an error". A DM is irreversible, private, addressed to a named human, and — in
the direction that matters — *triggered by text an attacker wrote*. Every other
package in this server reads public data or writes content the operator owns.
Messaging is the first place where the server would act **on** a third party
rather than on the operator's own assets, which is a different security and
policy class, not a bigger version of the same one.

The rest of the surface is also honest about what it does not know: the
`discovery` package ships dark because one App-Review question was never
answered empirically. Messaging has *four* such questions open at once (§2, §3,
§4). That alone is the shape of a DEFER.

## 2. The two paths

Both auth paths in [auth.md](auth.md) §1 can technically reach Instagram
messaging, but they reach *different endpoints on different hosts with different
prerequisites*. They are not two configurations of one feature; they are two
implementations.

| | **Path A — `ig-login`** | **Path B — `fb-login`** |
|---|---|---|
| Host | `graph.instagram.com` | `graph.facebook.com/v25.0` |
| Scope | `instagram_business_basic` + `instagram_business_manage_messages` *[verified 2026-07-30 — [send](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/) / [conversations](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api/) guides]* | **Corrected:** the guess "likely `pages_messaging`" was wrong. Documented set is `instagram_basic`, `instagram_manage_messages`, **`pages_manage_metadata`**, with a **Page access token from someone holding the `MESSAGING` task** on the linked Page *[verified 2026-07-30 — [Messenger Conversations API](https://developers.facebook.com/docs/messenger-platform/conversations/), [IG send-message](https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message/)]* |
| Linked Facebook Page | **not required** | **required** — the IG account must be linked to a Page, and sends address the Page |
| `appsecret_proof` | **not supported** on `graph.instagram.com` (auth.md §1 Path A, `src/core/auth.ts`) | supported and mandatory here (`src/core/auth.ts`) |
| Send endpoint shape | `POST https://graph.instagram.com/v25.0/{ig-id}/messages`, body `{"recipient":{"id":"<IGSID>"},"message":{"text":"<TEXT>"}}` (attachments via `message.attachment`) *[verified 2026-07-30 — [Send Messages, IG Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)]* | `POST /{page-id}/messages` (or `/me/messages`) with the same recipient/message body; **text capped at 1,000 characters**, image attachments ≤ 8 MB, video/audio ≤ 25 MB *[verified 2026-07-30 — [IG send-message](https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message/)]* |
| Conversation read | `GET /{ig-id}/conversations` (or `/me/conversations`); `GET /{conversation-id}?fields=messages`, then `GET /{message-id}` for `from`/`to`/`message`. **Hard limit: only the 20 most recent messages per conversation are retrievable** *[verified 2026-07-30 — [Conversations API, IG Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api/)]* | `GET /{page-id}/conversations?platform=instagram`, Page access token *[verified 2026-07-30 — [Messenger Conversations API](https://developers.facebook.com/docs/messenger-platform/conversations/)]* |
| App Review | Standard Access is documented as covering app roles operating their own assets, and Advanced Access as the third-party case *[verified 2026-07-30 — [Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels/)]*. But the Instagram Platform overview warns that for an app not published publicly, reviewers can only approve `instagram_basic` and `instagram_manage_comments` — messaging is **not** on that list. `[verify — needs a live call: with the app at Standard Access and the operator as app admin, request instagram_business_manage_messages and attempt one POST /{ig-id}/messages; record whether it succeeds or returns 10/200-series]` | same question, **plus** the Human Agent feature, which is confirmed App-Review- **and** Business-Verification-gated (§3) |

### What is structurally impossible on which path

These are not preferences; they are hard consequences of how this server is
built:

1. **A Path-A token cannot address `graph.facebook.com` messaging.**
   `createAuthProvider` gives an `ig-login` profile a bare `access_token` and
   `defaultHost: graph.instagram.com`. Even if a tool asked for the Facebook
   host, the token is IG-scoped and there is no Page behind it. Path B is
   therefore unreachable for the operator persona auth.md explicitly courts —
   "no Facebook presence, just an IG professional account".
2. **A Path-B-only implementation excludes every Page-less operator.** That is
   the exact opposite trade-off from `discovery`, which is Path-B-only *because
   the endpoints do not exist on Path A*. Here they do exist on both, so
   choosing B would be a self-inflicted capability loss.
3. **`appsecret_proof` cannot protect Path-A messaging.** A stolen Path-A token
   is sufficient to send DMs as the account, with no second factor. On Path B,
   "Require App Secret" makes a bare stolen token useless (security.md §5). The
   path that is *easier to set up* is the path with the *weaker* credential
   binding — and it is the path where the blast radius (private messages to real
   people) is worst. This is the single strongest technical argument in the whole
   review.
4. **Two paths means two implementations, doubled.** D1's `ToolSpec.paths`
   (`src/mcp/define.ts`) can express "this tool is Path A only", so a split
   surface is *representable*. But the `api/` layer would need two endpoint
   families, two envelope shapes, and two live-probe protocols — against a Lane E
   that currently cannot run at all (§6). Committing to both paths at once is not
   affordable.

**Path recommendation (conditional on the package ever shipping): Path A only,
tagged `paths: ['ig-login']`, with the weaker-credential-binding consequence
documented in the operator-facing docs.** It matches the setup this server
optimizes for, avoids the Page dependency, and halves the live-probe surface.
Path B messaging becomes a later, separately-reviewed addition — not a v1 "both
paths" promise.

## 3. Messaging windows and policy

Meta constrains *when* a business may message a person. The shape, after the
2026-07-30 documentation pass:

- The **24-hour window is confirmed**: "Your app has 24 hours to respond to any
  message sent from an Instagram user to your app user" *[verified 2026-07-30 —
  [Send Messages, IG Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)]*.
  A related documented prerequisite: the conversation must be user-initiated —
  the business cannot open one. The **error code for sending outside the window
  is still unknown**: the official Instagram error-code reference carries no
  messaging entries, and the code seen quoted around (10 / subcode 2534022)
  appears only in non-official sources, so it is not stamped here.
  `[verify — needs a live call: let a test conversation go quiet for > 24 h,
  then POST /{ig-id}/messages and record code / error_subcode / error_user_msg;
  it must land in the taxonomy in operations.md §3 before any send tool ships]`
- The **human-agent exception is confirmed**, and its gating is the important
  part: tag name `human_agent`, usable "within 7 days of a user's message", and
  the feature "requires both successful completion of the App Review process and
  business verification before accessing live data" *[verified 2026-07-30 —
  [Human Agent feature reference](https://developers.facebook.com/docs/features-reference/human-agent)]*.
  Note what the name and the docs jointly say: the exception is for a **human**
  agent handling the conversation.
- Which tags exist **on the Instagram surface** is still not settled: the
  Instagram send-message guides enumerate no message tags at all, and the
  Messenger message-tag page could not be retrieved from an official source in
  this pass (Meta doc-tree migration, operations.md §5 watch item).
  `[verify — needs a live call: POST /{ig-id}/messages with
  messaging_type=MESSAGE_TAG&tag=<candidate> and record which tags are accepted;
  or re-fetch the message-tags reference once the docs tree settles]`

### What this means for an LLM-driven tool surface

This is where the policy detail stops being trivia. The human-agent exception
exists precisely because a *human* is handling the conversation. A tool that
lets a model compose and send under that tag is, on its face, using an exception
whose entire premise is human authorship. Even if the API accepts the call, the
policy question — is an LLM a "human agent"? — is one this project should not
answer unilaterally, and one whose wrong answer costs the operator their app,
not a failed test.

Two concrete consequences for any future design:

- **The server must never set a human-agent-style tag on the model's behalf.**
  If such a tag is ever supported, it must require an explicit per-call operator
  action, never a default and never an env flag.
- **The window must be surfaced, not silently worked around.** A send tool must
  read the conversation's last-inbound timestamp and *refuse* outside the
  standard window with a plain explanation, rather than trying a tag. Refusing is
  the correct behavior; a model that gets "window expired, cannot send" will stop,
  a model that gets a tag knob will use it.

The documentation pass strengthens the first consequence rather than weakening
it: `human_agent` is explicitly the *human* agent's exception, and it is gated
behind App Review **and** Business Verification — a bar this project has already
declared permanently out of scope (auth.md §2 point 3). The second consequence
still needs the outside-window error code above before a send tool could refuse
accurately rather than by guesswork.

## 4. The webhook question

DMs are inherently push. This server is stdio-by-default, with an opt-in
Streamable HTTP transport that **binds `127.0.0.1` only** (architecture.md §8).
It has no public endpoint and, by design, will not get one:
[operations.md](operations.md) §7 calls webhooks an explicit v1 non-goal, and
[roadmap.md](roadmap.md) "Later / explicitly parked" lists the webhook receiver
as needing a public endpoint. Nothing in this review asks to reopen that.

**Achievable without a webhook (pull-only):**

- Polling a conversations list and reading message history. **The read endpoints
  are confirmed to exist on both paths** (§2, Conversations API) — with one
  documented ceiling that matters for polling: only the **20 most recent
  messages** of a conversation are retrievable *[verified 2026-07-30 —
  [Conversations API, IG Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api/)]*,
  so a busy conversation can outrun a slow poll and lose history permanently.
- Operator-initiated flows: "show me unread conversations", "draft a reply to
  this one" — the operator is already present in the loop, which is exactly the
  posture the write-safety argument in §5 wants.

**Not achievable without a webhook:**

- Any real-time or autonomous behavior — reacting to a DM as it arrives.
- Reliable window tracking. The 24-hour clock starts at the user's last inbound
  message; without push, the server only knows what the last poll saw, so it can
  compute the window *at read time* and be wrong by the polling interval. It must
  therefore treat its own window calculation as advisory and let Meta be the
  authority — i.e. attempt-and-report, never "the window is open, go ahead".
- **Possibly nothing at all** — whether Meta requires the app to hold an active
  `messages` webhook subscription before the **send** endpoint will work. If it
  does, the entire package is structurally impossible for a loopback-only server
  and M6 becomes a permanent NO-GO rather than a DEFER.
  **Still the decisive question after the 2026-07-30 documentation pass, and
  deliberately not stamped either way.** What the docs do say: neither path's
  requirement list names a webhook subscription as a prerequisite for sending —
  the documented prerequisite is that the *user* must message the business first
  — yet the Path-A messaging guide states it "assumes … a webhooks server", so
  the absence is suggestive, not decisive.
  `[verify — needs a live call: with zero webhook subscriptions configured on
  the app, have a test user DM the account, then POST /{ig-id}/messages within
  the 24 h window and record success or the exact error]`
  This must be answered first: a negative answer makes every other question in
  this document moot.

## 5. Write safety for DMs

### The existing gate, applied honestly

`src/mcp/write-mode.ts` gives every mutation two gates:

1. **Preview → apply.** `applyRequested` is true when `args.apply === true`, or
   when `IG_WRITE_MODE=apply` and the call did not pass `apply: false`.
2. **`IG_ALLOW_DESTRUCTIVE`**, required additionally when the intent sets
   `destructive: true`.

Now apply the module's own documented classification policy to a hypothetical
`instagram_send_message`. That policy is explicit: `destructive` means "this call
removes or overwrites data that already exists and cannot be restored through
this server", and publishing is deliberately **not** destructive because it
"*creates* new content, destroys nothing". A DM creates a message and destroys
nothing. **Under the existing taxonomy, sending a DM is not destructive** — so
gate 2 would never fire, and a send tool would ship behind gate 1 alone.

Gate 1 alone is `apply: true` — a boolean the **model** supplies. The security
review already named this (F-1/F-3, and theme 3 in
[reviews/summary.md](reviews/summary.md)): a model-set boolean is not human
consent, and `IG_WRITE_MODE=apply` disables the gate for the whole session
silently. For a comment reply that is an accepted, bounded risk. For a DM it is
not.

**Position: the existing gate is not sufficient for DMs, and stretching the
`destructive` flag to cover them is the wrong fix.** Marking sends destructive
would collapse the very distinction `write-mode.ts` argues for, and would push
operators to set `IG_ALLOW_DESTRUCTIVE=true` as routine — which then stops
protecting `delete_comment`, the one thing that flag exists for. The module's
reasoning is right; the conclusion is that **DMs need a third, narrower gate,
not a reuse of the second.**

### Why DMs are strictly worse than public comments

| | Public comment | DM |
|---|---|---|
| Visible to the operator afterwards | yes, on their own media | only inside the conversation, easily missed |
| Reversible | `delete_comment` covers replies too — a reply is itself an IG Comment node, so `DELETE /{ig-comment-id}` applies, bounded by "a comment can only be deleted by the owner of the object upon which the comment was made, even if the user attempting to delete the comment is the comment's author" *[verified 2026-07-30 — [comment moderation](https://developers.facebook.com/docs/instagram-platform/comment-moderation)]* | no unsend/delete-message endpoint is documented on **either** path *[checked 2026-07-30 — [IG Login messaging](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/), [Messenger IG send-message](https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message/)]* — a documented absence, so "assume none" stands |
| Audience | public, discoverable, socially self-correcting | one named person, private, silent |
| Recipient chosen by | the media being commented on | **an ID the model supplies** |
| Failure mode | embarrassment, deletable | harassment, impersonation, data leak to a specific party |

The fourth row is the important one. A send tool's signature is essentially
`send(recipient, text)` — a **general-purpose outbound channel to an arbitrary
party, addressable by the model**. That is a textbook exfiltration primitive.
Comments are also an outbound channel, but a public one: loud, discoverable, and
deletable. A DM is quiet.

### What a DM gate would have to look like

If M6 is ever built, these are the minimum conditions, and they are conditions on
the *design*, not nice-to-haves:

1. **Mandatory human confirmation per send, non-bypassable by env.** D3
   elicitation must be in place *and* messaging must be exempt from standing
   consent — `IG_WRITE_MODE=apply` must not authorize a DM. The confirmation must
   show the **exact outbound text and the recipient** to the human.
2. **Its own opt-in flag** (e.g. `IG_ALLOW_MESSAGING`, default false) on top of
   package selection, so `IG_TOOL_PACKAGES=all` alone never arms sends. Note the
   precedent worth avoiding: `discovery` is absent from the `core` profile but
   *is* in `reader` and `all` (`src/mcp/registry.ts`) — "ships dark" via profile
   membership is weaker than it sounds.
3. **Recipient must be derived, never invented.** Sends addressed only to a
   participant of a conversation the server itself just read; no free-form
   recipient IDs.
4. **Velocity caps** per conversation and per hour, enforced locally, refusing
   rather than queueing.
5. **Journaled with full outbound text.** The existing journal records a summary;
   for DMs the exact sent body belongs in the record (the journal is already
   `0600` in a `0700` directory, so this does not weaken the file's posture).
6. **Read-only ships first, separately.** Conversation reads and sends are two
   different reviews. Sends do not ship in the same increment that first proves
   reads work.

Even reads deserve one caution: pulling private third-party message content into
an LLM context contradicts the current claim in [security.md](security.md) §5
that "no third-party data ever transits the server" and that the Data Use Checkup
surface is minimal. That claim would have to be rewritten — honestly and visibly
— before a messaging read tool ships. It is a documentation change with real
meaning, not a wording nit.

## 6. Prompt-injection surface

Incoming DM text is **fully attacker-controlled**: anyone on Instagram can send
the operator's account a message, and that message becomes tool-result text in
the model's context. `src/mcp/result.ts` provides the fence
(`[UNTRUSTED source: "instagram-user-content"] … [/UNTRUSTED]`), it defangs
embedded delimiters so content cannot forge a fence boundary, and every package
that returns third-party text uses it (`src/tools/discovery.ts`,
`src/tools/comments.ts`). The mechanism is sound and is not the problem.

The problem is what the fence *is*. Fencing is a **mitigation, not a control**:
it labels text as data and relies on the model honoring the label. That is an
acceptable bet when the worst outcome is a bad read, and a poor one when the
attacker closes the loop.

Messaging closes the loop. A comment injection gives an attacker a write into
the model's context and, at worst, a public reply they can also see. A DM
injection gives an attacker **a private, two-way channel with the model**: they
send text, the model reads it, the model can send back, and the attacker reads
the response — with no public artifact and nobody else watching. The same
account, credentials, and tool surface are on the other end. Fencing plus a
model-set `apply: true` boolean does not survive that; only step 1 of §5 (a human
seeing the exact outbound text before it leaves) does.

**Conclusion: the existing injection fencing is adequate for the packages that
ship today and is *not*, on its own, adequate for messaging.** It stays required
for any future messaging read tool — it is just no longer sufficient.

## 7. Recommendation and verdict

### Verdict: **DEFER — NO-GO for v1**

Not because messaging is hard, but because every input this decision needs is
currently missing:

- The decisive webhook-dependency question (§4) is unanswered and could make the
  package impossible rather than merely deferred.
- The policy constraints (§3) survived the 2026-07-30 documentation pass only
  partly: the 24 h window and the `human_agent` tag are now confirmed from
  official docs, but the outside-window error code and the Instagram-surface tag
  list still need a live account — and Lane E is blocked
  outright: T-E1..T-E4 have never run, so even `discovery`, a far simpler
  package, shipped without its gating probe (T-E3). Adding a *harder*
  probe-dependent package while the existing probe debt is unpaid is the wrong
  order of work.
- The write-safety design (§5) depends on D3 elicitation, which is only being
  implemented now. A safety mechanism that has not yet shipped cannot be the
  foundation of the riskiest package in the project.
- The security posture is genuinely worse than for anything already shipped
  (§5, §6), and the recommended path is also the one with the weaker credential
  binding (§2).

Shipping a v1 without DMs costs the project a feature. Shipping DMs on the
current foundation risks the operator's account and their relationships with real
people. That is not a close call.

### Conditions that would flip DEFER to GO

All of these, in order — any one unmet keeps the package closed:

1. **Webhook dependency answered NO.** Confirm that sends work without an active
   `messages` webhook subscription. A YES makes M6 a permanent NO-GO for a
   loopback-only server; record it and close M6 rather than leaving it open.
2. **Lane E unblocked.** Live Meta credentials exist in a working environment and
   T-E2/T-E3 have actually run. The existing probe backlog is paid down first.
3. **Every remaining `[verify — needs a live call: …]` in §2, §3 and §4
   resolved.** The documentation half is done (2026-07-30): endpoints, scopes,
   request shapes, the 24 h window, the `human_agent` tag and its App-Review +
   Business-Verification gate are all cited above. What is left is strictly
   live-probe work — Standard-Access messaging approval (§2), the outside-window
   error code and the Instagram tag list (§3), and the webhook dependency (§4) —
   folded into `docs/corner-cases.md` as `CC-MSG-*` rows with the error subcodes
   added to `operations.md`.
4. **D3 elicitation shipped and proven**, with messaging exempt from standing
   `IG_WRITE_MODE=apply` consent.
5. **Path decided as A-only** (§2) and the weaker-credential-binding consequence
   written into the operator docs.
6. **Staged delivery accepted:** read-only conversation tools ship first, dark,
   behind their own flag, with `security.md` §5's third-party-data claim rewritten
   honestly; send tools are a *separate* review after reads have run live.

### If the verdict is revisited

This document is the M6 gate. Re-opening M6 means updating this file with the
answers to §7's conditions and re-issuing a verdict here — not adding messaging
work items to the roadmap and treating the review as passed.
