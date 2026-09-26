/**
 * Publishing domain functions (Layer 1). The Instagram publish flow is
 * **two-phase**: create a media container (Meta ingests the media from a public
 * URL), then publish that container. These are pure functions over the injected
 * {@link IgRequestFn} seam plus an injectable {@link Clock} for the composite's
 * poll budget — no `core/http`, no `mcp`/`tools` imports.
 *
 * Verified Graph semantics (docs/tools.md, docs/operations.md, 2026-07-21):
 *   - a **feed image** container sends `image_url` with **no `media_type`**
 *     (`IMAGE`/`VIDEO` are invalid values); Reels/Stories/Carousel send theirs;
 *   - status_code ∈ IN_PROGRESS / FINISHED / ERROR / EXPIRED / PUBLISHED;
 *     subcode 2207027 = still processing → keep polling, never re-create;
 *   - the publishing quota total is read at **runtime** from `config.quota_total`
 *     (Meta docs conflict 100 vs 50 — never hardcoded); a carousel counts as 1;
 *   - `media_publish` is **never** auto-retried (duplicate-post risk).
 *
 * Content publishing works on BOTH auth paths, so host is left to the active
 * auth provider's default (no `host` override, no `paths` restriction).
 */
import type { GraphListResponse, IgRequestFn } from '../core/types.js';
import { InstagramError, isInstagramError } from '../core/types.js';
import type { Clock } from '../core/clock.js';
import { mapGraphError, quoteGraphId, quoteGraphText } from '../core/errors.js';
import { describeWireValue } from '../core/time.js';
import type { ContainerMediaType, UserTag } from './media-spec.js';

// --- Graph body guard ---------------------------------------------------------

/**
 * A 2xx Graph body as a record whose fields can be read, or a throw.
 *
 * `req` casts the body rather than validating it, and `core/http.ts` maps only a
 * non-2xx status to an error, so two off-contract shapes reach this module:
 *
 *   - a Graph error envelope delivered with HTTP 200 (`{ error: { ... } }`,
 *     CC-PUB-53). It is mapped here exactly as `core/http.ts` maps the same
 *     envelope on a 4xx/5xx (and as `tools/ack.ts` does for the other write
 *     tools). Mapping it at the tool layer is too late for this module: every
 *     function below re-shapes the body (`{ id: r.id }`), which dropped the
 *     envelope before the tool's check could see it, so Meta's real diagnosis
 *     was reported as a bare "no id" — and a carousel child built from it went
 *     into the album as `undefined`;
 *   - a body that is not an object at all (JSON `null`, a number, a non-JSON
 *     text body). Its fields are ABSENT, and are reported as such — reading a
 *     property off `null` used to crash the call with a raw TypeError
 *     (CC-PUB-54).
 *
 * Fields are NOT type-checked here: an absent or malformed `id` is passed
 * through for the caller to refuse with its own consequence text (CC-PUB-29).
 */
function graphBody(body: unknown): Record<string, unknown> {
  // Equivalent-mutant note: dropping `typeof body !== 'object'` (keeping only the
  // null test) is unobservable — a scalar body has no `error` or `id` property,
  // so it reads as the same empty acknowledgement either way. The guard keeps
  // the declared return type honest.
  if (typeof body !== 'object' || body === null) return {};
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'object' && error !== null) throw mapGraphError(200, body);
  return body as Record<string, unknown>;
}

// --- create_media_container -------------------------------------------------

export interface CreateContainerParams {
  /** IG professional-account id, or `me`. */
  igId: string;
  /** Omit for a feed image (sends NO `media_type`); set for Reels/Stories/Carousel. */
  mediaType?: ContainerMediaType;
  imageUrl?: string;
  videoUrl?: string;
  caption?: string;
  locationId?: string;
  userTags?: UserTag[];
  /** Carousel album: 2–10 child container ids (validated at the tool layer). */
  children?: string[];
  /** Reels cover image URL. */
  coverUrl?: string;
  /** Reels/video: cover frame offset in milliseconds. */
  thumbOffset?: number;
  /** Reels: also cross-post to the feed. */
  shareToFeed?: boolean;
  /** Marks a container as a carousel item during album child creation. */
  isCarouselItem?: boolean;
}

