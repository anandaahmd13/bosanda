/**
 * Typed environment configuration (PLAN.md §4, §16).
 *
 * Rules encoded here:
 *  - Secrets are distinct values, never derived from one another (§16).
 *  - Parsing fails fast at boot with every problem listed at once, so a
 *    misconfigured VPS never starts half-working.
 *  - Secret VALUES never appear in an error message; only the variable name.
 */

import { z } from "zod";

/**
 * True only for CANONICAL base64 that decodes to exactly 32 bytes.
 *
 * The round-trip is the point. `Buffer.from(value, "base64")` never throws and
 * silently DISCARDS characters outside the base64 alphabet, so
 * `"AAAA...=" + "!!!"` and a stray newline both decode to the same 32 bytes as
 * the clean string. Two different env values could therefore produce identical
 * key material while `assertSecretsAreDistinct` — which compares the strings —
 * saw them as different, quietly defeating §16's "all secrets separate".
 *
 * Re-encoding and comparing rejects anything non-canonical: junk characters,
 * embedded whitespace, and missing padding. `openssl rand -base64 32` produces a
 * canonical value, so a correctly generated secret always passes.
 */
const isCanonicalBase64With32Bytes = (value: string): boolean => {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    return false;
  }
  return decoded.length === 32 && decoded.toString("base64") === value;
};

/** 32 bytes, base64 — the size every symmetric secret below must decode to. */
const secret32 = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(1, `${name} must not be empty`)
    .refine(isCanonicalBase64With32Bytes, {
      message:
        `${name} must be exactly 32 bytes of canonical base64 with no stray ` +
        `characters or whitespace (generate: openssl rand -base64 32)`,
    });

const port = (fallback: number) => z.coerce.number().int().min(1).max(65_535).default(fallback);

const booleanish = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback ? "true" : "false")
    .transform((value) => value === "true" || value === "1");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  // --- Database -----------------------------------------------------------
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
      message: "DATABASE_URL must be a postgres:// connection string",
    }),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(200).default(10),

  // --- Service ports ------------------------------------------------------
  GATEWAY_PORT: port(4000),
  GATEWAY_HOST: z.string().default("127.0.0.1"),

  // --- Secrets (§16: all separate) ---------------------------------------
  /** Encrypts provider credentials at rest. */
  PROVIDER_ENCRYPTION_KEY: secret32("PROVIDER_ENCRYPTION_KEY"),
  /** Encrypts customer API keys so the dashboard eye-toggle can decrypt them. */
  API_KEY_ENCRYPTION_KEY: secret32("API_KEY_ENCRYPTION_KEY"),
  /** HMAC key for the API-key lookup digest used at request auth time. */
  API_KEY_LOOKUP_SECRET: secret32("API_KEY_LOOKUP_SECRET"),
  /** Signs website session cookies. */
  SESSION_SECRET: secret32("SESSION_SECRET"),
  /** Verifies Pakasir webhook authenticity. */
  PAKASIR_WEBHOOK_SECRET: z.string().min(16, "PAKASIR_WEBHOOK_SECRET must be at least 16 chars"),

  /** Monotonic version for envelope-encryption key rotation. */
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  // --- Payments -----------------------------------------------------------
  PAKASIR_BASE_URL: z.string().url().default("https://pakasir.com"),
  PAKASIR_PROJECT: z.string().min(1).default("bosanda"),
  PAKASIR_API_KEY: z.string().min(1).optional(),

  // --- Kiro adapter kill switches (§3) -----------------------------------
  KIRO_DIRECT_ENABLED: booleanish(false),
  KIRO_TOOL_USE_ENABLED: booleanish(true),
  KIRO_DEFAULT_REGION: z.string().default("us-east-1"),
  KIRO_PERSONA: z.enum(["cli", "ide"]).default("cli"),
  /** Comma-separated regions to disable, e.g. "eu-west-1,ap-southeast-1". */
  KIRO_DISABLED_REGIONS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    ),
  KIRO_DISABLED_MODELS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    ),

  // --- Limits and timeouts (§7, §16) -------------------------------------
  KEY_MAX_ACTIVE_REQUESTS: z.coerce.number().int().min(1).default(5),
  KEY_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).default(100),
  PROVIDER_COOLDOWN_MS: z.coerce.number().int().min(1000).default(30_000),
  PROVIDER_COOLDOWN_MAX_MS: z.coerce.number().int().min(1000).default(900_000),
  UPSTREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  UPSTREAM_HARD_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600_000),

  // --- Public URLs --------------------------------------------------------
  PUBLIC_WEB_URL: z.string().url().default("https://bosanda.dev"),
  PUBLIC_ADMIN_URL: z.string().url().default("https://admin.bosanda.dev"),
  PUBLIC_API_URL: z.string().url().default("https://api.bosanda.dev"),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * Parses and validates configuration. Throws ConfigError listing every problem.
 * Only variable NAMES appear in messages — never values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) {
    assertSecretsAreDistinct(result.data);
    return result.data;
  }

  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join(".") || "(root)";
    return `${name}: ${issue.message}`;
  });
  throw new ConfigError(problems);
}

/**
 * §16 requires application encryption, HMAC, session, and payment secrets to be
 * separate. Reusing one value would mean a single leak compromises every
 * subsystem, so this is enforced rather than documented.
 */
function assertSecretsAreDistinct(env: Env): void {
  const named: Array<[string, string]> = [
    ["PROVIDER_ENCRYPTION_KEY", env.PROVIDER_ENCRYPTION_KEY],
    ["API_KEY_ENCRYPTION_KEY", env.API_KEY_ENCRYPTION_KEY],
    ["API_KEY_LOOKUP_SECRET", env.API_KEY_LOOKUP_SECRET],
    ["SESSION_SECRET", env.SESSION_SECRET],
    ["PAKASIR_WEBHOOK_SECRET", env.PAKASIR_WEBHOOK_SECRET],
  ];

  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const [name, value] of named) {
    // Compared on DECODED bytes, not the raw string: what a leak of one
    // subsystem exposes is the key material, and two distinct-looking base64
    // strings can decode to the same bytes. `secret32` already rejects
    // non-canonical encodings, so this is belt-and-braces on the property that
    // actually matters — but it is the property §16 is about, and it should not
    // depend on a validator elsewhere in the file staying strict.
    //
    // PAKASIR_WEBHOOK_SECRET is not base64, so it is keyed on its own bytes.
    const decoded = Buffer.from(value, "base64");
    const fingerprint = decoded.length === 32 ? `b64:${decoded.toString("hex")}` : `raw:${value}`;
    const previous = seen.get(fingerprint);
    if (previous) {
      problems.push(`${name} must not reuse the same value as ${previous}`);
    } else {
      seen.set(fingerprint, name);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
}

let cached: Env | undefined;

/** Process-wide config, parsed once. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test-only override hook. */
export function setEnvForTesting(value: Env | undefined): void {
  cached = value;
}
