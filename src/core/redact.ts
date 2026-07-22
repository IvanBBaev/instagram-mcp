/**
 * Secret redaction (Layer 0). A pure, dependency-free redactor that deep-clones
 * its input and masks secret values before anything is serialized to logs,
 * error payloads, or MCP results. See docs/security.md §2 and the security
 * review's finding F-4 (redaction must cover runtime-minted tokens and
 * `appsecret_proof` HMACs, not only statically-configured secrets).
 *
 * Three redaction mechanisms, in order of reliability:
 *   1. Exact registered secrets — every real secret value is registered the
 *      instant it exists (config load, `login`/`refresh` mint) and is then
 *      masked wherever it appears inside any string. This is the primary
 *      mechanism (F-4: "make exact-value redaction the primary mechanism").
 *   2. Secret-named keys — the value of any object key whose name matches
 *      {@link SECRET_KEY_PATTERN} is masked wholesale, regardless of content.
 *   3. Token-shape patterns — Facebook (`EAA…`) and Instagram (`IG…`) tokens and
 *      64-hex `appsecret_proof` HMACs are masked in free text even when not
 *      registered, as a best-effort backstop for the mint→register window.
 *
 * The redactor never mutates its input: it returns a fresh deep copy. Inputs are
 * expected to be JSON-like (log fields, Graph responses): objects, arrays,
 * strings, and primitives.
 */

/** The fixed marker that replaces every redacted secret. */
export const REDACTED = '[REDACTED]';

/** Marker substituted when a reference cycle is detected (defensive guard). */
const CIRCULAR = '[Circular]';

/**
 * Key-name test (case-insensitive substring): the value of any object key whose
 * name contains one of these is masked wholesale. Mirrors docs/security.md §2
 * and the secret env vars in docs/architecture.md §12.
 */
const SECRET_KEY_PATTERN = /access_token|appsecret_proof|app_secret|client_secret|authorization/i;

/**
 * Token-shape backstop patterns for free strings (docs/security.md §2; F-4):
 *  - Facebook Graph tokens start `EAA` followed by a long token body.
 *  - Instagram tokens start `IG` (e.g. `IGQ…`, `IGAA…`) followed by a long body.
 *  - `appsecret_proof` is a 64-char hex HMAC-SHA256 with no distinguishing prefix.
 * The length thresholds are set high enough that ordinary words (e.g. `IGNORE`)
 * cannot match; over-redaction is preferred to under-redaction here.
 */
const TOKEN_SHAPE_PATTERNS: readonly RegExp[] = [
  /EAA[A-Za-z0-9_-]{20,}/g,
  /IG[A-Za-z0-9_-]{20,}/g,
  /\b[a-f0-9]{64}\b/gi,
];

/**
 * Registrations shorter than this are ignored. Empty and short strings are
 * common substrings; registering one would mask unrelated output (an empty
 * string would mask everything). Every real secret in this server (access
 * tokens, the 32-hex app secret, the 64-hex proof, the HTTP bearer) is longer.
 */
const MIN_REGISTERED_SECRET_LENGTH = 8;

/**
 * Module-level registry of exact secret values. Mutable and updated atomically
 * on mint/refresh so a redactor built at startup masks tokens registered later
 * (F-4: "register every secret with the redactor the instant it exists").
 */
const registry = new Set<string>();

/**
 * Register a secret so every subsequent redaction masks it wherever it appears.
 * Call the instant a secret exists — on config load and inside the
 * `login`/`refresh` mint path, before the new token can be persisted or thrown.
 * Empty and short strings are ignored (registering `''` would mask everything).
 */
export function registerSecret(secret: string): void {
  if (typeof secret !== 'string') return;
  if (secret.length < MIN_REGISTERED_SECRET_LENGTH) return;
  registry.add(secret);
}

export interface RedactorOptions {
  /** Extra exact secrets scoped to this redactor (merged with the global registry). */
  extraSecrets?: string[];
}

/**
 * Build a redactor: a pure function that deep-clones `value` and returns a copy
 * with every secret masked, never mutating the original. The returned function
 * reads the global registry live on each call, so a redactor created at startup
 * still masks tokens registered later at runtime (F-4).
 */
export function createRedactor(opts?: RedactorOptions): (value: unknown) => unknown {
  const extra = new Set<string>();
  for (const s of opts?.extraSecrets ?? []) {
    if (typeof s === 'string' && s.length >= MIN_REGISTERED_SECRET_LENGTH) extra.add(s);
  }
  return (value: unknown): unknown => {
    // Longest-first so a secret that contains another is masked first.
    const secrets = [...new Set([...registry, ...extra])].sort((a, b) => b.length - a.length);
    return redactValue(value, secrets, new WeakSet<object>());
  };
}

/** Mask exact registered secrets, then token-shape patterns, inside one string. */
function redactString(input: string, secrets: readonly string[]): string {
  let out = input;
  for (const secret of secrets) {
    // split/join avoids treating secret characters as a regex.
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of TOKEN_SHAPE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Deep-clone `value`, masking secrets; `seen` guards against reference cycles. */
function redactValue(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, secrets, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] =
        SECRET_KEY_PATTERN.test(key) && val !== null && val !== undefined
          ? REDACTED
          : redactValue(val, secrets, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
