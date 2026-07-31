/**
 * Loads migration SQL from disk.
 *
 * Kept separate from the runner so the runner stays pure and testable without
 * touching a filesystem, and so the SQL lives in `.sql` files that a DBA can
 * read and a linter can check — not in template literals.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BosandaError } from "@bosanda/protocol";
import type { Migration } from "./migrations.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** `0001_initial_schema.sql` -> id `0001_initial_schema`. */
const FILENAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export function migrationsDirectory(): string {
  return MIGRATIONS_DIR;
}

/**
 * Read every migration in the package's `migrations/` directory, ordered by
 * filename. Rejects filenames that do not carry a 4-digit ordinal, because
 * ordering is load-bearing and an unordered file would apply unpredictably.
 */
export async function loadMigrations(directory: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const migrations: Migration[] = [];
  const seenOrdinals = new Map<string, string>();

  for (const name of files) {
    const match = FILENAME_PATTERN.exec(name);
    if (match === null) {
      throw new BosandaError("internal_error", {
        internalDetail:
          `migration file ${name} does not match NNNN_lower_snake_case.sql; ` +
          `ordering depends on the numeric prefix`,
      });
    }

    const [, ordinal] = match;
    if (ordinal === undefined) {
      throw new BosandaError("internal_error", {
        internalDetail: `migration file ${name} matched without an ordinal group`,
      });
    }
    const previous = seenOrdinals.get(ordinal);
    if (previous !== undefined) {
      throw new BosandaError("internal_error", {
        internalDetail: `migrations ${previous} and ${name} share ordinal ${ordinal}`,
      });
    }
    seenOrdinals.set(ordinal, name);

    const sql = await readFile(path.join(directory, name), "utf8");
    if (sql.trim() === "") {
      throw new BosandaError("internal_error", {
        internalDetail: `migration file ${name} is empty`,
      });
    }

    migrations.push({ id: name.replace(/\.sql$/, ""), sql });
  }

  return migrations;
}
