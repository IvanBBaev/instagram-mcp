/**
 * D3 human confirmation on the MCP 2026-07-28 revision: the write gate's
 * confirmation travels as a multi round-trip `input_required` result instead
 * of a server-to-client `elicitation/create` request.
 *
 * End to end, a real SDK client talks to a real `serveStdio` dual-era server
 * over an in-memory pair. Round 1 must never perform the write; the retry is
 * accepted only with the server's own sealed, unexpired, call-bound, unspent
 * `requestState`, and only an explicit `confirm: true` performs it. Every
 * failure refuses as `unavailable`, never as consent. No network: the request
 * factory records calls and answers locally; the journal is a temp path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import type { ClientCapabilities } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import type { ProtocolEra, ServerContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { registerTools } from '../../src/mcp/registry.js';
import {
  createModernConfirmFlow,
  modernConfirmer,
  stableJson,
} from '../../src/mcp/confirm-modern.js';
import type { ConfirmPrompt } from '../../src/mcp/write-mode.js';
import type {
  IgRequestFn,
  IgRequestOptions,
  Logger,
  ResolvedProfile,
} from '../../src/core/types.js';
import { allTools } from '../../src/tools/index.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { testSettings } from '../helpers/settings.js';

interface LogLine {
  level: string;
  msg: string;
}

function recordingLog(lines: LogLine[]): Logger {
  const log: Logger = {
    debug(msg) {
      lines.push({ level: 'debug', msg });
    },
    info(msg) {
      lines.push({ level: 'info', msg });
    },
    warn(msg) {
      lines.push({ level: 'warn', msg });
    },
    error(msg) {
      lines.push({ level: 'error', msg });
    },
    child() {
      return log;
    },
  };
  return log;
}

const profiles: ResolvedProfile[] = [{ name: 'default', authPath: 'ig-login', accessToken: 'tok' }];

const TOOL = 'instagram_reply_to_comment';
const ARGS = { commentId: '17890000000000001', message: 'thanks!', apply: true };

interface Harness {
  client: Client;
  posts: IgRequestOptions[];
  eras: ProtocolEra[];
  log: LogLine[];
  close(): Promise<void>;
}

interface HarnessOptions {
  mode?: 'legacy' | { pin: '2026-07-28' };
  capabilities?: ClientCapabilities;
  answer?: {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, string | number | boolean | string[]>;
  };
  manual?: boolean;
  writeMode?: 'apply' | 'preview';
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const posts: IgRequestOptions[] = [];
  const eras: ProtocolEra[] = [];
  const log: LogLine[] = [];
  const request = (async (o: IgRequestOptions) => {
    posts.push(o);
    return { id: 'reply-1' };
  }) as IgRequestFn;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    ({ era }) => {
      eras.push(era);
      const server = new McpServer({ name: 'instagram-mcp-ai-test', version: '0.0.0' });
      registerTools({
        server,
        tools: allTools,
        profiles,
        defaultProfileName: 'default',
        settings: testSettings({ writeMode: opts.writeMode ?? 'preview' }),
        clock: fakeClock(Date.UTC(2026, 9, 28)),
        log: recordingLog(log),
        makeRequest: () => request,
        env: { IG_TOOL_PACKAGES: 'all' },
        era,
      });
      return server;
    },
    { transport: serverTransport },
  );
  const client = new Client(
    { name: 'confirm-modern-test-client', version: '0.0.0' },
    {
      capabilities: opts.capabilities ?? { elicitation: { form: {} } },
      versionNegotiation: { mode: opts.mode ?? { pin: '2026-07-28' } },
      ...(opts.manual === true ? { inputRequired: { autoFulfill: false } } : {}),
    },
  );
  if (opts.capabilities?.elicitation !== undefined || opts.capabilities === undefined) {
    client.setRequestHandler(
      'elicitation/create',
      async () => opts.answer ?? { action: 'decline' },
    );
  }
  await client.connect(clientTransport);
  return {
    client,
    posts,
    eras,
    log,
    async close() {
      await client.close();
      await handle.close();
    },
  };
}

function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

interface Pending {
  resultType: string;
  inputRequests: Record<string, { method: string; params: { message: string } }>;
  requestState: string;
}

async function roundOne(h: Harness, args: Record<string, unknown> = ARGS): Promise<Pending> {
  const pending = (await h.client.callTool(
    { name: TOOL, arguments: args },
    { allowInputRequired: true },
  )) as unknown as Pending;
  assert.equal(pending.resultType, 'input_required');
  return pending;
}

async function retry(
  h: Harness,
  pending: { requestState?: string },
  inputResponses: Record<string, unknown> | undefined,
  args: Record<string, unknown> = ARGS,
): Promise<Record<string, unknown>> {
  const result = await h.client.callTool(
    {
      name: TOOL,
      arguments: args,
      ...(inputResponses !== undefined ? { inputResponses } : {}),
      ...(pending.requestState !== undefined ? { requestState: pending.requestState } : {}),
    },
    { allowInputRequired: true },
  );
  return payloadOf(result);
}

const REPLIED = { replyId: 'reply-1', parentCommentId: ARGS.commentId };
const ACCEPT = { confirm: { action: 'accept', content: { confirm: true } } };

test('modern client: an accepted confirmation performs the write after the retry', async () => {
  const h = await harness({ answer: { action: 'accept', content: { confirm: true } } });
  try {
    const result = await h.client.callTool({ name: TOOL, arguments: ARGS });
    assert.deepEqual(payloadOf(result), REPLIED);
    assert.equal(h.posts.length, 1, 'exactly one POST: round 1 never performs the write');
    assert.equal(h.posts[0]!.method, 'POST');
    assert.equal(h.posts[0]!.path, `/${ARGS.commentId}/replies`);
    assert.deepEqual(h.eras, ['modern']);
    assert.ok(h.log.some((l) => l.msg.includes('handed to the client (input_required)')));
    assert.ok(h.log.some((l) => l.msg === 'write confirmed by the operator'));
  } finally {
    await h.close();
  }
});

for (const [answer, reason] of [
  [{ action: 'decline' as const }, 'declined'],
  [{ action: 'cancel' as const }, 'cancelled'],
  [{ action: 'accept' as const, content: { confirm: false } }, 'declined'],
] as const) {
  test(`modern client: ${JSON.stringify(answer)} refuses as ${reason} and sends nothing`, async () => {
    const h = await harness({ answer });
    try {
      const payload = payloadOf(await h.client.callTool({ name: TOOL, arguments: ARGS }));
      assert.equal(payload.mode, 'refused');
      assert.equal(payload.reason, reason);
      assert.equal(h.posts.length, 0);
    } finally {
      await h.close();
    }
  });
}

test('round 1 returns input_required carrying the D3 prompt and a sealed state, and sends nothing', async () => {
  const h = await harness({ manual: true });
  try {
    const pending = await roundOne(h);
    assert.deepEqual(Object.keys(pending.inputRequests), ['confirm']);
    assert.equal(pending.inputRequests.confirm!.method, 'elicitation/create');
    assert.match(pending.inputRequests.confirm!.params.message, /confirm a write to Instagram/);
    assert.equal(typeof pending.requestState, 'string');
    assert.equal(h.posts.length, 0);
  } finally {
    await h.close();
  }
});

test('manual retry with the sealed state and an accept performs the write once', async () => {
  const h = await harness({ manual: true });
  try {
    const pending = await roundOne(h);
    assert.deepEqual(await retry(h, pending, ACCEPT), REPLIED);
    assert.equal(h.posts.length, 1);
  } finally {
    await h.close();
  }
});

test('a replayed state is refused: every state answers at most one retry', async () => {
  const h = await harness({ manual: true });
  try {
    const pending = await roundOne(h);
    await retry(h, pending, ACCEPT);
    const replay = await retry(h, pending, ACCEPT);
    assert.equal(replay.mode, 'refused');
    assert.equal(replay.reason, 'unavailable');
    assert.equal(h.posts.length, 1, 'the replay must not post a second reply');
    assert.ok(h.log.some((l) => l.level === 'warn'));
  } finally {
    await h.close();
  }
});

test('a tampered state is refused as unavailable, never as consent', async () => {
  const h = await harness({ manual: true });
  try {
    const pending = await roundOne(h);
    const last = pending.requestState.at(-1) === 'A' ? 'B' : 'A';
    const forged = { requestState: `${pending.requestState.slice(0, -1)}${last}` };
    const payload = await retry(h, forged, ACCEPT);
    assert.equal(payload.reason, 'unavailable');
    const garbage = await retry(h, { requestState: 'not-a-state' }, ACCEPT);
    assert.equal(garbage.reason, 'unavailable');
    assert.equal(h.posts.length, 0);
  } finally {
    await h.close();
  }
});

test('a state minted for one call cannot approve a different call', async () => {
  const h = await harness({ manual: true });
  try {
    const pending = await roundOne(h);
    const other = { ...ARGS, message: 'a different reply' };
    const payload = await retry(h, pending, ACCEPT, other);
    assert.equal(payload.reason, 'unavailable');
    assert.equal(h.posts.length, 0);
    // The mismatch spent nothing: the state still approves its own call.
    assert.deepEqual(await retry(h, pending, ACCEPT), REPLIED);
  } finally {
    await h.close();
  }
});

test('a retry with the state but no confirmation answer is refused', async () => {
  const h = await harness({ manual: true });
  try {
    const pending = await roundOne(h);
    const payload = await retry(h, pending, {});
    assert.equal(payload.reason, 'unavailable');
    assert.equal(h.posts.length, 0);
  } finally {
    await h.close();
  }
});

test('answers sent without any state restart the flow instead of approving', async () => {
  const h = await harness({ manual: true });
  try {
    const result = (await h.client.callTool(
      { name: TOOL, arguments: ARGS, inputResponses: ACCEPT } as never,
      { allowInputRequired: true },
    )) as unknown as Pending;
    assert.equal(result.resultType, 'input_required');
    assert.equal(h.posts.length, 0);
  } finally {
    await h.close();
  }
});

for (const [label, capabilities] of [
  ['no elicitation capability', {}],
  ['url-only elicitation', { elicitation: { url: {} } }],
] as const) {
  test(`modern client with ${label}: env flags alone decide, as on 2025-11-25`, async () => {
    const h = await harness({ capabilities });
    try {
      assert.deepEqual(
        payloadOf(await h.client.callTool({ name: TOOL, arguments: ARGS })),
        REPLIED,
      );
      assert.equal(h.posts.length, 1);
    } finally {
      await h.close();
    }
  });
}

test('preview mode never asks: no input_required for a call that changes nothing', async () => {
  const h = await harness({ manual: true });
  try {
    const result = await h.client.callTool(
      { name: TOOL, arguments: { ...ARGS, apply: false } },
      { allowInputRequired: true },
    );
    assert.equal(payloadOf(result).mode, 'preview');
    assert.equal(h.posts.length, 0);
  } finally {
    await h.close();
  }
});

test('legacy client: the 2025-11-25 push elicitation path is unchanged', async () => {
  const h = await harness({
    mode: 'legacy',
    answer: { action: 'accept', content: { confirm: true } },
  });
  try {
    const result = await h.client.callTool({ name: TOOL, arguments: ARGS });
    assert.deepEqual(payloadOf(result), REPLIED);
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.eras, ['legacy']);
    assert.equal(
      h.log.some((l) => l.msg.includes('input_required')),
      false,
      'a legacy client never sees the multi round-trip flow',
    );
    const declined = await harness({ mode: 'legacy', answer: { action: 'decline' } });
    try {
      const payload = payloadOf(await declined.client.callTool({ name: TOOL, arguments: ARGS }));
      assert.equal(payload.reason, 'declined');
    } finally {
      await declined.close();
    }
  } finally {
    await h.close();
  }
});

// --- unit: the confirmer against a hand-built context ------------------------

const PROMPT: ConfirmPrompt = {
  message: 'confirm?',
  requestedSchema: {
    type: 'object',
    properties: { confirm: { type: 'boolean', title: 't', description: 'd' } },
    required: ['confirm'],
  },
};

function fakeCtx(
  state: string | undefined,
  inputResponses?: Record<string, unknown>,
  caps?: unknown,
): ServerContext {
  return {
    mcpReq: {
      envelope:
        caps === undefined ? undefined : { 'io.modelcontextprotocol/clientCapabilities': caps },
      requestState: () => state,
      inputResponses,
    },
  } as unknown as ServerContext;
}

const BINDING = { tool: TOOL, account: 'default', args: { a: 1 } };

async function mintState(flow: ReturnType<typeof createModernConfirmFlow>): Promise<string> {
  const first = modernConfirmer(flow, fakeCtx(undefined), BINDING);
  assert.deepEqual(await first.ask(PROMPT), { action: 'defer' });
  const parked = first.pending() as unknown as { requestState: string };
  return parked.requestState;
}

test('isSupported reads the per-request capability envelope', () => {
  const flow = createModernConfirmFlow();
  const supported = (caps: unknown): boolean =>
    modernConfirmer(flow, fakeCtx(undefined, undefined, caps), BINDING).isSupported();
  assert.equal(supported(undefined), false, 'no envelope at all');
  assert.equal(supported({}), false, 'no elicitation');
  assert.equal(supported({ elicitation: { url: {} } }), false, 'url only cannot answer a form');
  assert.equal(supported({ elicitation: {} }), true, 'bare elicitation means form');
  assert.equal(supported({ elicitation: { form: {} } }), true);
  assert.equal(supported({ elicitation: { form: {}, url: {} } }), true);
});

test('pending() is empty until round 1 defers', async () => {
  const flow = createModernConfirmFlow();
  const c = modernConfirmer(flow, fakeCtx(undefined), BINDING);
  assert.equal(c.pending(), undefined);
  await c.ask(PROMPT);
  assert.notEqual(c.pending(), undefined);
});

test('an expired state is refused', async () => {
  const flow = createModernConfirmFlow({ ttlSeconds: -1 });
  const state = await mintState(flow);
  const c = modernConfirmer(flow, fakeCtx(state, ACCEPT), BINDING);
  await assert.rejects(c.ask(PROMPT), /expired/);
});

test('the digest binds the account and the prompt, not only the arguments', async () => {
  const flow = createModernConfirmFlow();
  const state = await mintState(flow);
  const otherAccount = modernConfirmer(flow, fakeCtx(state, ACCEPT), { ...BINDING, account: 'fb' });
  await assert.rejects(otherAccount.ask(PROMPT), /does not match this call/);
  const otherTool = modernConfirmer(flow, fakeCtx(state, ACCEPT), { ...BINDING, tool: 'x' });
  await assert.rejects(otherTool.ask(PROMPT), /does not match this call/);
  const sameArgsReordered = modernConfirmer(flow, fakeCtx(state, ACCEPT), BINDING);
  await assert.rejects(
    sameArgsReordered.ask({ ...PROMPT, message: 'something else' }),
    /does not match this call/,
  );
  assert.deepEqual(await sameArgsReordered.ask(PROMPT), {
    action: 'accept',
    content: { confirm: true },
  });
});

test('the digest ignores object key order in the arguments', async () => {
  const flow = createModernConfirmFlow();
  const binding = { tool: TOOL, account: 'default', args: { b: [1, { y: 2, x: 1 }], a: null } };
  const first = modernConfirmer(flow, fakeCtx(undefined), binding);
  await first.ask(PROMPT);
  const state = (first.pending() as unknown as { requestState: string }).requestState;
  const reordered = { ...binding, args: { a: null, b: [1, { x: 1, y: 2 }] } };
  const second = modernConfirmer(flow, fakeCtx(state, ACCEPT), reordered);
  assert.equal((await second.ask(PROMPT)).action, 'accept');
});

test('spent nonces are pruned once their state can no longer verify', async () => {
  let now = 1_000_000;
  const flow = createModernConfirmFlow({ ttlSeconds: 10, now: () => now });
  const a = await mintState(flow);
  await modernConfirmer(flow, fakeCtx(a, ACCEPT), BINDING).ask(PROMPT);
  assert.equal(flow.spent.size, 1);
  const [until] = [...flow.spent.values()];
  assert.equal(until, now + 11_000, 'kept for the TTL plus the one-second exp rounding');
  now = until - 1;
  const b = await mintState(flow);
  await modernConfirmer(flow, fakeCtx(b, ACCEPT), BINDING).ask(PROMPT);
  assert.equal(flow.spent.size, 2, 'not yet expired: still held');
  now = until!;
  const c = await mintState(flow);
  await modernConfirmer(flow, fakeCtx(c, ACCEPT), BINDING).ask(PROMPT);
  assert.equal(flow.spent.size, 2, 'the first nonce was pruned at its deadline');
});

test('stableJson sorts keys at every depth and renders undefined as null', () => {
  assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(stableJson(undefined), 'null');
  assert.equal(stableJson(null), 'null');
  assert.equal(stableJson('x'), '"x"');
});
