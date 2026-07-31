/**
 * `feature_flags` (PLAN.md §3 kill switches, §15 admin controls).
 *
 * ── WHAT THIS TABLE IS FOR, AND WHAT IT IS NOT ─────────────────────────────
 * §3 requires five kill switches: global, per-region, per-model,
 * per-provider-account, and an emergency tool-use disable. They do NOT all live
 * here, and the split is deliberate:
 *
 *   * `KIRO_DIRECT_ENABLED`, `KIRO_TOOL_USE_ENABLED`, `KIRO_DISABLED_REGIONS`,
 *     `KIRO_DISABLED_MODELS` come from validated configuration —
 *     `killSwitchesFromEnv` in `@bosanda/provider-core` reads `Env`. They are
 *     static per deploy.
 *   * Per-ACCOUNT disable comes from `provider_accounts.status`, via
 *     `providerAccountsRepository.listDisabledIds`. That is the account's own state,
 *     not a flag.
 *   * This table is the RUNTIME OVERRIDE layer: it lets an operator flip a switch
 *     without a deploy, which is what §15 asks for.
 *
 * `killSwitchesFrom` below composes all three into the frozen `KillSwitches` shape,
 * with the flags taking precedence over config. Precedence runs that way because the
 * override exists precisely to countermand a deploy-time value during an incident.
 *
 * IMPORTANT, and non-negotiable: `KIRO_DIRECT_ENABLED` defaults to FALSE and stays
 * false. The M0 feasibility gate (§3, G0-G4) has not been executed — it needs real
 * Kiro credentials and live upstream traffic. `adapterEnabled` therefore resolves to
 * false unless BOTH config and an explicit operator flag turn it on, and nothing in
 * this file flips it on by default or treats a missing flag as permission.
 *
 * ── VALUE TYPING ───────────────────────────────────────────────────────────
 * `value` is JSONB with no schema, so every read is defensive: a flag holding the
 * wrong JSON type falls back to the caller's default rather than throwing. A
 * malformed flag must not take the gateway down — that would invert the purpose of a
 * kill switch. `readBoolean`/`readStringSet` are pure and unit-tested.
 */

import { type Executor, firstRow, jsonParam, requireRow } from "./executor.js";
import { type FeatureFlag, type FeatureFlagRow, toFeatureFlag } from "./rows.js";

/** Flag keys this layer knows about. Free-form keys are still allowed. */
export const FLAG_ADAPTER_ENABLED = "kiro.adapter_enabled";
export const FLAG_TOOL_USE_ENABLED = "kiro.tool_use_enabled";
export const FLAG_DISABLED_REGIONS = "kiro.disabled_regions";
export const FLAG_DISABLED_MODELS = "kiro.disabled_models";

/**
 * A boolean out of a JSONB value, or `fallback`.
 *
 * Accepts only a real JSON boolean. The strings "true"/"false" are deliberately NOT
 * coerced: an operator who typed a quoted string got the type wrong, and silently
 * honouring it would mean the same flag behaves differently depending on how it was
 * written.
 */
export function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** A string set out of a JSONB array. Non-strings are dropped; a non-array yields empty. */
export function readStringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === "string"));
}

/**
 * The config half of `KillSwitches`, mirrored rather than imported.
 *
 * Imported as a TYPE only from nowhere: `@bosanda/database` does not depend on
 * `@bosanda/provider-core` (that would invert the layering — the provider layer
 * reads from the database, not the reverse). The shape is structurally identical to
 * the frozen `KillSwitches`, so the result is assignable to it at the call site.
 */
export type KillSwitchConfig = {
  adapterEnabled: boolean;
  toolUseEnabled: boolean;
  disabledRegions: ReadonlySet<string>;
  disabledModels: ReadonlySet<string>;
};

/** Structurally the frozen `KillSwitches` from `@bosanda/provider-core`. */
export type ResolvedKillSwitches = {
  adapterEnabled: boolean;
  toolUseEnabled: boolean;
  disabledRegions: ReadonlySet<string>;
  disabledModels: ReadonlySet<string>;
  disabledAccounts: ReadonlySet<string>;
};

