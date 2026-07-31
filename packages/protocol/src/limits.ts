/**
 * Request and parser safety limits (PLAN.md §16 "Request and parser safety").
 *
 * These are enforced at decode time, before any provider work begins, so a
 * hostile request cannot allocate unbounded memory on the gateway.
 */

import { BosandaError } from "./errors.js";
import type { CanonicalContent, CanonicalRequest } from "./canonical.js";

export const LIMITS = {
  /** Raw JSON body bytes accepted by the gateway. */
  maxBodyBytes: 8 * 1024 * 1024,
  maxMessages: 400,
  /** Total characters across every message's text/tool content. */
  maxHistoryChars: 3_000_000,
  maxSystemChars: 200_000,
  maxTools: 128,
  maxToolNameChars: 128,
  maxToolDescriptionChars: 16_000,
  /** Serialized JSON Schema size for one tool. */
  maxToolSchemaChars: 128_000,
  maxStopSequences: 8,
  maxStopSequenceChars: 512,
  /** Upper bound on max_tokens a client may request. */
  maxOutputTokens: 128_000,
} as const;

const invalid = (detail: string): never => {
  throw new BosandaError("invalid_request", { internalDetail: detail });
};

function contentChars(content: CanonicalContent): number {
  switch (content.type) {
    case "text":
    case "reasoning":
      return content.text.length;
    case "tool_result":
      return content.content.length;
    case "tool_use":
      try {
        return JSON.stringify(content.input)?.length ?? 0;
      } catch {
        return invalid("tool_use input is not JSON-serializable");
      }
  }
}

/**
 * Validates a decoded request against LIMITS. Throws BosandaError
 * ("invalid_request") on the first violation; the message is operator-facing
 * only, since BosandaError sends a generic public message.
 */
export function assertWithinLimits(request: CanonicalRequest): void {
  if (request.messages.length === 0) invalid("messages must not be empty");
  if (request.messages.length > LIMITS.maxMessages) {
    invalid(`too many messages: ${request.messages.length} > ${LIMITS.maxMessages}`);
  }

  if (request.system !== null && request.system.length > LIMITS.maxSystemChars) {
    invalid(`system prompt too large: ${request.system.length}`);
  }

  let total = 0;
  for (const message of request.messages) {
    for (const content of message.content) {
      total += contentChars(content);
    }
  }
  if (total > LIMITS.maxHistoryChars) invalid(`history too large: ${total}`);

  if (request.tools.length > LIMITS.maxTools) {
    invalid(`too many tools: ${request.tools.length} > ${LIMITS.maxTools}`);
  }
  for (const tool of request.tools) {
    if (tool.name.length === 0 || tool.name.length > LIMITS.maxToolNameChars) {
      invalid(`invalid tool name length: ${tool.name.length}`);
    }
    if (tool.description && tool.description.length > LIMITS.maxToolDescriptionChars) {
      invalid(`tool "${tool.name}" description too large`);
    }
    let schemaChars: number;
    try {
      schemaChars = JSON.stringify(tool.inputSchema)?.length ?? 0;
    } catch {
      return invalid(`tool "${tool.name}" schema is not JSON-serializable`);
    }
    if (schemaChars > LIMITS.maxToolSchemaChars) {
      invalid(`tool "${tool.name}" schema too large: ${schemaChars}`);
    }
  }

  if (request.stopSequences.length > LIMITS.maxStopSequences) {
    invalid(`too many stop sequences: ${request.stopSequences.length}`);
  }
  for (const stop of request.stopSequences) {
    if (stop.length > LIMITS.maxStopSequenceChars) invalid("stop sequence too long");
  }

  if (request.maxTokens !== null) {
    if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1) {
      invalid("max_tokens must be a positive integer");
    }
    if (request.maxTokens > LIMITS.maxOutputTokens) {
      invalid(`max_tokens above limit: ${request.maxTokens}`);
    }
  }

  if (request.temperature !== null && (request.temperature < 0 || request.temperature > 2)) {
    invalid("temperature out of range");
  }
  if (request.topP !== null && (request.topP <= 0 || request.topP > 1)) {
    invalid("top_p out of range");
  }

  if (request.toolChoice !== null && request.toolChoice.type === "tool") {
    const wanted = request.toolChoice.name;
    if (!request.tools.some((tool) => tool.name === wanted)) {
      invalid("tool_choice names an undeclared tool");
    }
  }
}
