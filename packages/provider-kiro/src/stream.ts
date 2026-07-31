/**
 * Kiro EventStream events -> CanonicalEvent, and error classification
 * (PLAN.md §6 items 9/11, §3 G2/G4, §7, §8).
 *
 * Two jobs live here, and they are coupled by one requirement: the scheduler's
 * behaviour in §7 is driven ENTIRELY by the ErrorCode this module chooses. Get
 * the classification wrong and cooldown/failover misbehave, so the mapping is
 * explicit rather than a catch-all:
 *
 *   upstream_incompatible -> a shape we cannot parse. Retryable AND cooldown:
 *                            per §3 this is the signal that the undocumented
 *                            protocol may have changed, and it feeds the
 *                            compatibility-error circuit breaker.
 *   upstream_timeout      -> idle/hard timeout. Retryable AND cooldown.
 *   rate_limit            -> upstream throttling. Cooldown but NOT retryable:
 *                            §7 honours upstream retry metadata, and hammering
 *                            the next account with the same request is how a
 *                            throttle becomes a ban.
 *   authentication_error  -> revoked/expired credential. Neither retryable nor
 *                            cooldown: §7 disables the account until admin
 *                            action, which is a stronger action than cooldown.
 *   model_not_allowed     -> upstream rejected the model identifier.
 *
 * Unknown event types are counted by TYPE ONLY and ignored (§6). That is
 * deliberate: an upstream that adds a new informational event must not break
 * live traffic. The turn still completes because completion is driven by
 * `messageStopEvent` and by the body ending.
 *
 * No payload text is ever placed in an error message or a log field here — only
 * event type names, error classes, and token counts (§17).
 */

import {
  BosandaError,
  type CanonicalEvent,
  type ErrorCode,
  type FinishReason,
} from "@bosanda/protocol";
import { TimeoutError } from "@bosanda/shared";
import {
  EventStreamError,
  type EventStreamMessage,
  payloadJson,
  type EventStreamFaultKind,
} from "./eventstream.js";

/** Upstream usage observed on a `metricsEvent` (§3 G4, §10). */
export type KiroUpstreamUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
};

/**
 * Accumulated non-event outcomes of one upstream turn. The adapter hands this to
 * `resolveUsage` from `@bosanda/metering`; §10 forbids treating a partial
 * upstream report as authoritative, which that function enforces.
 */
export type StreamTelemetry = {
  usage: KiroUpstreamUsage | null;
  /** Unknown upstream event types, by name and count (§6). */
  unknownEvents: Map<string, number>;
  /** True once a `messageStopEvent` (or equivalent) was observed. */
  sawStop: boolean;
};