/**
 * Compose config, runtime flags, and disabled accounts into `KillSwitches`.
 *
 * PURE, so the precedence rules are unit-testable without a database. Usage:
 *
 *   const flags    = await flagsRepository(sql).readAll();
 *   const disabled = await providerAccountsRepository(sql).listDisabledIds("kiro");
 *   const switches = killSwitchesFrom(killSwitchesFromEnv(env), flags, disabled);
 *   const decision = evaluateKillSwitches(switches, { model, region, accountId });
 *
 * PRECEDENCE, and one asymmetry worth stating:
 *
 *   * Booleans: an explicit flag WINS over config, so an operator can turn the
 *     adapter off (or on, once the M0 gate has genuinely passed) without a deploy.
 *     An absent or malformed flag leaves the config value untouched.
 *   * Region/model sets: the flag is UNIONED with config, never replacing it. A
 *     runtime override may only add to the disabled set. Letting a flag SHRINK it
 *     would mean a stray flag could re-enable a model an operator disabled at deploy
 *     time, and during an incident the safe direction is more disabled, not less.
 */
export function killSwitchesFrom(
  config: KillSwitchConfig,
  flags: readonly FeatureFlag[],
  disabledAccounts: Iterable<string> = [],
): ResolvedKillSwitches {
  const byKey = new Map(flags.map((flag) => [flag.key, flag.value]));

  const union = (base: ReadonlySet<string>, extra: Set<string>): ReadonlySet<string> => {
    const merged = new Set(base);
    for (const item of extra) merged.add(item);
    return merged;
  };

  return {
    adapterEnabled: readBoolean(byKey.get(FLAG_ADAPTER_ENABLED), config.adapterEnabled),
    toolUseEnabled: readBoolean(byKey.get(FLAG_TOOL_USE_ENABLED), config.toolUseEnabled),
    disabledRegions: union(config.disabledRegions, readStringSet(byKey.get(FLAG_DISABLED_REGIONS))),
    disabledModels: union(config.disabledModels, readStringSet(byKey.get(FLAG_DISABLED_MODELS))),
    disabledAccounts: new Set(disabledAccounts),
  };
}

export type FlagsRepository = ReturnType<typeof flagsRepository>;

export function flagsRepository(sql: Executor) {
  return {
    /**
     * Every flag, in one query.
     *
     * The table is tiny (a handful of rows) and the gateway reads it on a cache
     * refresh rather than per request, so reading all of it is cheaper than several
     * keyed lookups and gives a CONSISTENT snapshot — two separate reads could
     * observe a half-applied operator change, which for kill switches is the one
     * thing that must not happen.
     */
    async readAll(): Promise<FeatureFlag[]> {
      const rows = await sql<FeatureFlagRow[]>`
        SELECT * FROM feature_flags ORDER BY key
      `;
      return rows.map(toFeatureFlag);
    },

    async findByKey(key: string): Promise<FeatureFlag | null> {
      const rows = await sql<FeatureFlagRow[]>`
        SELECT * FROM feature_flags WHERE key = ${key}
      `;
      const row = firstRow(rows);
      return row === null ? null : toFeatureFlag(row);
    },

    /**
     * Set one flag (§15: operator control without a deploy).
     *
     * `updatedBy` is the admin's user id and is recorded on the row, but that is NOT
     * a substitute for an audit entry: flipping a kill switch is exactly the kind of
     * action §15 wants in `audit_events`, and this row only shows the LATEST writer.
     * Call `auditRepository.append` in the same transaction.
     *
     * `value` is passed through `sql.json`, so a JS value is sent as JSONB rather than
     * a stringified TEXT that PostgreSQL would then have to cast.
     */
    async upsert(
      key: string,
      value: unknown,
      updatedBy: string | null,
      at: Date,
    ): Promise<FeatureFlag> {
      const rows = await sql<FeatureFlagRow[]>`
        INSERT INTO feature_flags (key, value, updated_by, updated_at)
        VALUES (
          ${key}, ${sql.json(jsonParam(value, `feature_flags.value for ${key}`))},
          ${updatedBy}, ${at}
        )
        ON CONFLICT (key) DO UPDATE SET
          value      = EXCLUDED.value,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `;
      return toFeatureFlag(requireRow(rows, "feature_flags upsert"));
    },

    /**
     * Remove a flag, reverting to the config default.
     *
     * Note what this means for `killSwitchesFrom`: deleting `kiro.adapter_enabled`
     * does not enable the adapter — it hands the decision back to
     * `KIRO_DIRECT_ENABLED`, which defaults to false until the M0 gate passes.
     */
    async remove(key: string): Promise<boolean> {
      const rows = await sql<{ key: string }[]>`
        DELETE FROM feature_flags WHERE key = ${key} RETURNING key
      `;
      return firstRow(rows) !== null;
    },

    /** Convenience boolean read, for a caller that wants one flag and not the set. */
    async readBooleanFlag(key: string, fallback: boolean): Promise<boolean> {
      const flag = await this.findByKey(key);
      return flag === null ? fallback : readBoolean(flag.value, fallback);
    },
  };
}
