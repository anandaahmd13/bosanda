/**
 * `packages` + `package_stock` (PLAN.md §11 "Packages, pricing, stock").
 *
 * ── WHY STOCK MOVES BY COMPARE-AND-SWAP ────────────────────────────────────
 * §14 makes `package_stock.version` an optimistic-concurrency counter and §11
 * requires that "webhook processing is idempotent and never decrements stock
 * twice". Two buyers reaching the last unit at the same instant must not both
 * succeed.
 *
 * Every mutation here is therefore a guarded UPDATE:
 *
 *   SET ... version = version + 1
 *   WHERE package_id = $1 AND version = $expected AND <arithmetic is legal>
 *
 * A caller reads the row, decides, and writes through the version it read. If
 * anyone else moved the row in between, the WHERE matches nothing and the caller
 * learns it lost.
 *
 * ── A FAILED CAS IS A RETURN VALUE, NOT AN EXCEPTION ───────────────────────
 * `StockCasOutcome` (see `decisions.ts`) distinguishes `version_conflict` (retry,
 * nothing is wrong) from `insufficient` (sold out, a 409 for the customer) from
 * `missing` (no operator-set stock row at all). Those demand different responses,
 * so collapsing them into a thrown error would force every call site to re-parse a
 * message to decide between retrying and giving up. The three are indistinguishable
 * from "0 rows updated" alone, which is why each failure path re-reads the row and
 * hands it to `classifyStockFailure`.
 *
 * ── THE GUARD IS IN THE SQL, NOT ONLY IN TYPESCRIPT ────────────────────────
 * `available >= 0` and `reserved >= 0` are CHECK constraints. Were the arithmetic
 * guard omitted from the WHERE, an illegal decrement would abort the whole
 * transaction — taking the order write with it — instead of reporting a clean
 * `insufficient`. `canReserve`/`canRelease`/`canCommit` in `decisions.ts` mirror
 * each guard so the same rule is unit-testable without a database.
 */

import { type Executor, firstRow, requireRow } from "./executor.js";
import {
  type PackageRecord,
  type PackageRow,
  type PackageStock,
  type PackageStockRow,
  toPackageRecord,
  toPackageStock,
} from "./rows.js";
import { type StockCasOutcome, classifyStockFailure } from "./decisions.js";

/** What a CAS statement returns when it applied. */
type StockCasRow = { version: string; available: number; reserved: number };

export type UpsertPackageInput = {
  id: string;
  name: string;
  weightedTokenQuota: number;
  priceIdr: number;
  durationSeconds: number;
  maxKeyQuota: number;
  /** Public model IDs the package may use. `[]` means no restriction (§9). */
  allowedModels: readonly string[];
  active: boolean;
  at: Date;
};

export type PackagesRepository = ReturnType<typeof packagesRepository>;

