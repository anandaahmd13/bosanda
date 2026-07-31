/**
 * The executor abstraction every repository is built on.
 *
 * WHY THIS EXISTS. PLAN.md §13 step 8 and §16 invariant 5 require several
 * repositories to commit inside ONE transaction: mark the order paid, consume
 * stock, create or top up the key, append the ledger row, write audit. If each
 * factory demanded a pool handle (`Sql`), that composition would be impossible
 * without reaching around the layer.
 *
 * So every factory takes an `Executor` — the shared surface of `Sql` (the pool)
 * and `TransactionSql` (a transaction). Callers pass the pool for a single
 * statement and a `tx` when several statements must land together:
 *
 *   const key = await apiKeysRepository(sql).findByLookupDigest(digest);
 *
 *   await withTransaction(sql, async (tx) => {
 *     await ordersRepository(tx).markActivated(orderId, at);
 *     await quotaRepository(tx).recordGrant({ ... });
 *     await auditRepository(tx).append({ ... });
 *   });
 *
 * A repository NEVER opens its own transaction around work a caller might want
 * to extend — the two exceptions are documented at their definitions
 * (`quotaRepository.recordDebit` and `executeActivation`), where atomicity is
 * the method's entire purpose.
 */

import type postgres from "postgres";
import { BosandaError } from "@bosanda/protocol";
import type { Sql } from "../client.js";

/** A transaction handle, as handed to `withTransaction`. */
export type Tx = postgres.TransactionSql<Record<string, never>>;

/**
 * What repositories accept. Both `Sql` and `Tx` structurally satisfy it, so a
 * repository cannot tell (and must not care) whether it is inside a transaction.
 */
export type Executor = postgres.ISql<Record<string, never>>;

/**
 * Run `fn` inside a single database transaction, committing on resolve and
 * rolling back on throw.
 *
 * `sql.begin` already provides exactly this; the wrapper exists so call sites in
 * the gateway and worker import one documented name from `@bosanda/database`
 * rather than reaching for the driver, and so the `Tx` type they receive is ours.
 */
export function withTransaction<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // The driver's `UnwrapPromiseArray<T>` return type only differs from `T` for
  // array-of-promise returns, which no caller here produces.
  return sql.begin((tx) => fn(tx)) as Promise<T>;
}

/**
 * True when this executor is a transaction handle rather than the pool.
 *
 * Detected by the presence of `savepoint`, which is the driver's own marker: in
 * `postgres@3.4.9`, `begin` is attached ONLY to the top-level pool object, while a
 * transaction handle is built by an internal `Sql()` call that attaches
 * `savepoint` and `prepare`. So `tx.begin` is `undefined` at runtime even though
 * both types share the `ISql` surface — which is exactly the trap `atomically`
 * below exists to avoid.
 */
export function isTransaction(executor: Executor): boolean {
  return typeof (executor as { savepoint?: unknown }).savepoint === "function";
}

/**
 * Run `fn` as one atomic unit, whether `executor` is the pool or already a
 * transaction.
 *
 * This is what lets a method like `quotaRepository.recordDebit` guarantee
 * atomicity on its own AND compose into a larger transaction:
 *
 *   * pool handle  -> `begin`, a real transaction that commits when `fn` resolves.
 *   * transaction  -> `savepoint`, so the work rolls back independently on failure
 *                     but commits with the ENCLOSING transaction. A caller doing
 *                     activation therefore still gets one commit, not two.
 *
 * Dispatching on the handle rather than assuming one shape is not defensive
 * padding: calling `begin` on a transaction handle is a `TypeError`, and calling
 * nothing at all would silently drop the atomicity these methods promise.
 */
export function atomically<T>(
  executor: Executor,
  fn: (executor: Executor) => Promise<T>,
): Promise<T> {
  const candidate = executor as {
    savepoint?: (cb: (tx: Tx) => Promise<T>) => Promise<T>;
    begin?: (cb: (tx: Tx) => Promise<T>) => Promise<T>;
  };

  if (typeof candidate.savepoint === "function") {
    return candidate.savepoint((tx) => fn(tx));
  }
  if (typeof candidate.begin === "function") {
    return candidate.begin((tx) => fn(tx));
  }

  throw new BosandaError("internal_error", {
    internalDetail: "executor supports neither begin nor savepoint; cannot guarantee atomicity",
  });
}

/**
 * Narrows a value to what the driver will accept for a `jsonb` column.
 *
 * WHY THIS IS NEEDED. Our domain types describe JSON columns as
 * `Record<string, unknown>` — the honest type for operator-supplied audit
 * metadata or a model's capability bag. But `postgres@3.4.9` types `sql.json()`
 * as taking `JSONValue`, which deliberately EXCLUDES `unknown` so that symbols
 * and bigints (both of which `JSON.stringify` silently mangles) cannot reach a
 * query. `Record<string, unknown>` is therefore not assignable, even though every
 * value we actually pass is plain JSON.
 *
 * The runtime check is what makes the cast honest rather than a `as never`
 * silencer: a symbol or bigint that reached here WOULD serialize wrongly —
 * `JSON.stringify` drops symbol-valued keys and throws on bigint — so failing
 * loudly at the call site beats writing a subtly wrong row. §16's audit trail is
 * only useful if what it recorded is what happened.
 */
export function jsonParam(value: unknown, what: string): postgres.JSONValue {
  try {
    JSON.stringify(value);
  } catch (cause) {
    throw new BosandaError("internal_error", {
      internalDetail: `${what} is not JSON-serializable`,
      cause,
    });
  }
  return value as postgres.JSONValue;
}

/** First row or null. Written once so `noUncheckedIndexedAccess` is honoured uniformly. */
export function firstRow<T>(rows: readonly T[]): T | null {
  return rows[0] ?? null;
}

/**
 * First row, or a thrown `internal_error`.
 *
 * For statements whose own shape guarantees a row (an unconditional INSERT ...
 * RETURNING, an aggregate). Missing means the query changed, not that the caller
 * passed something wrong, so this is deliberately not `not_found`.
 */
export function requireRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new BosandaError("internal_error", { internalDetail: `${what} returned no row` });
  }
  return row;
}
