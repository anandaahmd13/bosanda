/**
 * Migration runner (PLAN.md §14: "migrations are ordered and immutable after
 * release").
 *
 * Immutability is enforced, not documented: every applied migration's SHA-256
 * is recorded, and re-running against a changed file refuses rather than
 * silently diverging schema from history. That refusal is the whole point — a
 * migration edited after release means some databases have the old statements
 * and some have the new, and no later migration can tell which.
 */

import { createHash } from "node:crypto";
import type { Clock } from "@bosanda/shared";
import { BosandaError } from "@bosanda/protocol";

/** A single ordered migration. `id` sorts lexicographically. */
export type Migration = {
  /** Zero-padded ordinal + slug, e.g. `0001_initial_schema`. */
  id: string;
  sql: string;
};

/** A row of the `schema_migrations` bookkeeping table. */
export type AppliedMigration = {
  id: string;
  checksum: string;
  appliedAt: Date;
};

/**
 * The subset of a `postgres` client this module needs. Narrowing to an
 * interface keeps the runner testable against a recorder without a live
 * database, and without depending on the driver's generic parameters.
 */
export type MigrationStore = {
  /** Create the bookkeeping table if absent. Must be idempotent. */
  ensureRegistry(): Promise<void>;
  listApplied(): Promise<AppliedMigration[]>;
  /**
   * Apply one migration and record it in the SAME transaction. A crash between
   * the DDL and the bookkeeping row would otherwise leave a migration applied
   * but unrecorded, and the next run would try to apply it again.
   */
  applyInTransaction(migration: Migration, checksum: string, at: Date): Promise<void>;
};

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export type MigrationPlan = {
  pending: Migration[];
  alreadyApplied: string[];
};

/**
 * Compare migrations on disk against what the database has applied.
 *
 * Throws rather than returning a plan when history and disk disagree, because
 * every such disagreement means the schema is not reproducible from the
 * migration files and applying more DDL would deepen the divergence.
 */
export function planMigrations(
  available: readonly Migration[],
  applied: readonly AppliedMigration[],
): MigrationPlan {
  const ordered = [...available].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const duplicate = findDuplicateId(ordered);
  if (duplicate !== null) {
    throw new BosandaError("internal_error", {
      internalDetail: `duplicate migration id ${duplicate}`,
    });
  }

  const appliedById = new Map(applied.map((row) => [row.id, row]));
  const availableIds = new Set(ordered.map((m) => m.id));

  // A recorded migration with no file: history cannot be replayed onto a fresh
  // database, so treat it as a hard error rather than assuming it is obsolete.
  for (const row of applied) {
    if (!availableIds.has(row.id)) {
      throw new BosandaError("internal_error", {
        internalDetail: `migration ${row.id} is recorded as applied but no longer exists on disk`,
      });
    }
  }

  const pending: Migration[] = [];
  for (const migration of ordered) {
    const row = appliedById.get(migration.id);
    if (row === undefined) {
      pending.push(migration);
      continue;
    }
    const checksum = checksumOf(migration.sql);
    if (row.checksum !== checksum) {
      throw new BosandaError("internal_error", {
        internalDetail:
          `migration ${migration.id} was modified after being applied ` +
          `(recorded ${row.checksum.slice(0, 12)}, on disk ${checksum.slice(0, 12)}); ` +
          `migrations are immutable after release — add a new migration instead`,
      });
    }
  }

  // Refuse a pending migration that sorts before something already applied:
  // it would run out of order against every database that is already ahead.
  const lastApplied = [...appliedById.keys()].sort().at(-1);
  if (lastApplied !== undefined) {
    const outOfOrder = pending.find((m) => m.id < lastApplied);
    if (outOfOrder !== undefined) {
      throw new BosandaError("internal_error", {
        internalDetail:
          `migration ${outOfOrder.id} is pending but sorts before already-applied ` +
          `${lastApplied}; inserting migrations into history is not supported`,
      });
    }
  }

  return { pending, alreadyApplied: [...appliedById.keys()].sort() };
}

function findDuplicateId(ordered: readonly Migration[]): string | null {
  const seen = new Set<string>();
  for (const migration of ordered) {
    if (seen.has(migration.id)) return migration.id;
    seen.add(migration.id);
  }
  return null;
}

export type MigrateResult = {
  applied: string[];
  skipped: string[];
};

/** Apply all pending migrations in order, stopping at the first failure. */
export async function migrate(
  store: MigrationStore,
  available: readonly Migration[],
  clock: Clock,
): Promise<MigrateResult> {
  await store.ensureRegistry();
  const plan = planMigrations(available, await store.listApplied());

  const applied: string[] = [];
  for (const migration of plan.pending) {
    await store.applyInTransaction(migration, checksumOf(migration.sql), clock.now());
    applied.push(migration.id);
  }

  return { applied, skipped: plan.alreadyApplied };
}
