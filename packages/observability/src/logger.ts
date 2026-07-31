/**
 * Structured logging with mandatory redaction (PLAN.md §17).
 *
 * The redaction is applied by pino's own serializer chain AND by our
 * `redactValue` helper, so a caller who forgets to sanitize still cannot leak a
 * credential, prompt, or tool result.
 */

import { pino, type Logger as PinoLogger } from "pino";
import { redactValue } from "@bosanda/shared";

/**
 * Paths pino nulls out before serialization. This is belt-and-braces alongside
 * redactValue: pino's redact runs on the final object, catching keys that were
 * attached after our own pass.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "*.authorization",
  "*.cookie",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.api_key",
  "*.secret",
  "*.clientSecret",
  "*.encryptedKey",
  "*.encryptedCredentials",
  "*.ciphertext",
  "*.lookupDigest",
  "*.prompt",
  "*.messages",
  "*.system",
  "*.content",
  "*.toolInput",
  "*.toolResult",
  "*.arguments",
];

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LoggerOptions = {
  level?: LogLevel;
  service: "gateway" | "worker" | "web" | "admin" | "spike" | "test";
  pretty?: boolean;
};

export type Logger = PinoLogger;

export function createLogger(options: LoggerOptions): Logger {
  const { level = "info", service, pretty = false } = options;

  return pino({
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    // Every logged object passes through redactValue first.
    formatters: {
      log: (object) => redactValue(object) as Record<string, unknown>,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { colorize: true, singleLine: false } } }
      : {}),
  });
}

/** Fields safe to attach to every request-scoped log line (§17). */
export type RequestLogContext = {
  requestId: string;
  surface?: "openai" | "anthropic";
  model?: string;
  apiKeyId?: string;
  providerAccountId?: string;
  adapterVersion?: string;
};

export function requestLogger(logger: Logger, context: RequestLogContext): Logger {
  return logger.child(context);
}
