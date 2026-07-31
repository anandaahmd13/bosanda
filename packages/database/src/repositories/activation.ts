/**
 * The activation transaction (PLAN.md §13 "Checkout" step 8, §16 invariant 5).
 *
 * ONE COMMIT, or nothing. §13 step 8 lists what has to land together when an order
 * activates:
 *
 *   1. the order moves `paid → activated`
 *   2. the stock unit is committed (new-key orders only)
 *   3. the key is created, or the existing key's limit and expiry are extended
 *   4. a `grant` / `top_up` ledger row is written and the balance moves
 *   5. an `audit_events` row records it
 *
 * If any step fails, none may persist. A committed order with no key is a customer
 * who paid for nothing; a key with no ledger row is a balance that cannot be
 * explained (§10). So this is the second of the two places in this package that opens
 * its own transaction — `quotaRepository.recordDebit` being the other — and for the
 * same reason: atomicity is the function's entire purpose, not an implementation
 * detail.
 *
 * `atomically` is used rather than `withTransaction`, so a caller who is ALREADY in a
 * transaction (the webhook handler, which locks the order first) gets a savepoint and
 * one commit, not a nested-begin TypeError.
 *
 * ── WHY THE GRANT IS AN ARGUMENT ───────────────────────────────────────────
 * `decideActivation` in `@bosanda/payments` decides new-key-versus-top-up, computes the
 * validity window from the confirmed-payment instant, and applies §11's cap. It is
 * PURE, and `@bosanda/database` deliberately does not depend on `@bosanda/payments`:
 * that would point the dependency arrow from storage at policy, and `payments` already
 * depends on `metering` and `api-keys`. So the caller decides and passes the
 * `ActivationGrant`; this function executes it. That is the same decide/execute split
 * `@bosanda/metering` and `@bosanda/payments` already use.
 *
 * The grant type is mirrored structurally below rather than imported, which means a
 * change to `NewKeyGrant`/`TopUpGrant` in `@bosanda/payments` will NOT be caught here
 * by the compiler. `assertGrantShape` exists to make that gap loud at runtime instead
 * of silently writing a half-populated row.
 *
 * ── WHAT THIS FUNCTION DOES NOT DO ─────────────────────────────────────────
 *   * It does not decide. Pass the output of `decideActivation`; a `review` decision
 *     must go to `ordersRepository.markReviewRequired`, not here.
 *   * It does not generate, hash, or seal a key. `@bosanda/api-keys` owns that, and no
 *     plaintext key value reaches this file (§12, §16). The caller passes the
 *     `lookupDigest` and the sealed `encryptedKey`; both are opaque strings here.
 *   * It does not read the target key's state. `decideActivation` was given that state,
 *     read under the row lock the caller holds (§16 invariant 5), and the numbers in
 *     the grant are what commit.
 *   * It does not verify the payment amount. §13 does that against the frozen
 *     `package_snapshot` before the order is marked paid.
 */

import { BosandaError } from "@bosanda/protocol";
import type { Executor } from "./executor.js";
import { atomically } from "./executor.js";
import { apiKeysRepository } from "./api-keys.js";
import { auditRepository } from "./audit.js";
import { ordersRepository } from "./orders.js";
import { packagesRepository } from "./packages.js";
import { quotaRepository } from "./quota.js";
import type { ApiKey, Order, QuotaLedgerEntry } from "./rows.js";
import type { StockCasOutcome } from "./decisions.js";

/** Structurally `NewKeyGrant` from `@bosanda/payments`. */
export type NewKeyGrantInput = {
  readonly kind: "new_key";
  readonly userId: string;
  readonly orderId: string;
  readonly quota: number;
  readonly quotaLimit: number;
  readonly expiresAt: Date;
};

/** Structurally `TopUpGrant` from `@bosanda/payments`. */
export type TopUpGrantInput = {
  readonly kind: "top_up";
  readonly userId: string;
  readonly orderId: string;
  readonly apiKeyId: string;
  readonly purchased: number;
  readonly remainingAfter: number;
  readonly quotaLimitAfter: number;
  readonly expiresAt: Date;
};

export type ActivationGrantInput = NewKeyGrantInput | TopUpGrantInput;

/**
 * The key material a new-key activation needs, all of it already derived by
 * `@bosanda/api-keys`. Absent for a top-up, which reuses the existing key row.
 */
export type NewKeyMaterial = {
  /** ULID for the new `api_keys` row. */
  readonly id: string;
  readonly label: string | null;
  /** Display prefix, e.g. "bsk_live_ab12". Not secret. */
  readonly prefix: string;
  /** From `lookupDigest()`. The only value authentication looks up. */
  readonly lookupDigest: string;
  /** From `seal()`. Ciphertext; never logged (§12). */
  readonly encryptedKey: string;
  readonly encryptionKeyVersion: number;
};

