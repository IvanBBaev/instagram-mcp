/**
 * Recording `globalThis.fetch` stub. Tests assert both the outgoing request
 * (URL, pinned version, appsecret_proof presence, method) and drive responses.
 * FROZEN test seam (Gate G1).
 */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface StubResponse {
  status?: number;
  /** JSON-serialized unless a string is given. */
  body?: unknown;
  headers?: Record<string, string>;
}

export type Responder = (req: RecordedRequest) => StubResponse | Promise<StubResponse>;

export interface FetchStub {
  readonly requests: RecordedRequest[];
  restore(): void;
}

function normalizeHeaders(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k] = v));
  } else if (Array.isArray(h)) {
    for (const pair of h) {
      const k = pair[0];
      if (k !== undefined) out[k] = pair[1] ?? '';
    }
  } else {
    Object.assign(out, h);
  }
  return out;
}

/** Install the stub; call `restore()` (ideally in a `finally`) to undo it. */
export function withFetch(responder: Responder): FetchStub {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];

  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    // The Graph client only ever sends string bodies (form-encoded); other
    // BodyInit shapes are not exercised and are recorded as undefined.
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const rec: RecordedRequest = { url, method, headers: normalizeHeaders(init), body };
    requests.push(rec);

    const res = await responder(rec);
    const payload = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {});
    return new Response(payload, {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json', ...(res.headers ?? {}) },
    });
  };

  globalThis.fetch = stub;
  return {
    requests,
    restore() {
      globalThis.fetch = original;
    },
  };
}