/**
 * `POST /{ig-id}/media` — create a media container. Returns its id. A feed image
 * intentionally omits `media_type`. Array-valued fields are serialized the way
 * Graph expects: `children` as a comma-separated list, `user_tags` as JSON.
 */
export async function createMediaContainer(
  req: IgRequestFn,
  params: CreateContainerParams,
): Promise<{ id: string }> {
  const p: Record<string, string | number | boolean | undefined> = {};
  // Equivalent-mutant note: every arm whose right-hand side is a param value is
  // guarded by an exact `!== undefined` test, so a `??` fallback on that side
  // (`params.mediaType ?? 'IMAGE'`, `params.caption ?? ''`, …) is unreachable and
  // cannot change a single request. The one arm that is NOT such a test —
  // `isCarouselItem === true` — assigns the literal `true`, so there is no param
  // value on its right-hand side for a fallback to attach to at all.
  // Defaults for these fields deliberately do not live here: they belong at the
  // tool layer, where they show up in the preview an operator approves.
  if (params.mediaType !== undefined) p.media_type = params.mediaType;
  if (params.imageUrl !== undefined) p.image_url = params.imageUrl;
  if (params.videoUrl !== undefined) p.video_url = params.videoUrl;
  if (params.caption !== undefined) p.caption = params.caption;
  if (params.locationId !== undefined) p.location_id = params.locationId;
  if (params.coverUrl !== undefined) p.cover_url = params.coverUrl;
  if (params.thumbOffset !== undefined) p.thumb_offset = params.thumbOffset;
  if (params.shareToFeed !== undefined) p.share_to_feed = params.shareToFeed;
  if (params.isCarouselItem === true) p.is_carousel_item = true;
  if (params.children !== undefined) p.children = params.children.join(',');
  if (params.userTags !== undefined) p.user_tags = JSON.stringify(params.userTags);

  const r = graphBody(
    await req<unknown>({
      method: 'POST',
      path: `/${encodeURIComponent(params.igId)}/media`,
      params: p,
    }),
  );
  // Passed through unchecked on purpose (CC-PUB-29): the tool layer refuses an
  // id-less ack with the consequence text only it can word.
  return { id: r.id as string };
}

/**
 * Turn a mid-carousel failure into an error that names what was left behind.
 *
 * A carousel is several independent writes with no transaction around them: the
 * child containers created before the failure survive it. Instagram exposes **no
 * delete for a media container** — the only DELETE in this API surface is a
 * comment — so there is nothing to call to undo them, and a "cleanup" here would
 * mean inventing an endpoint. What is true instead (docs/operations.md,
 * docs/corner-cases.md CC-PUB-3/5): an unpublished container expires by itself
 * within 24 h and consumes no publishing quota, so the leak is bounded and free.
 * The residual harm is a caller who cannot tell which containers now exist —
 * that is what this reports.
 *
 * The original message is kept as a literal prefix and `kind`/`status`/`code`/
 * `subcode`/`fbtraceId`/`cause` are carried over unchanged, so the first failure
 * — the one the caller has to act on — is never masked or reclassified. The
 * failing URL is deliberately NOT echoed: a pre-signed media URL carries
 * credentials in its query string (CC-PUB-8).
 */