export function packagesRepository(sql: Executor) {
  /**
   * Re-read the stock row to classify a CAS that matched nothing.
   *
   * Deliberately NOT `FOR UPDATE`: this read only decides which error the caller
   * sees, and taking a lock on the losing path would let a contended package
   * serialize every failed attempt behind the winner.
   */
  const observe = async (packageId: string): Promise<PackageStock | null> => {
    const rows = await sql<PackageStockRow[]>`
      SELECT * FROM package_stock WHERE package_id = ${packageId}
    `;
    const row = firstRow(rows);
    return row === null ? null : toPackageStock(row);
  };

  const applied = (row: StockCasRow): StockCasOutcome => ({
    ok: true,
    version: Number(row.version),
    available: row.available,
    reserved: row.reserved,
  });

  return {
    /**
     * The storefront package list (§11: buyers pick a 10M increment).
     *
     * Ordered by quota so the UI renders 10M → 100M without re-sorting, and
     * inactive packages are excluded: §11 keeps records admin-managed, and
     * deactivating a size must remove it from sale while paid orders keep their
     * snapshot.
     */
    async listActive(): Promise<PackageRecord[]> {
      const rows = await sql<PackageRow[]>`
        SELECT * FROM packages
        WHERE active = TRUE
        ORDER BY weighted_token_quota ASC
      `;
      return rows.map(toPackageRecord);
    },

    /** Every package including inactive ones — the admin catalogue (§15). */
    async listAll(): Promise<PackageRecord[]> {
      const rows = await sql<PackageRow[]>`
        SELECT * FROM packages ORDER BY weighted_token_quota ASC
      `;
      return rows.map(toPackageRecord);
    },

    async findById(id: string): Promise<PackageRecord | null> {
      const rows = await sql<PackageRow[]>`SELECT * FROM packages WHERE id = ${id}`;
      const row = firstRow(rows);
      return row === null ? null : toPackageRecord(row);
    },

    /**
     * Packages with their stock, for the storefront's "sold out" badge.
     *
     * LEFT JOIN: a package with no `package_stock` row has never had stock set by
     * an operator (§11 "manually managed"), which is different from having zero.
     * `stock: null` preserves that distinction rather than reporting a fake 0.
     */
    async listActiveWithStock(): Promise<{ package: PackageRecord; stock: PackageStock | null }[]> {
      const rows = await sql<(PackageRow & StockJoin)[]>`
        SELECT p.*,
               s.available  AS stock_available,
               s.reserved   AS stock_reserved,
               s.version    AS stock_version,
               s.updated_at AS stock_updated_at
        FROM packages p
        LEFT JOIN package_stock s ON s.package_id = p.id
        WHERE p.active = TRUE
        ORDER BY p.weighted_token_quota ASC
      `;
      return rows.map((row) => ({
        package: toPackageRecord(row),
        stock:
          row.stock_available === null ||
          row.stock_reserved === null ||
          row.stock_version === null ||
          row.stock_updated_at === null
            ? null
            : toPackageStock({
                package_id: row.id,
                available: row.stock_available,
                reserved: row.stock_reserved,
                version: row.stock_version,
                updated_at: row.stock_updated_at,
              }),
      }));
    },

    /** Create or replace a package definition (§11: admin-managed, no deploy). */
    async upsert(input: UpsertPackageInput): Promise<PackageRecord> {
      const rows = await sql<PackageRow[]>`
        INSERT INTO packages (
          id, name, weighted_token_quota, price_idr, duration_seconds,
          max_key_quota, allowed_models, active, created_at, updated_at
        ) VALUES (
          ${input.id}, ${input.name}, ${input.weightedTokenQuota}, ${input.priceIdr},
          ${input.durationSeconds}, ${input.maxKeyQuota},
          ${sql.json([...input.allowedModels])}, ${input.active},
          ${input.at}, ${input.at}
        )
        ON CONFLICT (id) DO UPDATE SET
          name                 = EXCLUDED.name,
          weighted_token_quota = EXCLUDED.weighted_token_quota,
          price_idr            = EXCLUDED.price_idr,
          duration_seconds     = EXCLUDED.duration_seconds,
          max_key_quota        = EXCLUDED.max_key_quota,
          allowed_models       = EXCLUDED.allowed_models,
          active               = EXCLUDED.active,
          updated_at           = EXCLUDED.updated_at
        RETURNING *
      `;
      return toPackageRecord(requireRow(rows, "packages upsert"));
    },

    /** Deactivate a size. Paid orders keep their snapshot (§11); nothing is deleted. */
    async setActive(id: string, active: boolean, at: Date): Promise<PackageRecord | null> {
      const rows = await sql<PackageRow[]>`
        UPDATE packages SET active = ${active}, updated_at = ${at}
        WHERE id = ${id}
        RETURNING *
      `;
      const row = firstRow(rows);
      return row === null ? null : toPackageRecord(row);
    },

    // ─────────────────────────── stock ───────────────────────────

    /**
     * Read stock, including the `version` a subsequent CAS must present.
     *
     * Returns null when no row exists — no operator has set stock for the size.
     */
    async readStock(packageId: string): Promise<PackageStock | null> {
      return observe(packageId);
    },

    /**
     * Read stock FOR UPDATE, serializing contenders instead of racing them.
     *
     * An alternative to the CAS for callers already inside a transaction that must
     * not retry (activation, for instance, where losing means unwinding other
     * writes). Both approaches are offered because they suit different call sites:
     * checkout can cheaply retry a `version_conflict`, activation would rather wait.
     * Pointless on a pool handle, where the lock releases immediately.
     */
    async lockStock(packageId: string): Promise<PackageStock | null> {
      const rows = await sql<PackageStockRow[]>`
        SELECT * FROM package_stock WHERE package_id = ${packageId} FOR UPDATE
      `;
      const row = firstRow(rows);
      return row === null ? null : toPackageStock(row);
    },

    /** Set physical stock for a size (§11 "manually managed per package size"). */
    async setStock(packageId: string, available: number, at: Date): Promise<PackageStock> {
      const rows = await sql<PackageStockRow[]>`
        INSERT INTO package_stock (package_id, available, reserved, version, updated_at)
        VALUES (${packageId}, ${available}, 0, 0, ${at})
        ON CONFLICT (package_id) DO UPDATE SET
          available  = EXCLUDED.available,
          -- reserved is NOT reset: pending orders still hold their units, and
          -- zeroing it would let those units be promised to a second buyer.
          version    = package_stock.version + 1,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `;
      return toPackageStock(requireRow(rows, "package_stock upsert"));
    },

    /**
     * Hold `units` while payment is pending (§11: "Stock is reserved while payment
     * is pending for a configured period").
     *
     * Reserves against FREE stock (`available - reserved`), not against `available`,
     * so a unit already held by another pending order cannot be promised twice.
     * `canReserve` in `decisions.ts` mirrors that guard.
     */
    async reserveStock(
      packageId: string,
      units: number,
      expectedVersion: number,
      at: Date,
    ): Promise<StockCasOutcome> {
      if (!Number.isInteger(units) || units < 1) {
        return { ok: false, reason: "insufficient" };
      }
      const rows = await sql<StockCasRow[]>`
        UPDATE package_stock
        SET reserved = reserved + ${units},
            version = version + 1,
            updated_at = ${at}
        WHERE package_id = ${packageId}
          AND version = ${expectedVersion}
          AND available - reserved >= ${units}
        RETURNING version, available, reserved
      `;
      const row = firstRow(rows);
      if (row !== null) return applied(row);
      return classifyStockFailure(await observe(packageId), expectedVersion);
    },

    /**
     * Give held units back (§11: "Expired/cancelled pending orders release the
     * reservation").
     *
     * `available` is untouched: the unit was never sold, only held. Guarded on
     * `reserved >= units` so a double release cannot drive the counter negative and
     * abort the sweep transaction.
     */
    async releaseStock(
      packageId: string,
      units: number,
      expectedVersion: number,
      at: Date,
    ): Promise<StockCasOutcome> {
      if (!Number.isInteger(units) || units < 1) {
        return { ok: false, reason: "insufficient" };
      }
      const rows = await sql<StockCasRow[]>`
        UPDATE package_stock
        SET reserved = reserved - ${units},
            version = version + 1,
            updated_at = ${at}
        WHERE package_id = ${packageId}
          AND version = ${expectedVersion}
          AND reserved >= ${units}
        RETURNING version, available, reserved
      `;
      const row = firstRow(rows);
      if (row !== null) return applied(row);
      return classifyStockFailure(await observe(packageId), expectedVersion);
    },

    /**
     * Turn a reservation into a sale (§11: "A successful new-key order consumes one
     * stock unit for that size").
     *
     * Decrements BOTH counters: the unit leaves `available` because it is sold, and
     * leaves `reserved` because it is no longer merely held. Both guards are
     * required — either CHECK alone would abort the activation transaction.
     *
     * Called inside the activation transaction (§13 step 8), so a failure to commit
     * stock rolls back the key and the ledger row with it.
     */
    async commitStock(
      packageId: string,
      units: number,
      expectedVersion: number,
      at: Date,
    ): Promise<StockCasOutcome> {
      if (!Number.isInteger(units) || units < 1) {
        return { ok: false, reason: "insufficient" };
      }
      const rows = await sql<StockCasRow[]>`
        UPDATE package_stock
        SET available = available - ${units},
            reserved = reserved - ${units},
            version = version + 1,
            updated_at = ${at}
        WHERE package_id = ${packageId}
          AND version = ${expectedVersion}
          AND available >= ${units}
          AND reserved >= ${units}
        RETURNING version, available, reserved
      `;
      const row = firstRow(rows);
      if (row !== null) return applied(row);
      return classifyStockFailure(await observe(packageId), expectedVersion);
    },
  };
}

/** The LEFT JOIN columns in `listActiveWithStock`. Null when no stock row exists. */
type StockJoin = {
  stock_available: number | null;
  stock_reserved: number | null;
  stock_version: string | null;
  stock_updated_at: Date | null;
};
