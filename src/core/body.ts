/**
 * Bounded response-body reading (Layer 0). The one place an upstream body is
 * turned into text, shared by every reader of a Meta response: the Graph seam
 * (`core/http.ts`), the token-refresh transport (`core/refresh.ts`) and the
 * `login` CLI's OAuth exchanges (`cli/login.ts`).
 *
 * Why a module of its own rather than an export of `core/http.ts`: the refresh
 * transport is forbidden to import `core/http` at all, so that the
 * auth-injecting `IgRequestFn` seam is out of its reach even by accident (see
 * that module's header). Sharing the reader through `http.ts` would have traded
 * that guarantee for a helper; this module imports nothing, so any reader can
 * take it without taking the seam with it.
 *
 * Until 2026-09-24 only `http.ts` was capped; the other two readers still called
 * `res.text()` and buffered whatever arrived (CC-PROC-203). The refusal itself
 * is the CALLER's: each one reports an oversized body the way it reports every
 * other upstream failure, so this module takes a factory rather than inventing
 * an error shape all three would have to share.
 */

/**
 * Largest response body, in bytes as they arrive from the transport (after any
 * `Content-Encoding` is undone), that this server will buffer. Until 2026-09-23
 * there was no ceiling: `readBody` called `res.text()`, so a misbehaving proxy,
 * a captive portal or an upstream bug that streamed without end made the server
 * hold the whole thing in memory — once per concurrent request — before JSON
 * parsing could even begin (CC-PROC-203).
 *
 * 16 MiB is sized against the largest page any tool can ask for, not a typical
 * one. Tool schemas cap `limit` at 150 per page, and the heaviest item shape is
 * a media object: a 2 200-character caption that Graph may emit as `\uXXXX`
 * escapes (6 bytes per UTF-16 unit, ~13 KB) plus signed CDN URLs for the item
 * and up to ten carousel children (~1 KB each) — roughly 30 KB, so a
 * worst-case 150-item page is ~4.5 MB and a real one is a small fraction of
 * that. The cap leaves more than three times that headroom while still bounding
 * the process at `maxConcurrent × 16 MiB` of raw body. A token-exchange reply
 * is a few hundred bytes, so the same ceiling is generous there; one constant
 * keeps "how much will this process buffer" a single answer. It is deliberately
 * a constant, like `RETRY_AFTER_CAP_MS` in `core/http.ts`: a response this large
 * is a fault to report, not a workload to tune for.
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Builds the caller's refusal for a body over {@link MAX_RESPONSE_BYTES}.
 * `status` is the response's HTTP status; `seen` is what gave the size away —
 * the declared `Content-Length`, or the running count once the stream passed
 * the cap — so the operator can tell "the proxy said so up front" from "it kept
 * sending". Neither carries a byte of the body, and a factory must keep it that
 * way: an OAuth reply can hold a token.
 */
export type TooLargeFn = (status: number, seen: string) => Error;

/**
 * Read the body as UTF-8 text, refusing it once it passes
 * {@link MAX_RESPONSE_BYTES} with whatever `tooLarge` builds.
 *
 * A declared `Content-Length` over the cap is refused before a single byte is
 * read — but only on an unencoded response, because under `Content-Encoding` the
 * header counts the compressed bytes while the cap counts what the transport
 * hands over. Whatever the header says, the stream is counted too: a length can
 * be absent, understated, or describe a gzip that expands tenfold. Either way the
 * stream is cancelled, so the transport stops pulling bytes nobody will read.
 *
 * Decoding matches `Response.text()`: UTF-8, a leading BOM dropped, malformed
 * sequences replaced rather than thrown. `stream: true` keeps a multi-byte
 * character split across two chunks intact.
 */
export async function readCappedText(res: Response, tooLarge: TooLargeFn): Promise<string> {
  // `Headers.get` already strips surrounding whitespace (Fetch header-value
  // normalization), so neither value needs trimming here.
  const encoding = res.headers.get('content-encoding');
  const declared = res.headers.get('content-length');
  if (
    (encoding === null || encoding.toLowerCase() === 'identity') &&
    declared !== null &&
    /^\d+$/.test(declared) &&
    Number(declared) > MAX_RESPONSE_BYTES
  ) {
    void res.body?.cancel().catch(() => {});
    throw tooLarge(res.status, `Content-Length ${declared}`);
  }
  if (res.body === null) return '';
  // The DOM typings leave the chunk type open; a fetch body is bytes.
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      // Not awaited: a transport slow to tear down must not hold the refusal.
      void reader.cancel().catch(() => {});
      throw tooLarge(res.status, `more than ${MAX_RESPONSE_BYTES} bytes received`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
