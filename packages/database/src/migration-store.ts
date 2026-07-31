/**
 * The postgres-backed `MigrationStore`.
 *
 * Isolated from the runner's decision logic so that logic can be tested
 * exhaustively against a recorder, leaving only these few statements needing a
 * live database.
 */

import type { Sql } from "./client.js";
import type { AppliedMigration, Migration, MigrationStore } from "./migrations.js";

const ADVISORY_LOCK_KEY = 4_820_5311;

export function migrationStore(sql: Sql): MigrationStore {
  return {
    async ensureRegistry(): Promise<void> {
      await sql`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id         TEXT PRIMARY KEY,
          checksum   TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL
        )
      `;
    },

    async listApplied(): Promise<AppliedMigration[]> {
      const rows = await sql<{ id: string; checksum: string; applied_at: Date }[]>`
        SELECT id, checksum, applied_at FROM schema_migrations ORDER BY id
      `;
      return rows.map((row) => ({
        id: row.id,
        checksum: row.checksum,
        appliedAt: row.applied_at,
      }));
    },

    async applyInTransaction(migration: Migration, checksum: string, at: Date): Promise<void> {
      await sql.begin(async (tx) => {
        // Serialize concurrent migrators (two deploys landing at once). The
        // lock is transaction-scoped, so it releases even if this throws.
        await tx`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;

        // Re-check inside the lock: another migrator may have applied this
        // while we waited, in which case there is nothing left to do.
        const [existing] = await tx<{ id: string }[]>`
          SELECT id FROM schema_migrations WHERE id = ${migration.id}
        `;
        if (existing !== undefined) return;

        // `unsafe` is required because migration bodies are DDL, which cannot
        // be parameterized. The input is a file shipped inside this package —
        // never request data — and loadMigrations() restricts which files
        // qualify. This is the one place raw SQL execution is legitimate.
        await tx.unsafe(migration.sql);

        await tx`
          INSERT INTO schema_migrations (id, checksum, applied_at)
          VALUES (${migration.id}, ${checksum}, ${at})
        `;
      });
    },
  };
}
