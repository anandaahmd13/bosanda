/**
 * `pnpm db:migrate` — apply pending migrations.
 *
 * Deliberately has no "down" path. Rolling a schema backwards on a live
 * database with customer data is not a safe automated operation; recovery is a
 * restore plus a forward fix (PLAN.md §14).
 */

import { loadEnv } from "@bosanda/config";
import { systemClock } from "@bosanda/shared";
import { BosandaError } from "@bosanda/protocol";
import { checkConnection, closeClient, createClientFromEnv } from "../client.js";
import { loadMigrations } from "../migration-files.js";
import { migrate, planMigrations } from "../migrations.js";
import { migrationStore } from "../migration-store.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const env = loadEnv();
  const migrations = await loadMigrations();
  const sql = createClientFromEnv(env);

  try {
    await checkConnection(sql);
    const store = migrationStore(sql);
    await store.ensureRegistry();

    if (DRY_RUN) {
      const plan = planMigrations(migrations, await store.listApplied());
      console.error(`[migrate] already applied: ${plan.alreadyApplied.length}`);
      if (plan.pending.length === 0) {
        console.error("[migrate] nothing pending");
      } else {
        for (const migration of plan.pending) {
          console.error(`[migrate] would apply ${migration.id}`);
        }
      }
      return;
    }

    const result = await migrate(store, migrations, systemClock);
    if (result.applied.length === 0) {
      console.error(`[migrate] up to date (${result.skipped.length} applied previously)`);
      return;
    }
    for (const id of result.applied) {
      console.error(`[migrate] applied ${id}`);
    }
    console.error(`[migrate] done: ${result.applied.length} applied`);
  } finally {
    await closeClient(sql);
  }
}

try {
  await main();
} catch (error) {
  // Migration failures are operator-facing: print the internal detail, which
  // is where planMigrations puts the "modified after release" explanation.
  const message =
    error instanceof BosandaError
      ? (error.internalDetail ?? error.code)
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`[migrate] FAILED: ${message}`);
  process.exitCode = 1;
}