function carouselAbortError(err: unknown, step: string, orphaned: string[]): InstagramError {
  const graph = isInstagramError(err) ? err : undefined;
  const originalMessage = graph?.message ?? String(err);
  const leftBehind =
    orphaned.length === 0
      ? 'No child container was created, so nothing was left behind.'
      : `Orphaned child containers (${orphaned.length}): ${orphaned.map(quoteGraphId).join(', ')}. ` +
        'They cannot be deleted (Instagram has no container delete), but an unpublished ' +
        'container expires by itself within 24 h and costs no publishing quota.';
  return new InstagramError(
    `${originalMessage} — carousel aborted while creating ${step}. ${leftBehind}`,
    {
      // Equivalent-mutant note: `??` and `||` cannot differ here — `kind` is a
      // union of non-empty string literals, so the only value that would take
      // the `||` fallback but not the `??` one cannot exist.
      kind: graph?.kind ?? 'upstream',
      status: graph?.status,
      code: graph?.code,
      subcode: graph?.subcode,
      fbtraceId: graph?.fbtraceId,
      cause: err,
    },
  );
}

/**
 * Create a carousel album: one child container per image URL (each marked
 * `is_carousel_item`), then the album container (`media_type=CAROUSEL`) that
 * references them (CC-PUB-5/6). Child images send NO `media_type` (they are
 * feed images). Returns the album id plus the child ids created.
 *
 * On any failure the already-created children are reported by id in the thrown
 * error rather than silently abandoned — see {@link carouselAbortError}.
 *
 * Each child's acknowledgement is checked HERE, not left to the tool layer the
 * way the album's is: a child id is consumed immediately, as an element of the
 * album's `children` list, so an ack without a usable id would otherwise reach
 * Graph as the literal `undefined` inside `children=` — an album built from a
 * container that does not exist. Such an ack aborts the carousel like any other
 * child failure (CC-PUB-51).
 */
export async function createCarouselContainer(
  req: IgRequestFn,
  params: { igId: string; childImageUrls: string[]; caption?: string; locationId?: string },
): Promise<{ id: string; childIds: string[] }> {
  const childIds: string[] = [];
  const total = params.childImageUrls.length;
  for (const [index, imageUrl] of params.childImageUrls.entries()) {
    try {
      const child = await createMediaContainer(req, {
        igId: params.igId,
        imageUrl,
        isCarouselItem: true,
      });
      if (typeof child.id !== 'string' || child.id === '') {
        throw new InstagramError(
          'Instagram acknowledged a carousel child container without returning its id (one ' +
            'Graph may have made without reporting it cannot be named, and expires unpublished ' +
            'within 24 h)',
          { kind: 'upstream' },
        );
      }
      childIds.push(child.id);
    } catch (err) {
      throw carouselAbortError(err, `child ${index + 1} of ${total}`, childIds);
    }
  }
  try {
    const album = await createMediaContainer(req, {
      igId: params.igId,
      mediaType: 'CAROUSEL',
      children: childIds,
      caption: params.caption,
      locationId: params.locationId,
    });
    return { id: album.id, childIds };
  } catch (err) {
    throw carouselAbortError(err, 'the album container', childIds);
  }
}

// --- get_container_status ---------------------------------------------------

/** Container processing state. `statusCode` is an open enum (string). */
export interface ContainerStatus {
  id: string;
  /** IN_PROGRESS / FINISHED / ERROR / EXPIRED / PUBLISHED (open enum). */
  statusCode?: string;
  /** Human-readable status detail, populated by Meta on ERROR. */
  status?: string;
}

/** The value itself when it is a string, otherwise `undefined`. */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * `GET /{container-id}?fields=status_code,status`. Read-only, idempotent.
 *
 * `req` casts the body rather than validating it, so `status_code`/`status` hold
 * whatever Graph sent. A value that is not a string (JSON `null`, a number) is
 * reported as ABSENT: passed through, a `null` failed the tool's
 * `z.string().optional()` output schema, and a number crashed
 * {@link runPublishFlow} with a raw TypeError from `.toUpperCase()` instead of
 * the unknown-status verdict its deadline is there to give.
 */
