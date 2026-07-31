/**
 * Usage source priority (PLAN.md §10 "Usage source priority"):
 *
 *   1. Upstream metricsEvent usage, IF COMPLETE.
 *   2. Protocol tokenizer/counting implementation for the selected model.
 *   3. Explicitly versioned fallback estimator.
 *
 * Every result records which source was used, whether it is estimated, and the meter
 * version — because §10 requires every ledger row to carry that provenance, and
 * because an estimate that cannot be distinguished from an authoritative number is
 * indistinguishable from a billing error.
 */

import type { CanonicalRequest, CanonicalUsage } from "@bosanda/protocol";
import { COUNTER_VERSION, countOutputTokens, countRequestInputTokens } from "./counter.js";

/** Bump when the resolution policy itself changes, not just the counter. */
export const METER_VERSION = `meter-1/${COUNTER_VERSION}`;

export type UsageSource =
  /** Upstream reported both input and output. Authoritative. */
  | "upstream"
  /** Upstream was absent or partial; counted locally from the request/response. */
  | "counted"
  /** Neither upstream nor countable material was available. */
  | "fallback";

export type ResolvedUsage = {
  inputTokens: number;
  outputTokens: number;
  /** false ONLY when upstream supplied complete authoritative usage. */
  estimated: boolean;
  source: UsageSource;
  meterVersion: string;
  /**
   * Set when upstream supplied SOME usage but not all of it, so operators can see
   * that a partial metricsEvent was observed rather than none at all.
   */
  partialUpstream?: { inputTokens?: number; outputTokens?: number };
};

/** What the adapter observed upstream. Fields absent when upstream did not report them. */
export type UpstreamUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
};

/**
 * Ratio used only by the last-resort fallback, when a turn produced output we could
 * not observe as text (e.g. the stream died before any delta was captured but after
 * the model had clearly started). Deliberately conservative and explicitly versioned.
 */
const FALLBACK_OUTPUT_RATIO = 0.25;

function isValidTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCompleteUpstream(upstream: UpstreamUsage | null): upstream is {
  inputTokens: number;
  outputTokens: number;
} {
  return (
    upstream !== null &&
    isValidTokenCount(upstream.inputTokens) &&
    isValidTokenCount(upstream.outputTokens)
  );
}

export type ResolveUsageInput = {
  request: CanonicalRequest;
  /** null when no metricsEvent arrived at all. */
  upstream: UpstreamUsage | null;
  /** Text segments actually emitted to the client, for the counted path. */
  outputSegments: readonly string[];
  /** True when the turn ended early (error/abort) — affects the fallback only. */
  partialTurn?: boolean;
};

/**
 * Resolve billable usage for one turn.
 *
 * A PARTIAL upstream report is never treated as authoritative: §10 says "if complete".
 * Half-trusting it would mix an authoritative input count with an invented output
 * count and then label the whole row as authoritative, which is worse than a clearly
 * labelled estimate. The observed fields are preserved in `partialUpstream` for
 * operators, and `estimated` is true.
 */
export function resolveUsage(input: ResolveUsageInput): ResolvedUsage {
  const { request, upstream, outputSegments } = input;

  if (isCompleteUpstream(upstream)) {
    return {
      inputTokens: upstream.inputTokens,
      outputTokens: upstream.outputTokens,
      estimated: false,
      source: "upstream",
      meterVersion: METER_VERSION,
    };
  }

  const countedInput = countRequestInputTokens(request);
  const countedOutput = countOutputTokens(outputSegments);

  // Prefer any real upstream number over our own estimate for the SAME field: it is
  // still better information, even though its presence alone does not make the row
  // authoritative.
  const validUpstreamInput = isValidTokenCount(upstream?.inputTokens)
    ? upstream.inputTokens
    : undefined;
  const validUpstreamOutput = isValidTokenCount(upstream?.outputTokens)
    ? upstream.outputTokens
    : undefined;
  const inputTokens = validUpstreamInput ?? countedInput;

  const partialUpstream: ResolvedUsage["partialUpstream"] | undefined =
    validUpstreamInput === undefined && validUpstreamOutput === undefined
      ? undefined
      : {
          ...(validUpstreamInput !== undefined ? { inputTokens: validUpstreamInput } : {}),
          ...(validUpstreamOutput !== undefined ? { outputTokens: validUpstreamOutput } : {}),
        };

  if (validUpstreamOutput !== undefined || outputSegments.length > 0) {
    return {
      inputTokens,
      outputTokens: validUpstreamOutput ?? countedOutput,
      estimated: true,
      source: "counted",
      ...(partialUpstream !== undefined ? { partialUpstream } : {}),
      meterVersion: METER_VERSION,
    };
  }

  // Nothing observable was produced. Charge for the input we know was sent upstream
  // (the provider consumed it regardless), plus a conservative output allowance only
  // when the turn was cut short mid-generation.
  const fallbackOutput =
    input.partialTurn === true ? Math.ceil(inputTokens * FALLBACK_OUTPUT_RATIO) : 0;

  return {
    inputTokens,
    outputTokens: fallbackOutput,
    estimated: true,
    source: "fallback",
    ...(partialUpstream !== undefined ? { partialUpstream } : {}),
    meterVersion: METER_VERSION,
  };
}

/** Adapt a ResolvedUsage into the canonical usage event shape. */
export function toCanonicalUsage(usage: ResolvedUsage): CanonicalUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimated: usage.estimated,
  };
}
