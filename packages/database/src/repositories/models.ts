/**
 * `models` — the model catalogue behind GET /v1/models and the multiplier registry
 * (PLAN.md §9 model catalogue, §10 metering).
 *
 * ── WHAT `listPublished` MAY RETURN, AND WHAT IT MAY NOT ────────────────────
 * §3 requires that an untested model never appears on /v1/models, and the schema
 * enforces it (`models_published_requires_passing`: published implies
 * `compatibility_status IN ('passing','degraded')`). This file adds the second
 * half — `upstreamId` is present on `ModelRecord` because the adapter needs it, and
 * the frozen `ProviderModel` contract marks it "never surfaced to clients". Use
 * `toProviderModel` (in `rows.ts`) to build the response shape; do not serialize a
 * `ModelRecord` straight to a client.
 *
 * The kill switches are NOT applied here. §3's global and per-model switches live in
 * configuration, not in this table, and `isModelPubliclyVisible` in
 * `@bosanda/provider-core` is the single place they are interpreted. This
 * repository reports what the catalogue says; the caller filters. Duplicating the
 * switch logic in SQL would create a second place for the two to disagree.
 *
 * ── THE MULTIPLIER FEED ────────────────────────────────────────────────────
 * `multiplierRecords` builds the `MultiplierRecord[]` a `MultiplierRegistry`
 * consumes. Two things are worth knowing before relying on it:
 *
 *   * It feeds EVERY model, published or not. Settling a request that ran before a
 *     model was unpublished must still resolve that model's multiplier, and §9's
 *     "a multiplier change never rewrites historical usage" depends on old versions
 *     staying resolvable.
 *   * The schema holds ONE row per public_id, so the registry gets one version per
 *     model. §9 describes multiplier changes as new versions, but with `public_id`
 *     as the primary key a version is not a separate row — updating a multiplier
 *     overwrites the previous one and `MultiplierRegistry.atVersion(model, old)`
 *     will then throw for the superseded version. Storing full version history
 *     needs a new table and therefore a new migration; the schema is immutable
 *     after release (§14). Flagged here rather than papered over: settling an
 *     in-flight request across a multiplier edit is the case that would surface it,
 *     and `quota_ledger.multiplier` records the exact figure used, so the LEDGER
 *     stays explainable even though the registry cannot re-derive it.
 */

import { type Executor, firstRow, jsonParam, requireRow } from "./executor.js";
import {
  type CompatibilityStatus,
  type ModelRecord,
  type ModelRow,
  toModelRecord,
  toMultiplierRecord,
} from "./rows.js";

export type UpsertModelInput = {
  publicId: string;
  providerType: string;
  /** Upstream provider model ID. Never returned to a client (§16). */
  upstreamId: string;
  label: string;
  contextWindow: number;
  /**
   * The multiplier as an exact decimal STRING, e.g. "1.3000".
   *
   * A string rather than a number so the value written is byte-identical to what an
   * operator entered: NUMERIC(10,4) round-trips a string exactly, whereas a float
   * literal invites a value that differs in the fourth decimal from what the admin
   * form showed. A number is accepted and stringified for callers holding only the
   * parsed form.
   */
  multiplier: string | number;
  /** TEXT in the schema; must parse as a positive integer (see `toMultiplierRecord`). */
  multiplierVersion: string;
  capabilities: Record<string, unknown>;
  regions: readonly string[];
  published: boolean;
  compatibilityStatus: CompatibilityStatus;
  at: Date;
};

export type ModelsRepository = ReturnType<typeof modelsRepository>;

