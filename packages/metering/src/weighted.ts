/**
 * Weighted-token arithmetic (PLAN.md §10 "Commercial unit").
 *
 *   raw_tokens      = input_tokens + output_tokens
 *   weighted_tokens = raw_tokens × kiro_model_multiplier
 *
 * ROUNDING RULE: ceil, applied once, to an integer weighted token.
 *
 * Why ceil rather than round or floor: the ledger is the commercial record, and a
 * rule that can round *down* lets a caller extract free capacity by splitting one
 * large turn into many small ones (1 raw token at 1.3× floors to 1, so 1000 such
 * turns cost 1000 instead of 1300). Ceil is the only rule where splitting can never
 * be cheaper than not splitting. It over-charges by at most 1 weighted token per
 * settlement, which is immaterial against a 10M-token package.
 *
 * The rounding happens exactly once, at the boundary where a real number becomes a
 * ledger integer. Nothing downstream re-rounds, so repeated settlements cannot drift.
 */

/** Multipliers are stored as PostgreSQL NUMERIC(10, 4). */
const MULTIPLIER_SCALE = 4;
const MULTIPLIER_FACTOR = 10 ** MULTIPLIER_SCALE;
const MAX_SCALED_MULTIPLIER = 10 ** 10 - 1;

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, received ${value}`);
  }
}

/** Validate and convert exactly what the database can persist in NUMERIC(10, 4). */
function toScaledMultiplier(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new RangeError(`multiplier must be a finite positive number, received ${multiplier}`);
  }

  const scaled = Math.round(multiplier * MULTIPLIER_FACTOR);
  const normalized = scaled / MULTIPLIER_FACTOR;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(multiplier)) * 4;
  if (
    !Number.isSafeInteger(scaled) ||
    scaled < 1 ||
    scaled > MAX_SCALED_MULTIPLIER ||
    Math.abs(multiplier - normalized) > tolerance
  ) {
    throw new RangeError(
      `multiplier must fit NUMERIC(10, ${MULTIPLIER_SCALE}) and be at least 0.0001, received ${multiplier}`,
    );
  }
  return scaled;
}

/** raw_tokens = input + output (PLAN.md §10). Cached tokens are not billed separately in v1. */
export function rawTokens(inputTokens: number, outputTokens: number): number {
  assertNonNegativeInteger(inputTokens, "inputTokens");
  assertNonNegativeInteger(outputTokens, "outputTokens");
  return inputTokens + outputTokens;
}

/**
 * weighted_tokens = ceil(raw × multiplier).
 *
 * The multiplication is done in scaled integer space to avoid binary floating-point
 * surprises: 3 × 1.1 is 3.3000000000000003 in IEEE 754, and a naive ceil would bill
 * 4 instead of 4 — harmless here, but the same artefact at other magnitudes produces
 * off-by-one differences between two mathematically identical computations. Scaling
 * first makes the result a function of the decimal multiplier the admin actually
 * entered.
 */
export function weightedTokens(raw: number, multiplier: number): number {
  assertNonNegativeInteger(raw, "raw");
  const scaledMultiplier = toScaledMultiplier(multiplier);

  const scale = BigInt(MULTIPLIER_FACTOR);
  const numerator = BigInt(raw) * BigInt(scaledMultiplier);
  const weighted = (numerator + scale - 1n) / scale;
  if (weighted > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("weighted token result exceeds the safe integer range");
  }
  return Number(weighted);
}

/** Convenience: input + output, then weighted, in one step. */
export function weightedFromTokens(
  inputTokens: number,
  outputTokens: number,
  multiplier: number,
): number {
  return weightedTokens(rawTokens(inputTokens, outputTokens), multiplier);
}
