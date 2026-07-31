/**
 * spikes/kiro-direct barrel (PLAN.md §20 M0).
 *
 * The frame builder is exported because the `@bosanda/provider-kiro` test suite
 * reuses it: one builder, shared between the spike and the unit tests, means a
 * framing assumption cannot drift between them.
 */

export {
  buildFrame,
  buildJsonFrame,
  buildEventFrame,
  buildExceptionFrame,
  encodeHeaders,
  corruptPreludeCrc,
  corruptMessageCrc,
  corruptPayloadByte,
  withDeclaredLength,
  withDeclaredHeadersLength,
  chunk,
  bytewise,
  splitAt,
  asStream,
  type FrameHeaders,
  type FrameHeaderValue,
} from "./frames.js";

export { runHarness, type CheckResult, type GateId } from "./harness.js";
