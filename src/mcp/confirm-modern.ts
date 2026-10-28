/**
 * D3 human confirmation on the MCP 2026-07-28 revision (multi round-trip
 * `input_required`).
 *
 * The 2026-07-28 revision removed the server-to-client request channel, so the
 * push-style `elicitInput` the 2025-11-25 path uses ({@link serverConfirmer} in
 * `mcp/registry.ts`) throws on a modern instance, and the initialize-time client
 * capabilities it probes do not exist there either. A modern server instead
 * **returns** an `input_required` result that embeds the elicitation; the client
 * asks the human and retries the same `tools/call` with the answer in
 * `inputResponses` and the opaque `requestState` it was handed.
 *
 * This module adapts that two-round flow to the write gate's synchronous-looking
 * {@link WriteConfirmer} seam without touching the gate itself:
 *
 * - **Round 1** (no `requestState`): `ask()` mints a sealed state, parks the
 *   `input_required` result on the per-call confirmer and answers `defer`. The
 *   gate turns `defer` into a refusal (it fails closed on its own), and the
 *   registry swaps the parked result in for that refusal. Nothing ran.
 * - **Round 2** (the retry): `ask()` verifies the state and reads the human's
 *   answer from `inputResponses`; the gate then applies its usual rule — only an
 *   `accept` with `confirm === true` performs the write.
 *
 * `requestState` round-trips through the client, so it is attacker-controlled.
 * It is accepted only when all of these hold, and any failure refuses the write
 * as `unavailable` (never as consent):
 *
 * 1. its HMAC verifies under this process's key (SDK `createRequestStateCodec`,
 *    a random 32-byte key per {@link createModernConfirmFlow});
 * 2. it has not expired (TTL = {@link CONFIRM_TIMEOUT_MS}, the same budget the
 *    2025 path gives the human);
 * 3. its digest matches **this** call — tool, account, arguments and the exact
 *    prompt the human was shown — so an approval for one write cannot be
 *    replayed onto another;
 * 4. its nonce has not been spent: every state answers at most one retry.
 *
 * Only the SDK's own vocabulary is used (`inputRequired`, `inputResponse`,
 * `createRequestStateCodec`); no protocol message is built by hand. A
 * per-process key means the flow only spans one process — true for stdio, the
 * only transport that serves this revision today.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
} from '@modelcontextprotocol/server';
import type {
  ClientCapabilities,
  InputRequiredResult,
  RequestStateCodec,
  ServerContext,
} from '@modelcontextprotocol/server';
import { CONFIRM_TIMEOUT_MS } from './write-mode.js';
import type { ConfirmAnswer, ConfirmPrompt, WriteConfirmer } from './write-mode.js';

/** The `inputRequests` / `inputResponses` key the confirmation travels under. */
export const CONFIRM_INPUT_KEY = 'confirm';

/** What a sealed `requestState` carries: the call digest and a single-use nonce. */
interface ConfirmState {
  d: string;
  n: string;
}

/**
 * The process-wide half of the flow, shared by every tool of one registration:
 * the sealing codec and the spent-nonce ledger.
 */
export interface ModernConfirmFlow {
  readonly codec: RequestStateCodec<ConfirmState>;
  /** Spent nonce → the time (ms) after which its state can no longer verify. */
  readonly spent: Map<string, number>;
  readonly ttlSeconds: number;
  readonly now: () => number;
}

/** Test seams: a shorter (or already-expired) TTL and a controllable clock. */
export interface ModernConfirmFlowOptions {
  ttlSeconds?: number;
  now?: () => number;
}

export function createModernConfirmFlow(opts: ModernConfirmFlowOptions = {}): ModernConfirmFlow {
  const ttlSeconds = opts.ttlSeconds ?? CONFIRM_TIMEOUT_MS / 1000;
  return {
    codec: createRequestStateCodec<ConfirmState>({ key: randomBytes(32), ttlSeconds }),
    spent: new Map(),
    ttlSeconds,
    now: opts.now ?? Date.now,
  };
}

/** What a call is bound to; the digest covers all of it plus the prompt. */
export interface ConfirmBinding {
  tool: string;
  account: string;
  args: unknown;
}

/** A {@link WriteConfirmer} for one modern call, plus the parked round-1 result. */
export interface ModernCallConfirmer extends WriteConfirmer {
  /** The `input_required` result round 1 parked, if `ask()` deferred. */
  pending(): InputRequiredResult | undefined;
}

/** JSON with object keys sorted, so the digest does not depend on key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digestOf(binding: ConfirmBinding, prompt: ConfirmPrompt): string {
  return createHash('sha256')
    .update(
      [
        binding.tool,
        binding.account,
        stableJson(binding.args),
        prompt.message,
        stableJson(prompt.requestedSchema),
      ].join('\0'),
    )
    .digest('base64url');
}

/**
 * Spend a nonce, or throw when it already was. Expired entries are pruned on
 * the way: once a state can no longer verify, its nonce cannot be replayed.
 */
function spend(flow: ModernConfirmFlow, nonce: string): void {
  const now = flow.now();
  for (const [n, until] of flow.spent) if (until <= now) flow.spent.delete(n);
  if (flow.spent.has(nonce)) throw new Error('confirmation state was already used');
  // `exp` is whole seconds and verify compares it against the floored clock, so
  // a state stays valid up to one second past its nominal TTL.
  flow.spent.set(nonce, now + (flow.ttlSeconds + 1) * 1000);
}

/**
 * Build the confirmer for one modern `tools/call`.
 *
 * `isSupported()` reads the capabilities the request itself declares (the
 * 2026 per-request `_meta` envelope): form elicitation, or a bare
 * `elicitation: {}` (which the SDK reads as form). A client that declares only
 * URL elicitation — or none — falls back to the env flags, exactly as on the
 * 2025 path.
 */
export function modernConfirmer(
  flow: ModernConfirmFlow,
  ctx: ServerContext,
  binding: ConfirmBinding,
): ModernCallConfirmer {
  let parked: InputRequiredResult | undefined;
  return {
    isSupported(): boolean {
      // The SDK types the envelope as an opaque `{}`; the era codec has already
      // validated it against the 2026-07-28 envelope schema.
      const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
      const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
      const elicitation = caps?.elicitation;
      if (elicitation === undefined) return false;
      return elicitation.form !== undefined || elicitation.url === undefined;
    },
    async ask(prompt: ConfirmPrompt): Promise<ConfirmAnswer> {
      const digest = digestOf(binding, prompt);
      const state = ctx.mcpReq.requestState<string>();
      if (state === undefined) {
        const requestState = await flow.codec.mint({ d: digest, n: randomUUID() });
        parked = inputRequired({
          inputRequests: {
            [CONFIRM_INPUT_KEY]: inputRequired.elicit({
              message: prompt.message,
              requestedSchema: prompt.requestedSchema,
            }),
          },
          requestState,
        });
        return { action: 'defer' };
      }
      const sealed = await flow.codec.verify(state, ctx);
      if (sealed.d !== digest) throw new Error('confirmation state does not match this call');
      spend(flow, sealed.n);
      const answer = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_INPUT_KEY);
      if (answer.kind !== 'elicit') throw new Error('the retry carried no confirmation answer');
      return { action: answer.action, content: answer.content };
    },
    pending: () => parked,
  };
}
