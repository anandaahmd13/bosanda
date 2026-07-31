/**
 * @bosanda/anthropic barrel — the Anthropic-compatible surface codec
 * (PLAN.md §8 "Anthropic-compatible surface", §5 canonical protocol).
 *
 * A pure codec: Anthropic wire format <-> CanonicalRequest/CanonicalEvent. No
 * HTTP, no provider, no state beyond one streaming response's own index
 * bookkeeping. This is the surface Claude Code itself speaks, so fidelity to
 * Anthropic's event order and field names matters more here than anywhere else.
 */

export {
  decodeMessagesRequest,
  decodeCountTokensRequest,
  requireAnthropicVersion,
  messagesRequestSchema,
  SUPPORTED_ANTHROPIC_VERSIONS,
  DEFAULT_ANTHROPIC_VERSION,
  type AnthropicMessagesRequest,
  type DecodeOptions,
  type HeaderLike,
} from "./decode.js";

export {
  AnthropicStreamEncoder,
  encodeStream,
  encodeStreamText,
  encodeMessage,
  anthropicStopReason,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicStopReason,
  type AnthropicUsage,
  type EncoderOptions,
} from "./encode.js";

export {
  countTokens,
  countTokensForRequest,
  counterVersion,
  type CountTokensResponse,
} from "./count_tokens.js";

export {
  toAnthropicError,
  statusForError,
  encodeErrorEvent,
  encodeErrorSse,
  anthropicErrorType,
  type AnthropicErrorBody,
  type AnthropicErrorType,
} from "./errors.js";

export { formatSse, formatSseStream, pingFrame, type SseFrame } from "./sse.js";
