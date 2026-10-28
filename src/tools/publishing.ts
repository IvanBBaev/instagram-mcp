/**
 * Publishing tool specs (Layer 3) — the `publishing` package. Two granular
 * primitives plus three convenience composites over the two-phase Instagram
 * publish flow (create container → poll → publish), and the one way to take a
 * published media object back down:
 *
 *   - instagram_create_media_container   (write) low-level container create
 *   - instagram_get_container_status     (read)  poll a container's state
 *   - instagram_publish_media            (write) publish a finished container
 *   - instagram_get_publishing_limit     (read)  rolling-window quota
 *   - instagram_post_image               (write) image/carousel: create→publish
 *   - instagram_post_reel                (write) reel: create→poll→publish
 *   - instagram_post_story               (write) story: create→poll→publish
 *   - instagram_delete_media             (write) DESTRUCTIVE: delete published media
 *
 * Every mutation passes through `withWriteGate`: a **preview** (the
 * default) describes exactly what would happen and calls NOTHING (no container
 * create, no `media_publish`); an **apply** run performs it and is journaled.
 * A composite that is still processing when the poll budget elapses returns a
 * non-error `in_progress` result carrying `resume_container_id` — `media_publish`
 * is NEVER auto-retried, so the operator resumes explicitly rather than risking
 * a duplicate post (docs/operations.md §2, architecture §10).
 * That flow — resume arm, write gate, outcomes, failure re-attachment — is one
 * shape for all three composites and lives in `tools/publish-flow.ts`
 * (`runComposite`); each composite supplies only its validation, the
 * preview of a new post and its container create.
 * `instagram_delete_media` is the package's only destructive tool and is
 * additionally gated by `IG_ALLOW_DESTRUCTIVE`, like `instagram_delete_comment`.
 *
 * The server never fetches user-supplied media URLs (SSRF policy), so only
 * structural checks are possible here — https URL form, caption limits, carousel
 * bounds. Pixel format, byte size, aspect ratio, and video duration cannot be
 * verified until Instagram fetches the URL at container creation. The one hint
 * available pre-fetch is the URL's extension, and it is applied uniformly:
 * EVERY still-image field — `imageUrl`, each carousel url, the story image and
 * the reel `coverUrl` — goes through `imageUrlFormatWarning` and surfaces
 * through `details.warnings` in the preview and `warnings` in the applied result
 * (CC-PUB-25 (a)). A video extension on one of those fields draws its own
 * sentence (CC-PUB-23). Video fields get no hint: a video extension is exactly
 * right there, and a field warned in one tool but not in another would teach a
 * rule that does not exist.
 *
 * The preview an operator approves for a composite post shows the caption
 * itself — a sanitised, truncated excerpt beside its counts — and the HOST of
 * every media URL, never its path or query, which may carry a signature
 * (CC-PUB-60, CC-PUB-8). A resume that was also handed media inputs says which
 * ones it ignores (CC-PUB-59).
 *
 * The tools live in three modules by concern, over the input fields and helpers
 * they share in `tools/publishing-shared.ts`:
 *
 *   - `tools/publishing-containers.ts`   the four granular container tools
 *   - `tools/publishing-composites.ts`   the three one-call post tools
 *   - `tools/publishing-delete.ts`       the destructive delete
 *
 * This module keeps the package's public name: it exports the aggregate
 * `publishingTools` in the order the registry and its pinned tool-order tests
 * expect.
 */
import type { ToolSpec } from '../mcp/define.js';
import { publishingContainerTools } from './publishing-containers.js';
import { publishingCompositeTools } from './publishing-composites.js';
import { publishingDeleteTools } from './publishing-delete.js';

/** Publishing tools, registered by `mcp/registry.ts`. */
export const publishingTools: readonly ToolSpec[] = Object.freeze([
  ...publishingContainerTools,
  ...publishingCompositeTools,
  ...publishingDeleteTools,
]);
