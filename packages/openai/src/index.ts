/**
 * @bosanda/openai barrel — the OpenAI-compatible surface codec (PLAN.md §8).
 *
 * A pure codec: OpenAI wire format <-> the canonical protocol (§5). It performs no
 * HTTP, touches no provider, and holds no state beyond one streaming response's own
 * accumulation.
 */

export { decodeChatCompletion, type DecodeOptions } from "./decode.js";

export {
  OpenAIStreamEncoder,
  encodeStream,
  encodeCompletion,
  openAIFinishReason,
  DONE_FRAME,
  type EncodeOptions,
  type OpenAIChunk,
  type OpenAIChunkChoice,
  type OpenAICompletion,
  type OpenAICompletionChoice,
  type OpenAIDelta,
  type OpenAIFinishReason,
  type OpenAIMessage,
  type OpenAIToolCall,
  type OpenAIToolCallDelta,
  type OpenAIUsage,
} from "./encode.js";

export {
  encodeError,
  encodeErrorEvent,
  encodeErrorStatus,
  openAIErrorType,
  type OpenAIErrorEnvelope,
  type OpenAIErrorType,
} from "./errors.js";

export {
  encodeModel,
  encodeModelList,
  encodeModelRetrieve,
  OWNED_BY,
  type EncodeModelOptions,
  type OpenAIModel,
  type OpenAIModelInput,
  type OpenAIModelList,
} from "./models.js";