export async function getContainerStatus(
  req: IgRequestFn,
  params: { containerId: string },
): Promise<ContainerStatus> {
  const r = graphBody(
    await req<unknown>({
      method: 'GET',
      path: `/${encodeURIComponent(params.containerId)}`,
      params: { fields: 'status_code,status' },
    }),
  );
  // `id` is REQUIRED in the tool's output, so an absent, non-string or empty id
  // failed the whole read as `MCP error -32602` and the status that did arrive
  // was lost with it. This is a read of `/{containerId}` itself, so the object
  // answering is the container that was asked about and the requested id is
  // the honest one to report; a usable id Graph does send still wins, as in
  // `instagram_get_account` (CC-DATA-76).
  return {
    id: typeof r.id === 'string' && r.id !== '' ? r.id : params.containerId,
    statusCode: stringOrUndefined(r.status_code),
    status: stringOrUndefined(r.status),
  };
}

// --- publish_media ----------------------------------------------------------

/**
 * `POST /{ig-id}/media_publish?creation_id={container-id}` — publish a finished
 * container. Returns the new media id. NEVER auto-retried by any caller: a
 * duplicate post costs quota and is publicly visible (docs/operations.md §2).
 */
export async function publishMedia(
  req: IgRequestFn,
  params: { igId: string; creationId: string },
): Promise<{ id: string }> {
  const r = graphBody(
    await req<unknown>({
      method: 'POST',
      path: `/${encodeURIComponent(params.igId)}/media_publish`,
      params: { creation_id: params.creationId },
    }),
  );
  return { id: r.id as string };
}

// --- get_publishing_limit ---------------------------------------------------

export interface PublishingLimit {
  /** Containers published in the rolling window (a carousel counts as 1). */
  quotaUsage: number;
  /** Total allowance — read at runtime from `config.quota_total`, never hardcoded. */
  quotaTotal?: number;
  /** Rolling-window length in seconds, from `config.quota_duration`. */
  quotaDuration?: number;
  /** `quotaTotal - quotaUsage` when the total is known; otherwise absent. */
  remaining?: number;
}

interface PublishingLimitRow {
  quota_usage?: unknown;
  config?: { quota_total?: unknown; quota_duration?: unknown };
}