/** The stock unit to consume. Omit to skip the stock step — see `ExecuteActivationInput`. */
export type StockCommit = {
  readonly packageId: string;
  readonly units: number;
  /** `PackageStock.version` read in this transaction. CAS guard (§14 optimistic concurrency). */
  readonly expectedVersion: number;
};

export type ExecuteActivationInput = {
  /** From `decideActivation(...).grant`. */
  readonly grant: ActivationGrantInput;
  /** ULID for the ledger row. */
  readonly ledgerEntryId: string;
  /** ULID for the audit row. */
  readonly auditEventId: string;
  /** `@bosanda/metering`'s `METER_VERSION`, recorded on the ledger row (§10). */
  readonly meterVersion: string;
  /** Required for `new_key`, must be absent for `top_up`. */
  readonly keyMaterial?: NewKeyMaterial;
  /**
   * Stock to commit. §11 consumes a unit only for a NEW key, so a top-up must not
   * pass this. A new-key order for a package with no stock row may also omit it —
   * `listActiveWithStock` reports stock as absent — but that is an admin
   * misconfiguration, so `requireStock` below defaults to demanding it.
   */
  readonly stock?: StockCommit;
  /** The instant the activation is recorded at. UTC. */
  readonly at: Date;
};

/**
 * Why an activation did not happen.
 *
 * Every one of these is a genuine state disagreement, which §13 routes to
 * `review_required` rather than fixing silently. The caller decides that; this
 * function only reports which disagreement it hit, having rolled back.
 */
export type ActivationFailureReason =
  /** The order was not `paid`, or was already activated. Includes the retry case. */
  | "order_not_activatable"
  /** The stock CAS lost — the row moved, or there were not enough units. */
  | "stock_conflict"
  /** The top-up target was not active, or its limit could not be raised. */
  | "key_not_topupable";

export type ActivationOutcome =
  | {
      readonly ok: true;
      readonly order: Order;
      readonly apiKey: ApiKey;
      readonly ledgerEntry: QuotaLedgerEntry;
      /** Absent when no stock step ran. */
      readonly stock?: StockCasOutcome;
    }
  | {
      readonly ok: false;
      readonly reason: ActivationFailureReason;
      /** Operator-facing detail. Safe to log; contains ids only, never key material. */
      readonly detail: string;
      /** Present for `stock_conflict`, carrying the CAS classification. */
      readonly stock?: StockCasOutcome;
    };

/**
 * Guard the mirrored grant shape at runtime.
 *
 * The types above are structural copies of `@bosanda/payments`, so the compiler cannot
 * catch a drift across the package boundary. A grant missing a field would otherwise
 * become a NULL in a NOT NULL column or a NaN in a BIGINT, and the error would surface
 * as an opaque constraint violation. Failing here names the field instead.
 */
function assertGrantShape(grant: ActivationGrantInput): void {
  const bad = (detail: string): never => {
    throw new BosandaError("internal_error", {
      internalDetail: `activation grant for order ${grant.orderId} ${detail}`,
    });
  };

  if (grant.userId.length === 0) bad("has an empty userId");
  if (grant.orderId.length === 0) bad("has an empty orderId");
  if (!Number.isFinite(grant.expiresAt.getTime())) bad("has an invalid expiresAt");

  if (grant.kind === "new_key") {
    if (!Number.isInteger(grant.quota) || grant.quota <= 0) {
      bad(`has a non-positive-integer quota ${String(grant.quota)}`);
    }
    if (!Number.isInteger(grant.quotaLimit) || grant.quotaLimit < grant.quota) {
      bad(`has quotaLimit ${String(grant.quotaLimit)} below quota ${String(grant.quota)}`);
    }
    return;
  }

  if (grant.apiKeyId.length === 0) bad("is a top_up with no apiKeyId");
  if (!Number.isInteger(grant.purchased) || grant.purchased <= 0) {
    bad(`has a non-positive-integer purchased ${String(grant.purchased)}`);
  }
  if (!Number.isInteger(grant.remainingAfter) || grant.remainingAfter < 0) {
    bad(`has an invalid remainingAfter ${String(grant.remainingAfter)}`);
  }
  if (!Number.isInteger(grant.quotaLimitAfter) || grant.quotaLimitAfter < grant.remainingAfter) {
    bad(
      `has quotaLimitAfter ${String(grant.quotaLimitAfter)} below remainingAfter ${String(grant.remainingAfter)}`,
    );
  }
}