export function newTelemetry(): StreamTelemetry {
  return { usage: null, unknownEvents: new Map(), sawStop: false };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;

/**
 * Maps an upstream `stopReason` onto a canonical finish reason.
 *
 * An unrecognised value becomes `end_turn` rather than an error: the turn DID
 * complete, and failing a finished turn over an unfamiliar label would discard
 * output the customer has already been billed for.
 */
export function toFinishReason(raw: unknown): FinishReason {
  switch (asString(raw)?.toLowerCase()) {
    case "tool_use":
    case "tooluse":
      return "tool_use";
    case "max_tokens":
    case "maxtokens":
    case "length":
      return "max_tokens";
    case "refusal":
    case "content_filtered":
    case "contentfiltered":
      return "refusal";
    default:
      return "end_turn";
  }
}

/**
 * Tracks tool-call block indices across a turn.
 *
 * Kiro streams a tool call as a `toolUseEvent` carrying a `toolUseId` plus
 * incremental `input` fragments, and §3 G3 requires stable IDs, incremental JSON,
 * and MULTIPLE concurrent tool calls. Canonical events are index-addressed, so
 * this maps each upstream tool ID to a stable index for the life of the turn.
 * The upstream ID is passed through untouched (§6 "Preserve tool IDs") — the
 * client correlates its `tool_result` against exactly that value.
 */
export class ToolBlockTracker {
  private readonly indexById = new Map<string, number>();
  private readonly open = new Set<number>();
  private next = 0;

  /** Returns the index and whether this call is newly started. */
  resolve(toolUseId: string): { index: number; started: boolean } {
    const existing = this.indexById.get(toolUseId);
    if (existing !== undefined) return { index: existing, started: false };
    const index = this.next;
    this.next += 1;
    this.indexById.set(toolUseId, index);
    this.open.add(index);
    return { index, started: true };
  }

  close(index: number): boolean {
    return this.open.delete(index);
  }

  /** Indices still open, so the adapter can emit the missing tool_stop events. */
  openIndices(): number[] {
    return [...this.open].sort((a, b) => a - b);
  }

  get count(): number {
    return this.next;
  }
}

/**
 * Converts one decoded EventStream message into zero or more canonical events.
 *
 * Returns an empty array for events that carry telemetry only (`metricsEvent`)
 * or that we deliberately ignore. Throws BosandaError for an upstream
 * exception frame or a payload we cannot parse.
 */
export function toCanonicalEvents(
  message: EventStreamMessage,
  tracker: ToolBlockTracker,
  telemetry: StreamTelemetry,
): CanonicalEvent[] {
  // Exception and error frames are classified before anything else: an
  // exception frame may also carry an `:event-type`, and treating it as an
  // event would surface an error string as model output.
  if (message.messageType === "exception" || message.messageType === "error") {
    throw classifyExceptionFrame(message);
  }

  const eventType = message.eventType;
  if (eventType === null) {
    throw new BosandaError("upstream_incompatible", {
      internalDetail: `eventstream frame has no :event-type header (message-type=${message.messageType ?? "absent"})`,
    });
  }

  // An empty payload is legal for a pure signal like messageStopEvent.
  const body = payloadJson(message);
  if (body !== null && !isRecord(body)) {
    throw new BosandaError("upstream_incompatible", {
      internalDetail: `event "${eventType}" payload is not a JSON object`,
    });
  }
  const payload: Record<string, unknown> = body ?? {};

  switch (eventType) {
    case "assistantResponseEvent":
    case "codeEvent": {
      const text = asString(payload["content"]);
      if (text === null) {
        throw new BosandaError("upstream_incompatible", {
          // Reports the FIELD, never its contents.
          internalDetail: `event "${eventType}" is missing a string "content" field`,
        });
      }
      return text.length === 0 ? [] : [{ type: "text_delta", text }];
    }

    case "reasoningContentEvent": {
      // Field name varies between observed shapes; accept either rather than
      // failing a turn over a synonym.
      const text = asString(payload["content"]) ?? asString(payload["text"]);
      if (text === null) {
        throw new BosandaError("upstream_incompatible", {
          internalDetail: 'event "reasoningContentEvent" is missing a string content field',
        });
      }
      return text.length === 0 ? [] : [{ type: "reasoning_delta", text }];
    }

    case "toolUseEvent":
      return toolUseEvents(payload, tracker);

    case "messageStopEvent": {
      telemetry.sawStop = true;
      return [{ type: "finish", reason: toFinishReason(payload["stopReason"]) }];
    }

    case "metricsEvent": {
      telemetry.usage = extractUsage(payload) ?? telemetry.usage;
      return [];
    }

    default: {
      // §6: recorded by type/count only, then ignored.
      telemetry.unknownEvents.set(eventType, (telemetry.unknownEvents.get(eventType) ?? 0) + 1);
      return [];
    }
  }
}

function toolUseEvents(
  payload: Record<string, unknown>,
  tracker: ToolBlockTracker,
): CanonicalEvent[] {
  const toolUseId = asString(payload["toolUseId"]);
  const name = asString(payload["name"]);
  if (toolUseId === null) {
    throw new BosandaError("upstream_incompatible", {
      internalDetail: 'event "toolUseEvent" is missing a string "toolUseId"',
    });
  }

  const { index, started } = tracker.resolve(toolUseId);
  const events: CanonicalEvent[] = [];

  if (started) {
    if (name === null) {
      throw new BosandaError("upstream_incompatible", {
        internalDetail: 'the first "toolUseEvent" for a tool call is missing a string "name"',
      });
    }
    events.push({ type: "tool_start", index, id: toolUseId, name });
  }

  // `input` arrives as a JSON FRAGMENT, not valid JSON on its own — that is what
  // §3 G3 "incremental JSON argument streaming" means. It is forwarded verbatim
  // and never parsed here; the client assembles and parses it.
  const fragment = payload["input"];
  if (typeof fragment === "string" && fragment.length > 0) {
    events.push({ type: "tool_input_delta", index, partialJson: fragment });
  } else if (fragment !== undefined && typeof fragment !== "string") {
    // A non-streamed complete object also occurs; serialize it as one fragment.
    try {
      events.push({ type: "tool_input_delta", index, partialJson: JSON.stringify(fragment) ?? "" });
    } catch {
      throw new BosandaError("upstream_incompatible", {
        internalDetail: 'event "toolUseEvent" input is not JSON-serializable',
      });
    }
  }

  if (payload["stop"] === true) {
    tracker.close(index);
    events.push({ type: "tool_stop", index });
  }

  return events;
}

/**
 * Reads usage from a `metricsEvent` (§3 G4).
 *
 * Field names are unverified until M0 runs, so several observed spellings are
 * accepted. Returns null when the event carried no recognisable counts, which
 * `resolveUsage` then treats as "no upstream usage" rather than as zeros — zeros
 * would silently bill the customer nothing.
 */
export function extractUsage(payload: Record<string, unknown>): KiroUpstreamUsage | null {
  const source = isRecord(payload["usage"]) ? payload["usage"] : payload;

  const inputTokens =
    asCount(source["inputTokens"]) ??
    asCount(source["input_tokens"]) ??
    asCount(source["promptTokens"]);
  const outputTokens =
    asCount(source["outputTokens"]) ??
    asCount(source["output_tokens"]) ??
    asCount(source["completionTokens"]);
  const cachedTokens =
    asCount(source["cacheReadInputTokens"]) ??
    asCount(source["cachedTokens"]) ??
    asCount(source["cached_tokens"]);

  if (inputTokens === undefined && outputTokens === undefined && cachedTokens === undefined) {
    return null;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
  };
}

/**
 * Upstream exception-type names -> ErrorCode.
 *
 * Matching is on the exception TYPE (a header, and a stable identifier), never on
 * a human-readable message string: message text is not part of any contract and
 * would also risk copying upstream prose into our logs.
 */
const EXCEPTION_CODES: readonly { pattern: RegExp; code: ErrorCode }[] = [
  { pattern: /throttl|toomanyrequests|ratelimit|quotaexceeded|limitexceeded/i, code: "rate_limit" },
  {
    pattern:
      /expiredtoken|accessdenied|unauthorized|unauthenticated|notauthorized|invalidgrant|credential/i,
    code: "authentication_error",
  },
  { pattern: /timeout|timedout/i, code: "upstream_timeout" },
  {
    pattern: /modelnotsupported|invalidmodel|modelunavailable|modelnotfound/i,
    code: "model_not_allowed",
  },
  { pattern: /validation|invalidrequest|malformed|serialization/i, code: "upstream_incompatible" },
  { pattern: /internalserver|serviceunavailable|internalfailure/i, code: "upstream_incompatible" },
];

/**
 * Classifies an upstream exception frame.
 *
 * The upstream MESSAGE BODY never enters the error: only the exception type name
 * and any numeric retry hint. §12/§16 forbid an upstream body crossing the client
 * boundary, and `internalDetail` is logged, so it must be clean too.
 */
export function classifyExceptionFrame(message: EventStreamMessage): BosandaError {
  const typeName =
    message.exceptionType ?? message.eventType ?? message.messageType ?? "unknown_exception";

  const matched = EXCEPTION_CODES.find((entry) => entry.pattern.test(typeName));
  const code: ErrorCode = matched?.code ?? "upstream_incompatible";

  const body = payloadJson(message);
  const retryAfterSeconds = isRecord(body)
    ? (asCount(body["retryAfterSeconds"]) ?? asCount(body["retryAfter"]))
    : undefined;

  return new BosandaError(code, {
    internalDetail: `upstream exception frame: ${typeName}`,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}

/** EventStream fault -> ErrorCode. Every parse fault is a compatibility signal. */
const FAULT_CODES: Record<EventStreamFaultKind, ErrorCode> = {
  prelude_crc: "upstream_incompatible",
  message_crc: "upstream_incompatible",
  frame_too_large: "upstream_incompatible",
  buffer_overflow: "upstream_incompatible",
  truncated: "upstream_incompatible",
  malformed_prelude: "upstream_incompatible",
  malformed_header: "upstream_incompatible",
  poisoned: "upstream_incompatible",
};

/**
 * Classifies ANY error raised while streaming from upstream.
 *
 * The default is `upstream_incompatible` rather than `internal_error` on purpose:
 * a fault we did not anticipate, while parsing an undocumented protocol, is far
 * more likely to be an upstream change than a Bosanda bug, and §3 wants those
 * counted so the compatibility circuit opens.
 */
export function classifyStreamError(error: unknown, accountId?: string): BosandaError {
  if (error instanceof BosandaError) return error;

  const attribution = accountId !== undefined ? { providerAccountId: accountId } : {};

  if (error instanceof EventStreamError) {
    return new BosandaError(FAULT_CODES[error.kind], {
      internalDetail: `eventstream ${error.kind}`,
      cause: error,
      ...attribution,
    });
  }

  if (error instanceof TimeoutError) {
    return new BosandaError("upstream_timeout", {
      internalDetail: `${error.kind} timeout while streaming from upstream`,
      cause: error,
      ...attribution,
    });
  }

  // A client disconnect is not a provider failure and must not cool an account
  // down: the account did nothing wrong.
  if (isAbortError(error)) {
    return new BosandaError("invalid_request", {
      internalDetail: "request aborted by the client",
      cause: error,
      ...attribution,
    });
  }

  return new BosandaError("upstream_incompatible", {
    internalDetail: "unclassified upstream streaming failure",
    cause: error,
    ...attribution,
  });
}

export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: unknown }).name === "AbortError";
}

/**
 * HTTP status -> ErrorCode, for a non-200 response that never becomes an
 * EventStream at all. `retryAfterSeconds` comes from the header when present;
 * the response BODY is never read into an error (§12/§16).
 */
export function classifyHttpStatus(status: number, retryAfterSeconds?: number): BosandaError {
  const code: ErrorCode =
    status === 401 || status === 403
      ? "authentication_error"
      : status === 404
        ? "model_not_allowed"
        : status === 429
          ? "rate_limit"
          : status === 408 || status === 504
            ? "upstream_timeout"
            : "upstream_incompatible";

  return new BosandaError(code, {
    internalDetail: `upstream returned HTTP ${status}`,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}