/** The value itself when it is a finite number, otherwise `undefined`. */
function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config`. The quota
 * total is taken from `config.quota_total` at runtime (Meta docs conflict on the
 * number, so it is never hardcoded); `remaining` is derived only when known.
 */
export async function getPublishingLimit(
  req: IgRequestFn,
  params: { igId: string },
): Promise<PublishingLimit> {
  const res = graphBody(
    await req<unknown>({
      method: 'GET',
      path: `/${encodeURIComponent(params.igId)}/content_publishing_limit`,
      params: { fields: 'quota_usage,config' },
    }),
  ) as Partial<GraphListResponse<PublishingLimitRow>>;
  // An EMPTY row list is the one silence read as a measurement: it is Meta
  // saying it has nothing on record for this window, i.e. nothing published, and
  // that reading is kept deliberately (pinned in the api tests). Everything else
  // that carries no usage is refused below.
  if (Array.isArray(res.data) && res.data.length === 0) return { quotaUsage: 0 };
  // Equivalent-mutant note: the `??` on `row` survives being rewritten as `||`,
  // and no test can tell the difference: a row that is falsy-but-not-nullish
  // (`0`, `''`) has no `quota_usage` and no `config` either, so it reads out
  // exactly like the `{}` fallback, and that fallback is refused below.
  const row = res.data?.[0] ?? {};
  const quotaUsage = row.quota_usage;
  // Unlike the two config fields below, `quota_usage` is REQUIRED in the tool's
  // output, so a value that is not a finite number cannot be reported as
  // absent, and reporting it as 0 would claim a whole allowance nobody measured.
  // Passed through, a string failed the output schema (`MCP error -32602`) and
  // derived `remaining: NaN`. It is refused as what it is: a malformed answer.
  //
  // A MISSING or null usage is refused the same way, and so is a body with no
  // `data` envelope at all. Both used to read as a measured 0
  // (`quota_usage ?? 0`), which put `remaining` at the full allowance on an
  // account that may have none of it left: the one answer this tool exists to
  // get right, invented from a field Meta did not send.
  if (quotaUsage === undefined || quotaUsage === null) {
    throw new InstagramError(
      'Instagram did not report a quota_usage, so the publishing quota cannot be stated. ' +
        'Retry later.',
      { kind: 'upstream' },
    );
  }
  if (typeof quotaUsage !== 'number' || !Number.isFinite(quotaUsage)) {
    throw new InstagramError(
      `Instagram reported a quota_usage of ${describeWireValue(quotaUsage)}, which is not a ` +
        'number, so the publishing quota cannot be stated. Retry later.',
      { kind: 'upstream' },
    );
  }
  // A total or window that is not a finite number (JSON `null`, a string) is not
  // KNOWN, so it is reported as absent. Passed through, a `null` total derived
  // `remaining: Math.max(0, null - usage)` = 0 — "quota exhausted" on an
  // account that may have its whole allowance left — and a `null` in either
  // field failed the tool's `z.number().optional()` output schema outright.
  const quotaTotal = finiteOrUndefined(row.config?.quota_total);
  const quotaDuration = finiteOrUndefined(row.config?.quota_duration);
  const limit: PublishingLimit = { quotaUsage };
  if (quotaTotal !== undefined) {
    limit.quotaTotal = quotaTotal;
    limit.remaining = Math.max(0, quotaTotal - quotaUsage);
  }
  if (quotaDuration !== undefined) limit.quotaDuration = quotaDuration;
  return limit;
}

// --- composite publish flow (create → poll → publish) -----------------------

/**
 * Internal (non-tool-input) poll budget. `maxPollMs = 0` is used by tests to hit
 * the resumable in-progress path with no real wait; the happy path returns
 * FINISHED on the first status check and never sleeps.
 */
export interface PublishFlowOptions {
  pollIntervalMs?: number;
  maxPollMs?: number;
}

/** Cadence and total budget used when the caller names neither — the production case. */
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_POLL_MS = 60000;

/**
 * Resolve one poll-budget option to a duration the loop can actually finish on.
 *
 * `maxPollMs` becomes a deadline that the loop compares `clock.now()` against,
 * so a non-finite value is not a generous budget — it is no budget at all:
 * `now >= NaN` and `now >= Infinity` are both permanently false, and the flow
 * then polls Meta for as long as the process lives. A negative `pollIntervalMs`
 * is the same failure one level down (`setTimeout` treats it as zero), turning
 * a paced poll into a spin against a rate-limited edge.
 *
 * Neither value is reachable today, and that is the point of documenting it
 * here: {@link PublishFlowOptions} is internal, no tool input feeds it, and the
 * three composite post tools call {@link runPublishFlow} with `{}` — so this
 * guards the seam rather than fixing a live path. It falls back to the
 * documented default instead of throwing because the only caller is a
 * programmer and the safe reading of "this budget is not a duration" is the
 * budget the docs promise. `0` is deliberately NOT such a value: it is the
 * supported "check once, then report in_progress" budget the suite runs on.
 */
function pollDurationMs(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

/** Upper bound on how much of an unrecognised `status_code` is echoed back. */
const MAX_ECHOED_CODE = 40;

/**
 * Upper bound on how much of an ERROR container's free-text `status` is echoed
 * back. Meta's detail is a sentence ("Media download failed", or an error-code
 * line); this leaves room for any real one while keeping an unbounded upstream
 * string out of the tool result an agent reads.
 */
const MAX_ECHOED_STATUS = 200;

/**
 * The budget is spent and the container never once reported a status this build
 * recognises.
 *
 * Answering `in_progress` here is the one outcome that cannot be acted on. It is
 * the same shape the flow returns for a container Meta actually calls
 * IN_PROGRESS, and the tool layer renders it as "re-run with resumeContainerId
 * to finish publishing" — but a resume re-enters this loop, reads the same
 * unreadable status, spends another full budget of Graph reads and returns the
 * same non-answer. Nothing in that chain can end it, because nothing in it ever
 * changes: a container that really is processing eventually says FINISHED or
 * ERROR, whereas a code this build has never seen, a `status_code` the token may
 * not read, or a response carrying no `status_code` at all will read the same
 * way on every attempt, forever.
 *
 * So the flow reports what it knows — the state is unknown — as an
 * `upstream` error: the request was well formed and the answer is the problem.
 * The message names the container, the house pattern of the ERROR/EXPIRED arms,
 * which also keeps the tool layer's "you can resume this" addendum off a state
 * it does not apply to. Unlike those two arms it must NOT say to re-create the
 * container: this container may be perfectly healthy and even published, and
 * posting again is the one irreversible mistake available here.
 */
function unknownStatusError(containerId: string, code: string, budgetMs: number): InstagramError {
  // Upstream free text on its way into a tool result an agent reads: quoted and
  // bounded by `quoteGraphText` (`core/errors.ts`), the one rule every Graph
  // string follows before it is interpolated into a sentence (CC-DATA-95).
  //
  // Equivalent-mutant note: `code === ''` cannot be told from `!code`. The caller
  // hands this the result of a `.toUpperCase()`, so `code` is always a string,
  // and the empty string is the only falsy string — no argument separates the
  // two forms. The explicit comparison stays because it names the one case it
  // means, "Graph sent no code at all", rather than a general falsiness that
  // this parameter can never otherwise exhibit.
  const lastSeen =
    code === '' ? 'no status_code field at all' : quoteGraphText(code, MAX_ECHOED_CODE);
  return new InstagramError(
    `Container ${quoteGraphId(containerId)} never reported a recognised status_code within its ${budgetMs} ms ` +
      `poll budget (last answer: ${lastSeen}; the codes this build knows are IN_PROGRESS, ` +
      'FINISHED, ERROR, EXPIRED, PUBLISHED). Its state is unknown, so it is NOT reported as still ' +
      'processing: resuming it would read the same unreadable status again. Do NOT post it again ' +
      '— read the container status directly, publish this same container id if it reports ' +
      'FINISHED, and re-create it only if it reports ERROR or EXPIRED.',
    { kind: 'upstream' },
  );
}

/**
 * The three terminal outcomes of {@link runPublishFlow}.
 *
 * `already_published` deliberately carries **no `mediaId`**: it is reached only
 * from a container whose `status_code` is PUBLISHED, and that edge returns
 * `id`/`status_code`/`status` and nothing else — the id it reports is the
 * container's, not the published media's. Meta documents no already-published
 * error subcode either (CC-PUB-4), so there is no second response to read one
 * from. Callers that need the media id must look it up (`GET /{ig-id}/media`);
 * the tool layer surfaces the gap explicitly instead of inventing an id.
 */
export type PublishFlowResult =
  | { status: 'published'; containerId: string; mediaId: string }
  | { status: 'in_progress'; containerId: string }
  | { status: 'already_published'; containerId: string };

/**
 * Drive one container to publish: create it (or resume `resumeContainerId`
 * without re-creating — CC-PUB-2), poll its status against a deadline of
 * `clock.now() + maxPollMs`, then publish once it is FINISHED.
 *
 *   - FINISHED         → publish → `{ status: 'published', mediaId }`.
 *   - PUBLISHED        → `{ status: 'already_published' }` — never re-published
 *                        (the duplicate-post guard for a resumed container).
 *   - ERROR / EXPIRED  → throws {@link InstagramError}.
 *   - IN_PROGRESS at the deadline → `{ status: 'in_progress', containerId }` so
 *                        the caller can resume — NOT an error, NOT a retry.
 *   - never a recognised code by the deadline → throws (see
 *                        {@link unknownStatusError}): "resume me" would be a
 *                        non-answer that no number of resumes can resolve.
 *
 * The status check runs BEFORE any sleep, so a container that is already
 * FINISHED (typical for images) publishes with zero waiting. `maxPollMs` is a
 * floor on how long the loop keeps trying, not a ceiling on how long it takes:
 * the deadline is tested between polls, so the last sleep and the request after
 * it can carry the flow up to one poll interval plus one request past it.
 */
export async function runPublishFlow(
  deps: { req: IgRequestFn; clock: Clock; igId: string },
  args: { resumeContainerId?: string; createContainer: () => Promise<string> },
  opts: PublishFlowOptions = {},
): Promise<PublishFlowResult> {
  const pollIntervalMs = pollDurationMs(opts.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const maxPollMs = pollDurationMs(opts.maxPollMs, DEFAULT_MAX_POLL_MS);
  const { req, clock, igId } = deps;

  const containerId = args.resumeContainerId ?? (await args.createContainer());
  const deadline = clock.now() + maxPollMs;
  // Has Meta ever called this container IN_PROGRESS? It is the only recognised
  // code that does not leave the loop, so it is the only evidence that "keep
  // polling" — and the resumable `in_progress` the deadline ends in — describes
  // a container that is really moving rather than one we cannot read at all.
  let seenInProgress = false;

  // Equivalent-mutant note: the four terminal arms below all compare the SAME
  // normalised `code` against four distinct literals, so no input can satisfy
  // two of them. Permuting the arms is an equivalent mutant — no test can
  // separate the orders, and one asserting a particular order would only be
  // asserting the source. They are written in the sequence a healthy container
  // walks through, not in a load-bearing one.
  for (;;) {
    const st = await getContainerStatus(req, { containerId });
    // Equivalent-mutant note: `??` → `||` is undetectable here too.
    // {@link getContainerStatus} hands back `statusCode` as a string or
    // `undefined` and nothing else — a non-string `status_code` from the wire is
    // dropped there — so the only falsy value that reaches this line is `''`,
    // which the fallback maps to `''` anyway, and both readings of a missing code
    // end at the same place: not one of the four terminal literals, so the loop
    // keeps polling and the deadline decides.
    const code = (st.statusCode ?? '').toUpperCase();
    if (code === 'FINISHED') break;
    if (code === 'PUBLISHED') return { status: 'already_published', containerId };
    if (code === 'ERROR') {
      // Meta's detail is upstream free text, so it is quoted and bounded like
      // the unknown-code echo in {@link unknownStatusError} (CC-PUB-52).
      const detail = st.status ? `: ${quoteGraphText(st.status, MAX_ECHOED_STATUS)}` : '';
      throw new InstagramError(
        `Container ${quoteGraphId(containerId)} failed processing (status ERROR${detail}); re-create it.`,
        { kind: 'upstream' },
      );
    }
    if (code === 'EXPIRED') {
      throw new InstagramError(
        `Container ${quoteGraphId(containerId)} expired before it was published; re-create it.`,
        { kind: 'validation' },
      );
    }
    if (code === 'IN_PROGRESS') seenInProgress = true;
    // IN_PROGRESS (or an unknown/empty code) — keep polling within the budget.
    // An unknown code is still never treated as terminal: `status_code` is an
    // open enum, and guessing that a code we do not know means "finished" would
    // publish a container that never processed. What it changes is only what the
    // deadline is allowed to claim once the budget is gone.
    if (clock.now() >= deadline) {
      if (seenInProgress) return { status: 'in_progress', containerId };
      throw unknownStatusError(containerId, code, maxPollMs);
    }
    await clock.sleep(pollIntervalMs);
  }

  const published = await publishMedia(req, { igId, creationId: containerId });
  return { status: 'published', containerId, mediaId: published.id };
}