export function modelsRepository(sql: Executor) {
  return {
    /**
     * The GET /v1/models catalogue.
     *
     * Matches `models_published_idx (published, public_id)`, so the filter and the
     * sort are both served by the index. Ordered by `public_id` for a stable listing
     * — clients diffing the response should not see spurious reordering.
     *
     * The caller must still apply `isModelPubliclyVisible` (§3) before responding.
     */
    async listPublished(): Promise<ModelRecord[]> {
      const rows = await sql<ModelRow[]>`
        SELECT * FROM models
        WHERE published = TRUE
        ORDER BY public_id
      `;
      return rows.map(toModelRecord);
    },

    /** Every model, published or not — the admin catalogue (§9 staged updates). */
    async listAll(): Promise<ModelRecord[]> {
      const rows = await sql<ModelRow[]>`SELECT * FROM models ORDER BY public_id`;
      return rows.map(toModelRecord);
    },

    async findByPublicId(publicId: string): Promise<ModelRecord | null> {
      const rows = await sql<ModelRow[]>`
        SELECT * FROM models WHERE public_id = ${publicId}
      `;
      const row = firstRow(rows);
      return row === null ? null : toModelRecord(row);
    },

    /** Models a given adapter serves — what the scheduler needs to match accounts. */
    async listByProviderType(providerType: string): Promise<ModelRecord[]> {
      const rows = await sql<ModelRow[]>`
        SELECT * FROM models WHERE provider_type = ${providerType} ORDER BY public_id
      `;
      return rows.map(toModelRecord);
    },

    /**
     * THE MULTIPLIER REGISTRY FEED for `@bosanda/metering`:
     *
     *   const registry = new MultiplierRegistry(await modelsRepository(sql).multiplierRecords());
     *
     * Every model is included, not only published ones — see the file header for why,
     * and for the one-version-per-model limitation this inherits from the schema.
     *
     * A row whose `multiplier_version` is not a positive integer makes
     * `toMultiplierRecord` throw rather than be silently skipped: a model missing
     * from the registry would fail every request for it at settle time with a much
     * more confusing error than "this row is malformed".
     */
    async multiplierRecords(): Promise<
      { model: string; version: number; multiplier: number; effectiveAt: Date }[]
    > {
      const rows = await sql<ModelRow[]>`
        SELECT * FROM models ORDER BY public_id
      `;
      return rows.map((row) => toMultiplierRecord(toModelRecord(row)));
    },

    /**
     * Create or update a catalogue entry (§9: admin-managed, staged, no deploy).
     *
     * `published` is written as given; the CHECK constraint refuses to publish a
     * model whose compatibility gate has not passed, which is where §3's
     * "no untested model on /v1/models" is actually enforced.
     */
    async upsert(input: UpsertModelInput): Promise<ModelRecord> {
      const multiplier =
        typeof input.multiplier === "number" ? String(input.multiplier) : input.multiplier;
      const rows = await sql<ModelRow[]>`
        INSERT INTO models (
          public_id, provider_type, upstream_id, label, context_window,
          multiplier, multiplier_version, capabilities, regions,
          published, compatibility_status, updated_at
        ) VALUES (
          ${input.publicId}, ${input.providerType}, ${input.upstreamId}, ${input.label},
          ${input.contextWindow}, ${multiplier}, ${input.multiplierVersion},
          ${sql.json(jsonParam(input.capabilities, "models.capabilities"))},
          ${sql.json([...input.regions])},
          ${input.published}, ${input.compatibilityStatus}, ${input.at}
        )
        ON CONFLICT (public_id) DO UPDATE SET
          provider_type        = EXCLUDED.provider_type,
          upstream_id          = EXCLUDED.upstream_id,
          label                = EXCLUDED.label,
          context_window       = EXCLUDED.context_window,
          multiplier           = EXCLUDED.multiplier,
          multiplier_version   = EXCLUDED.multiplier_version,
          capabilities         = EXCLUDED.capabilities,
          regions              = EXCLUDED.regions,
          published            = EXCLUDED.published,
          compatibility_status = EXCLUDED.compatibility_status,
          updated_at           = EXCLUDED.updated_at
        RETURNING *
      `;
      return toModelRecord(requireRow(rows, "models upsert"));
    },

    /**
     * Publish or unpublish (§9 "Model updates are staged and require admin approval
     * before publication").
     *
     * Publishing is guarded on `compatibility_status IN ('passing','degraded')` in
     * the WHERE, not left to the CHECK: a guard returns null ("this model is not
     * eligible yet"), whereas the CHECK would abort the transaction and take any
     * accompanying audit write with it.
     */
    async setPublished(
      publicId: string,
      published: boolean,
      at: Date,
    ): Promise<ModelRecord | null> {
      const rows = published
        ? await sql<ModelRow[]>`
            UPDATE models
            SET published = TRUE, updated_at = ${at}
            WHERE public_id = ${publicId}
              AND compatibility_status IN ('passing', 'degraded')
            RETURNING *
          `
        : await sql<ModelRow[]>`
            UPDATE models
            SET published = FALSE, updated_at = ${at}
            WHERE public_id = ${publicId}
            RETURNING *
          `;
      const row = firstRow(rows);
      return row === null ? null : toModelRecord(row);
    },

    /**
     * Record a compatibility-gate result (§3 per-model gate).
     *
     * A model that starts failing is unpublished in the SAME statement, because the
     * CHECK forbids `published = TRUE` with `compatibility_status = 'failing'` — two
     * statements would leave a moment where the row violates its own constraint (and
     * the first would simply be rejected).
     */
    async setCompatibilityStatus(
      publicId: string,
      status: CompatibilityStatus,
      at: Date,
    ): Promise<ModelRecord | null> {
      const rows = await sql<ModelRow[]>`
        UPDATE models
        SET compatibility_status = ${status},
            published = CASE
                          WHEN ${status} IN ('passing', 'degraded') THEN published
                          ELSE FALSE
                        END,
            updated_at = ${at}
        WHERE public_id = ${publicId}
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toModelRecord(row);
    },

    /**
     * Update a multiplier, advancing `multiplier_version`.
     *
     * §9: "a multiplier change never rewrites historical usage". This layer honours
     * that by never touching `quota_ledger` — historical rows keep the
     * `multiplier` they were priced with. The version bump is what lets
     * `MultiplierRegistry` distinguish the new figure from the old, subject to the
     * one-row-per-model caveat in the file header.
     *
     * The new version must exceed the current one; a non-advancing version would
     * make two different multipliers claim the same version and break
     * reproducibility, so the guard is in the WHERE and a violation returns null.
     */
    async setMultiplier(
      publicId: string,
      multiplier: string | number,
      multiplierVersion: string,
      at: Date,
    ): Promise<ModelRecord | null> {
      const value = typeof multiplier === "number" ? String(multiplier) : multiplier;
      const rows = await sql<ModelRow[]>`
        UPDATE models
        SET multiplier = ${value},
            multiplier_version = ${multiplierVersion},
            updated_at = ${at}
        WHERE public_id = ${publicId}
          AND (multiplier_version)::BIGINT < (${multiplierVersion})::BIGINT
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toModelRecord(row);
    },
  };
}
