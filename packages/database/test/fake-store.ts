/**
 * An in-memory `MigrationStore` that records what the runner asked it to do.
 *
 * Lets the ordering, checksum, and immutability rules be tested exhaustively
 * without a live PostgreSQL instance, which keeps `pnpm test` runnable on a
 * machine with no database.
 */

import type { AppliedMigration, Migration, MigrationStore } from "../src/migrations.js";

export type FakeStore = MigrationStore & {
  readonly applied: AppliedMigration[];
  readonly appliedSql: string[];
  readonly ensureRegistryCalls: number;
  /** Seed history as if these had already run. */
  seed(rows: AppliedMigration[]): void;
  /** Make the next applyInTransaction reject. */
  failNextApply(error: Error): void;
};

export function fakeStore(): FakeStore {
  const applied: AppliedMigration[] = [];
  const appliedSql: string[] = [];
  let ensureRegistryCalls = 0;
  let nextFailure: Error | null = null;

  return {
    get applied() {
      return applied;
    },
    get appliedSql() {
      return appliedSql;
    },
    get ensureRegistryCalls() {
      return ensureRegistryCalls;
    },
    seed(rows: AppliedMigration[]) {
      applied.push(...rows);
    },
    failNextApply(error: Error) {
      nextFailure = error;
    },
    ensureRegistry(): Promise<void> {
      ensureRegistryCalls += 1;
      return Promise.resolve();
    },
    listApplied(): Promise<AppliedMigration[]> {
      return Promise.resolve(applied.map((row) => ({ ...row })));
    },
    applyInTransaction(migration: Migration, checksum: string, at: Date): Promise<void> {
      if (nextFailure !== null) {
        const error = nextFailure;
        nextFailure = null;
        return Promise.reject(error);
      }
      appliedSql.push(migration.sql);
      applied.push({ id: migration.id, checksum, appliedAt: at });
      return Promise.resolve();
    },
  };
}
