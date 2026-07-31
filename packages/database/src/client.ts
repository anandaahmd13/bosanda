/**
 * PostgreSQL connection handling.
 *
 * `postgres` (not an ORM, per PLAN.md §4) is used through its tagged-template
 * interface, which parameterizes every interpolated value. Query construction
 * elsewhere in the codebase MUST go through that tag rather than string
 * concatenation — that is the project's SQL-injection boundary.
 */

import postgres from "postgres";
import type { Env } from "@bosanda/config";
import { BosandaError } from "@bosanda/protocol";

/** The tagged-template client type used across the repo. */
export type Sql = postgres.Sql<Record<string, never>>;

export type CreateClientOptions = {
  connectionString: string;
  maxConnections?: number;
  /** Fail a connection attempt after this many seconds. */
  connectTimeoutSeconds?: number;
  /** Close idle pool connections after this many seconds. */
  idleTimeoutSeconds?: number;
  onNotice?: (notice: unknown) => void;
};

export function createClient(options: CreateClientOptions): Sql {
  return postgres(options.connectionString, {
    max: options.maxConnections ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 30,
    // Timestamps are UTC everywhere (PLAN.md §14). Pinning the session
    // timezone means a differently-configured server cannot shift what we read.
    connection: { timezone: "UTC" },
    // Returning JS Dates (the driver default) keeps Clock-based logic uniform.
    onnotice: options.onNotice ?? (() => {}),
    // Never log query parameters: they carry API keys and password hashes.
    debug: false,
    transform: { undefined: null },
  });
}

export function createClientFromEnv(env: Env): Sql {
  return createClient({
    connectionString: env.DATABASE_URL,
    maxConnections: env.DATABASE_MAX_CONNECTIONS,
  });
}

/**
 * Verify the connection is usable. Called at service startup so a
 * misconfigured database fails immediately and loudly rather than on the first
 * customer request.
 */
export async function checkConnection(sql: Sql): Promise<void> {
  try {
    await sql`SELECT 1`;
  } catch (error) {
    throw new BosandaError("internal_error", {
      cause: error,
      // The driver's message can include the connection string; keep it out.
      internalDetail: "database connection check failed",
    });
  }
}

export async function closeClient(sql: Sql, timeoutSeconds = 5): Promise<void> {
  await sql.end({ timeout: timeoutSeconds });
}