/**
 * Execute a decided activation in one transaction (§13 step 8).
 *
 * Returns an OUTCOME for state disagreements — an order that is no longer `paid`, a
 * lost stock CAS, a key that is no longer active — because those are expected under
 * concurrency and retry, and §13 wants them routed to review, not thrown past the
 * handler. It THROWS `BosandaError` only for programming errors: a malformed grant, a
 * `new_key` grant with no key material, a `top_up` grant carrying stock.
 *
 * IDEMPOTENCY, stated precisely. This function is idempotent at the ORDER level and
 * not below it. The `paid → activated` transition is guarded on `status = 'paid' AND
 * activated_at IS NULL`, so a second call for the same order fails that guard first,
 * rolls back, and returns `order_not_activatable` before any key is created or any
 * quota is granted. That guard is the whole idempotency mechanism, which is why the
 * order transition is step ONE and not step five. A retry after a genuine commit is
 * therefore safe, but it is NOT a way to look up the key that was created — read the
 * order's key through `apiKeysRepository` for that.
 *
 * USAGE:
 *
 *   const decision = decideActivation(toOrderSnapshot(order), targetKeyState, clock);
 *   if (!decision.activate) {
 *     if (decision.review) await ordersRepository(tx).markReviewRequired(id, detail, now);
 *     return;
 *   }
 *   const outcome = await executeActivation(tx, {
 *     grant: decision.grant,
 *     ledgerEntryId: ulid(),
 *     auditEventId: ulid(),
 *     meterVersion: METER_VERSION,
 *     keyMaterial: decision.grant.kind === "new_key" ? material : undefined,
 *     stock: decision.grant.kind === "new_key" ? { packageId, units: 1, expectedVersion } : undefined,
 *     at: now,
 *   });
 */
