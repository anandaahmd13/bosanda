/**
 * Package catalog (PLAN.md §11, §22).
 *
 * Sizes are every 10M increment from 10M to 100M weighted tokens, priced
 * linearly at Rp9.500 per 10M. Prices here are the *display* catalog only —
 * PLAN.md §11 keeps package records admin-managed so prices can change without
 * a deployment, and every paid order retains its own immutable price snapshot.
 * So: never compute an order total from this file. The server does that.
 */

/** Rp per 10M weighted tokens (§22 "Price"). */
export const PRICE_PER_10M_IDR = 9_500;

/** One 10M step, in weighted tokens. */
export const STEP_TOKENS = 10_000_000;

/** Hard ceiling for a single key (§11 "Validity", §22 "Key cap"). */
export const MAX_TOKENS_PER_KEY = 100_000_000;

/** Key lifetime from confirmed payment: exactly 24 hours (§11). */
export const VALIDITY_HOURS = 24;

export type PackageSize = {
  /** Stable identifier used in URLs and order requests, e.g. "p10m". */
  id: string;
  /** Weighted-token quota granted on activation. */
  tokens: number;
  /** Catalog price in integer rupiah. */
  priceIdr: number;
  /** Multiple of 10M, 1..10 — handy for labels. */
  steps: number;
};

/** The ten sizes, smallest first. Built rather than hand-typed so the linear
 * pricing rule cannot drift from the table in §11. */
export const PACKAGE_SIZES: readonly PackageSize[] = Array.from({ length: 10 }, (_, index) => {
  const steps = index + 1;
  return {
    id: `p${steps * 10}m`,
    tokens: steps * STEP_TOKENS,
    priceIdr: steps * PRICE_PER_10M_IDR,
    steps,
  };
});

/** Look up a size by id, or undefined when the id is not in the catalog. */
export function findPackage(id: string): PackageSize | undefined {
  return PACKAGE_SIZES.find((size) => size.id === id);
}
