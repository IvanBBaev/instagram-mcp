/**
 * Write acknowledgement checks shared by the write tools (Layer 3).
 *
 * `core/http.ts` maps only a non-2xx response to an error; a 2xx body is handed
 * back as parsed, and the api layer passes it through untouched on purpose
 * (CC-PUB-29: an absent field is reported absent, never back-filled). Deciding
 * whether an acknowledgement actually confirms the write is therefore the tool's
 * job, and it matters most here because {@link withWriteGate} journals every
 * result that is not an error: a write reported as done without an id is both a
 * false "done" for the model and an audit line with no target.
 *
 * One exception on the envelope half: `api/publishing.ts` re-shapes every body
 * it returns (`{ id: r.id }`), which would drop the envelope before it reached
 * this module, so it maps the envelope itself (CC-PUB-53) and the check below is
 * a no-op on its results. The id half still lives here for every write.
 *
 * Two shapes are refused:
 *
 *   - an error envelope delivered with HTTP 200 (`{ error: { ... } }`) — mapped
 *     exactly as `core/http.ts` maps the same envelope on a 4xx/5xx, so the kind,
 *     code and subcode the caller sees do not depend on the status line Meta
 *     happened to send;
 *   - an id-returning write that answered without a usable `id`.
 */
import { InstagramError } from '../core/types.js';
import { mapGraphError } from '../core/errors.js';

/** True when `ack` carries a Graph error envelope (`{ error: { ... } }`). */
function hasErrorEnvelope(ack: unknown): boolean {
  if (typeof ack !== 'object' || ack === null) return false;
  const error = (ack as { error?: unknown }).error;
  return typeof error === 'object' && error !== null;
}

/**
 * Throw the mapped Graph error when a 2xx acknowledgement is really an error
 * envelope. A no-op for every other shape.
 */
export function assertNoErrorEnvelope(ack: unknown): void {
  if (hasErrorEnvelope(ack)) throw mapGraphError(200, ack);
}

/**
 * The `id` an id-returning write acknowledged, or a throw.
 *
 * `what` names the object that should have been created ("media container",
 * "reply"); `consequence` is appended to the refusal and tells the caller what
 * is known about the write's effect — Graph may have performed it even though
 * it answered without an id, and for a publish that means the post may already
 * be live, so the advice must not be "try again".
 */
export function acknowledgedId(ack: unknown, what: string, consequence: string): string {
  assertNoErrorEnvelope(ack);
  const id = typeof ack === 'object' && ack !== null ? (ack as { id?: unknown }).id : undefined;
  if (typeof id === 'string' && id.length > 0) return id;
  throw new InstagramError(
    `Instagram acknowledged the ${what} without returning its id. ${consequence}`,
    { kind: 'upstream' },
  );
}