export async function executeActivation(
  executor: Executor,
  input: ExecuteActivationInput,
): Promise<ActivationOutcome> {
  const { grant, at } = input;
  assertGrantShape(grant);

  if (grant.kind === "new_key" && input.keyMaterial === undefined) {
    throw new BosandaError("internal_error", {
      internalDetail: `new_key activation for order ${grant.orderId} has no key material`,
    });
  }
  if (grant.kind === "top_up" && input.keyMaterial !== undefined) {
    // Silently ignoring it would mean creating a second key for a top-up order.
    throw new BosandaError("internal_error", {
      internalDetail: `top_up activation for order ${grant.orderId} was given key material`,
    });
  }
  if (grant.kind === "top_up" && input.stock !== undefined) {
    // §11 consumes stock for a new key only; a top-up committing a unit would leak
    // inventory on every credit.
    throw new BosandaError("internal_error", {
      internalDetail: `top_up activation for order ${grant.orderId} must not commit stock`,
    });
  }

  // The return type is annotated rather than inferred: without it, the object
  // literals below widen `ok: false` to `boolean` and the union stops matching.
  return atomically<ActivationOutcome>(executor, async (tx): Promise<ActivationOutcome> => {
    const orders = ordersRepository(tx);
    const keys = apiKeysRepository(tx);
    const quota = quotaRepository(tx);
    const packages = packagesRepository(tx);
    const audit = auditRepository(tx);

    // STEP 1, and it is first on purpose: this guarded UPDATE is the idempotency
    // barrier for everything below it (see the note above).
    const order = await orders.markActivated(grant.orderId, at);
    if (order === null) {
      return {
        ok: false,
        reason: "order_not_activatable",
        detail: `order ${grant.orderId} is not paid, or was already activated`,
      };
    }

    // STEP 2: stock. Before the key, so a lost CAS costs nothing already written.
    let stockOutcome: StockCasOutcome | undefined;
    if (input.stock !== undefined) {
      const { packageId, units, expectedVersion } = input.stock;
      stockOutcome = await packages.commitStock(packageId, units, expectedVersion, at);
      if (!stockOutcome.ok) {
        // Returning rather than throwing still rolls back: `atomically` commits only
        // on a resolved callback, and the guarded UPDATE above is part of the same
        // transaction — but a resolved callback DOES commit, so the rollback has to be
        // forced explicitly. That is what the throw-and-catch below is for.
        throw new ActivationRollback({
          ok: false,
          reason: "stock_conflict",
          detail: `stock CAS for package ${packageId} failed: ${stockOutcome.reason}`,
          stock: stockOutcome,
        });
      }
    }

    // STEPS 3 and 4: the key, then the ledger row and the balance.
    let apiKey: ApiKey;
    let ledgerEntry: QuotaLedgerEntry;

    if (grant.kind === "new_key") {
      const material = input.keyMaterial;
      if (material === undefined) {
        // Already checked above; narrowing for `noUncheckedIndexedAccess`-strict TS
        // without a non-null assertion, which ESLint bans outside tests.
        throw new BosandaError("internal_error", {
          internalDetail: `new_key activation for order ${grant.orderId} lost its key material`,
        });
      }

      apiKey = await keys.insert({
        id: material.id,
        userId: grant.userId,
        label: material.label,
        prefix: material.prefix,
        lookupDigest: material.lookupDigest,
        encryptedKey: material.encryptedKey,
        encryptionKeyVersion: material.encryptionKeyVersion,
        quotaLimit: grant.quotaLimit,
        quotaRemaining: grant.quota,
        expiresAt: grant.expiresAt,
        createdAt: at,
      });

      // `recordGrant` writes the ledger row only: `insert` above already set
      // `quota_remaining`, so writing the balance again here would be a redundant
      // UPDATE of the same value.
      ledgerEntry = await quota.recordGrant({
        id: input.ledgerEntryId,
        apiKeyId: apiKey.id,
        orderId: grant.orderId,
        weightedTokens: grant.quota,
        remainingAfter: grant.quota,
        meterVersion: input.meterVersion,
        createdAt: at,
      });
    } else {
      // The limit MUST be raised before the balance is credited:
      // `api_keys_remaining_within_limit` is checked at the end of each statement.
      const extended = await keys.applyTopUpWindow(
        grant.apiKeyId,
        grant.quotaLimitAfter,
        grant.expiresAt,
      );
      if (extended === null) {
        throw new ActivationRollback({
          ok: false,
          reason: "key_not_topupable",
          detail: `key ${grant.apiKeyId} is not active, or its limit could not be raised to ${String(grant.quotaLimitAfter)}`,
        });
      }

      // Writes the ledger row AND the balance in one transaction (§10).
      ledgerEntry = await quota.recordTopUp({
        id: input.ledgerEntryId,
        apiKeyId: grant.apiKeyId,
        orderId: grant.orderId,
        weightedTokens: grant.purchased,
        remainingAfter: grant.remainingAfter,
        meterVersion: input.meterVersion,
        createdAt: at,
      });

      // Re-read so the returned key reflects the credited balance rather than the
      // pre-credit row `applyTopUpWindow` returned.
      const refreshed = await keys.findById(grant.apiKeyId);
      apiKey = refreshed ?? extended;
    }

    // STEP 5: audit (§15). Ids and integers only — no key material, no prompt content
    // (§16). `assertMetadataIsSafe` in `auditRepository` enforces the blocklist.
    await audit.append({
      id: input.auditEventId,
      actorType: "system",
      actorId: null,
      action: grant.kind === "new_key" ? "order.activated_new_key" : "order.activated_top_up",
      targetType: "order",
      targetId: grant.orderId,
      metadata: {
        userId: grant.userId,
        apiKeyId: apiKey.id,
        ledgerEntryId: ledgerEntry.id,
        weightedTokens: grant.kind === "new_key" ? grant.quota : grant.purchased,
        expiresAt: grant.expiresAt.toISOString(),
        ...(input.stock === undefined
          ? {}
          : { packageId: input.stock.packageId, stockUnits: input.stock.units }),
      },
      createdAt: at,
    });

    return stockOutcome === undefined
      ? { ok: true, order, apiKey, ledgerEntry }
      : { ok: true, order, apiKey, ledgerEntry, stock: stockOutcome };
  }).catch((error: unknown) => {
    // A returned failure would COMMIT the transaction — `atomically` resolves the
    // callback and the driver commits. So a mid-transaction disagreement is thrown to
    // force the rollback, then converted back into an outcome here. The alternative
    // (returning a failure and hoping nothing was written) would leave an order marked
    // `activated` with no key behind it, which is the one state §13 must never produce.
    if (error instanceof ActivationRollback) return error.outcome;
    throw error;
  });
}

/**
 * Internal signal: roll the transaction back, then report this outcome.
 *
 * Not exported and never surfaced to a caller — `executeActivation` unwraps it into an
 * `ActivationOutcome`. It exists because the driver's commit-on-resolve semantics mean
 * a rollback can only be requested by throwing.
 */
class ActivationRollback extends Error {
  readonly outcome: Extract<ActivationOutcome, { ok: false }>;

  constructor(outcome: Extract<ActivationOutcome, { ok: false }>) {
    super(outcome.detail);
    this.name = "ActivationRollback";
    this.outcome = outcome;
  }
}
