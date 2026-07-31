/**
 * Redaction helpers (PLAN.md §17).
 *
 * Anything that reaches a log line goes through here. The rule is deny-by-
 * default: known-sensitive keys are replaced wholesale rather than truncated,
 * because a prefix of a secret is still a secret.
 */

/**
 * Key matching works on a normalized form (lowercased, separators stripped) so
 * `refresh_token`, `refreshToken`, and `Refresh-Token` are treated alike.
 *
 * Two lists, deliberately:
 *  - EXACT catches keys whose whole name is the sensitive thing ("content").
 *  - SUBSTRING catches compound credential names ("clientSecret").
 *
 * A bare "token" substring is NOT in SUBSTRING on purpose: token *counts*
 * (inputTokens, weightedTokens) are operational metrics that §17 expects in
 * logs, and redacting them would blind usage debugging.
 */
const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, "");

const EXACT_SENSITIVE = new Set([
  "token",
  "key",
  "apikey",
  "xapikey",
  "authorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "credential",
  "credentials",
  "signature",
  "digest",
  "ciphertext",
  "encrypted",
  "bearer",
  "refresh",
  "prompt",
  "prompts",
  "completion",
  "completions",
  "content",
  "contents",
  "message",
  "messages",
  "system",
  "input",
  "output",
  "arguments",
  "args",
  "text",
  "profilearn",
]);

const SUBSTRING_SENSITIVE = [
  "password",
  "passwd",
  "secret",
  "authorization",
  "cookie",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "authtoken",
  "bearertoken",
  "privatekey",
  "publickey",
  "encryptionkey",
  "lookupdigest",
  "encrypted",
  "ciphertext",
  "credential",
  "profilearn",
  "toolresult",
  "toolinput",
  "toolarg",
  "prompt",
  "completion",
] as const;

/**
 * Absolute filesystem paths must not reach logs (§17 "local paths"). Anchored on
 * known roots so upstream URL paths stay debuggable.
 */
const FS_PATH_PATTERN =
  /(?:\/(?:Users|home|root|var|opt|etc|tmp|private|usr|srv|mnt|Volumes)\/[^\s"'`)\]},;]*)|(?:~\/[^\s"'`)\]},;]*)|(?:\b[A-Za-z]:\\[^\s"'`)\]},;]*)/g;

export function scrubPaths(text: string): string {
  return text.replace(FS_PATH_PATTERN, "[path]");
}

/** Header names allowed through verbatim; everything else is dropped. */
const HEADER_ALLOWLIST = new Set([
  "content-type",
  "content-length",
  "accept",
  "accept-encoding",
  "user-agent",
  "anthropic-version",
  "anthropic-beta",
  "x-request-id",
  "x-stainless-lang",
  "x-stainless-package-version",
  "host",
]);

export const REDACTED = "[redacted]";

/**
 * Filters request headers down to the allowlist. Unknown headers are reported
 * by name only so an operator can see that something unexpected arrived
 * without the value ever being logged.
 */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!HEADER_ALLOWLIST.has(name)) {
      dropped.push(name);
      continue;
    }
    safe[name] = Array.isArray(value) ? value.join(",") : (value ?? "");
  }
  if (dropped.length > 0) safe["x-dropped-headers"] = dropped.sort().join(",");
  return safe;
}

/**
 * Masks a Bosanda API key for display. Keeps the non-secret prefix so a user can
 * tell keys apart; the entropy tail is never shown.
 */
export function maskApiKey(key: string): string {
  const separator = key.indexOf("_");
  const prefix = separator > 0 ? key.slice(0, separator + 1) : "";
  return `${prefix}${"*".repeat(8)}`;
}

const MAX_DEPTH = 6;

/**
 * Deep-redacts an arbitrary value for structured logging: sensitive keys are
 * replaced, long strings truncated, and deep/large structures summarized.
 * Never throws — logging must not be able to fail a request.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[depth-limit]";

  if (typeof value === "string") {
    // Scrub before truncating, so a path near the cut point cannot survive.
    const scrubbed = scrubPaths(value);
    return scrubbed.length > 256 ? `${scrubbed.slice(0, 64)}…[${scrubbed.length} chars]` : scrubbed;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (value instanceof Error) {
    // Stack is dropped entirely: it is a reliable source of local paths.
    return { name: value.name, message: redactValue(value.message, depth + 1) };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[binary ${value.byteLength} bytes]`;
  }
  if (Array.isArray(value)) {
    if (value.length > 20) return `[array ${value.length} items]`;
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(nested, depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}

/** True when a key name must never be logged. Exported for tests and log config. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (EXACT_SENSITIVE.has(normalized)) return true;
  return SUBSTRING_SENSITIVE.some((needle) => normalized.includes(needle));
}
