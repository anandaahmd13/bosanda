/**
 * Multiplier resolution BY VERSION (PLAN.md §9 "A multiplier change never rewrites
 * historical usage", §10 "Every ledger row records ... the meter version used").
 *
 * The rule this module exists to enforce: settling a request uses the multiplier
 * version that was in effect when the request ran — recorded on the request itself —
 * NOT whatever the current value happens to be at settlement time. Otherwise an admin
 * editing a multiplier would silently re-price in-flight requests, and any later
 * recomputation of a historical ledger row would disagree with the row.
 */

import { BosandaError } from "@bosanda/protocol";

export type MultiplierRecord = {
  /** Public Bosanda model ID. */
  model: string;
  /** Monotonically increasing per model. */
  version: number;
  multiplier: number;
  /** When this version became authoritative. */
  effectiveAt: Date;
};

/**
 * A point-in-time view of the multiplier table. Built from the models table; kept
 * side-effect free so both the gateway and the worker can resolve identically.
 */
export class MultiplierRegistry {
  /** model -> versions, sorted ascending by version. */
  private readonly byModel: Map<string, MultiplierRecord[]>;

  constructor(records: readonly MultiplierRecord[]) {
    this.byModel = new Map();
    for (const record of records) {
      if (!Number.isInteger(record.version) || record.version < 1) {
        throw new RangeError(
          `multiplier version must be a positive integer, received ${record.version} for ${record.model}`,
        );
      }
      const existing = this.byModel.get(record.model);
      if (existing === undefined) {
        this.byModel.set(record.model, [record]);
        continue;
      }
      if (existing.some((candidate) => candidate.version === record.version)) {
        throw new Error(`duplicate multiplier version ${record.version} for model ${record.model}`);
      }
      existing.push(record);
    }
    for (const versions of this.byModel.values()) {
      versions.sort((a, b) => a.version - b.version);
    }
  }

  /**
   * The version to STAMP on a new request: the highest version already effective at
   * `now`. A version with a future effectiveAt is staged and not yet authoritative
   * (§9 "Model updates are staged and require admin approval before publication").
   */
  current(model: string, now: Date): MultiplierRecord {
    const versions = this.byModel.get(model);
    if (versions === undefined || versions.length === 0) {
      throw new BosandaError("model_not_allowed", {
        internalDetail: `no multiplier configured for model ${model}`,
      });
    }

    let chosen: MultiplierRecord | undefined;
    for (const candidate of versions) {
      if (candidate.effectiveAt.getTime() <= now.getTime()) {
        chosen = candidate;
      }
    }
    if (chosen === undefined) {
      throw new BosandaError("model_not_allowed", {
        internalDetail: `model ${model} has no multiplier version effective yet`,
      });
    }
    return chosen;
  }

  /**
   * Resolve the EXACT version recorded on a past request. Never falls back to the
   * current version: a missing version means the row references something the registry
   * cannot explain, and silently substituting a different multiplier would corrupt the
   * commercial record. Fail loudly instead.
   */
  atVersion(model: string, version: number): MultiplierRecord {
    const versions = this.byModel.get(model);
    const found = versions?.find((candidate) => candidate.version === version);
    if (found === undefined) {
      throw new BosandaError("internal_error", {
        internalDetail: `unknown multiplier version ${version} for model ${model}`,
      });
    }
    return found;
  }

  /** All versions for a model, ascending. Empty when the model is unknown. */
  history(model: string): readonly MultiplierRecord[] {
    return this.byModel.get(model) ?? [];
  }

  models(): readonly string[] {
    return [...this.byModel.keys()];
  }
}
