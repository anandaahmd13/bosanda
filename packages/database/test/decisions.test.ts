/**
 * Tests for the pure decision layer.
 *
 * WHAT THESE TESTS DO AND DO NOT PROVE. There is no PostgreSQL here, so nothing
 * below proves that any SQL statement is correct — not the ON CONFLICT predicate, not
 * the CAS WHERE clause, not a constraint interaction. What they DO cover is every
 * rule that was deliberately extracted out of the SQL so it could be checked without
 * a database: the balance clamp, the CAS classification, the idempotency verdicts,
 * paging normalization, filter canonicalization, and the auth verdict ordering.
 *
 * The extraction is the point. `classifyStockFailure` exists as a separate function
 * precisely because "the UPDATE matched zero rows" is ambiguous, and the
 * disambiguation rule is worth testing even though the UPDATE itself is not.
 */

import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  auditFilterPredicates,
  canCommit,
  canRelease,
  canReserve,
  clampBalance,
  clampedOverage,
  classifyRotateFailure,
  classifyStockFailure,
  debitIsIdempotent,
  decideDebitOutcome,
  decideInsertOutcome,
  decideKeyAuth,
  normalizeAuditFilter,
  normalizeOrderFilter,
  normalizePagination,
  orderFilterPredicates,
  wasClamped,
} from "../src/repositories/decisions.js";

describe("balance clamp", () => {
  it("leaves a non-negative balance alone", () => {
    expect(clampBalance(0)).toBe(0);
    expect(clampBalance(1)).toBe(1);
    expect(clampBalance(10_000_000)).toBe(10_000_000);
  });

  it("floors a negative balance at zero, because balance_after CHECKs >= 0", () => {
    // §14 forbids a negative `balance_after` and `quota_remaining`, while §10 permits
    // bounded negative overage on the last request. The clamp is how those coexist.
    expect(clampBalance(-1)).toBe(0);
    expect(clampBalance(-5_000)).toBe(0);
  });

  it("reports whether the clamp actually discarded anything", () => {
    expect(wasClamped(0)).toBe(false);
    expect(wasClamped(1)).toBe(false);
    expect(wasClamped(-1)).toBe(true);
  });

  it("reports the hidden overage as a non-negative magnitude", () => {
    expect(clampedOverage(5)).toBe(0);
    expect(clampedOverage(0)).toBe(0);
    expect(clampedOverage(-250)).toBe(250);
  });

  it("keeps the overage derivable from the ledger delta", () => {
    // The invariant the clamp relies on: the ledger keeps the FULL debit in
    // `weighted_tokens_delta`, so the true balance is reconstructible even though the
    // cached column was floored.
    const previous = 100;
    const debit = 400;
    const trueBalance = previous - debit;

    expect(clampBalance(trueBalance)).toBe(0);
    expect(clampedOverage(trueBalance)).toBe(300);
    // previousBalance + delta recovers the true figure regardless of what was stored.
    expect(previous + -debit).toBe(trueBalance);
  });

  it("never lets a clamped balance permit a request the true balance would refuse", () => {
    // §10 rejects on `remaining <= 0`, so 0 and any negative are the same answer and
    // the clamp cannot widen access.
    for (const trueBalance of [-1, -1000, 0]) {
      expect(clampBalance(trueBalance) <= 0).toBe(true);
    }
  });
});

describe("debit idempotency", () => {
  it("requires a non-empty request id, since the unique index is partial", () => {
    expect(debitIsIdempotent("req_1")).toBe(true);
    expect(debitIsIdempotent("")).toBe(false);
    expect(debitIsIdempotent(null)).toBe(false);
  });

  it("reports a fresh insert as recorded, carrying the clamp flag", () => {
    const outcome = decideDebitOutcome({ id: "led_1" }, null, {
      apiKeyId: "key_1",
      requestId: "req_1",
      clamped: true,
    });

    expect(outcome.status).toBe("recorded");
    expect(outcome.entry).toEqual({ id: "led_1" });
    if (outcome.status === "recorded") expect(outcome.clamped).toBe(true);
  });

  it("reports a conflict as a duplicate and returns the pre-existing row", () => {
    // The retried-settle case: the worker crashed after committing and re-ran. §13
    // requires this to be a normal outcome, not an error.
    const outcome = decideDebitOutcome(
      null,
      { id: "led_original" },
      {
        apiKeyId: "key_1",
        requestId: "req_1",
        clamped: false,
      },
    );

    expect(outcome.status).toBe("duplicate");
    expect(outcome.entry).toEqual({ id: "led_original" });
  });

  it("prefers the inserted row when both are somehow present", () => {
    const outcome = decideDebitOutcome(
      { id: "fresh" },
      { id: "stale" },
      {
        apiKeyId: "key_1",
        requestId: "req_1",
        clamped: false,
      },
    );

    expect(outcome.entry).toEqual({ id: "fresh" });
  });

  it("throws when a conflict fired but no existing row was found", () => {
    // Impossible against a real index — the index is what caused the conflict — so
    // this means the query or the schema changed, and silence would hide it.
    expect(() =>
      decideDebitOutcome(null, null, {
        apiKeyId: "key_1",
        requestId: "req_1",
        clamped: false,
      }),
    ).toThrow(BosandaError);
  });
});

describe("usage-event insert outcome", () => {
  it("distinguishes inserted from duplicate", () => {
    expect(decideInsertOutcome({ id: "u1" }, null, "usage_events")).toEqual({
      status: "inserted",
      row: { id: "u1" },
    });
    expect(decideInsertOutcome(null, { id: "u0" }, "usage_events")).toEqual({
      status: "duplicate",
      row: { id: "u0" },
    });
  });

  it("throws on a conflict with no existing row", () => {
    expect(() => decideInsertOutcome(null, null, "usage_events")).toThrow(BosandaError);
  });
});

describe("stock CAS classification", () => {
  it("reports a missing stock row as missing, not as a conflict", () => {
    // An operator has not set stock for the size (§11 manual stock). Retrying will
    // never help, so it must not look like a race.
    expect(classifyStockFailure(null, 7)).toEqual({ ok: false, reason: "missing" });
  });

  it("reports a moved version as a retryable conflict", () => {
    expect(classifyStockFailure({ version: 8 }, 7)).toEqual({
      ok: false,
      reason: "version_conflict",
    });
  });

  it("reports an unchanged version as insufficient, because the guard rejected us", () => {
    // The row did not move, so the arithmetic guard in the WHERE is what failed.
    // Retrying would spin forever, which is why this reason is distinct.
    expect(classifyStockFailure({ version: 7 }, 7)).toEqual({
      ok: false,
      reason: "insufficient",
    });
  });

  it("is a returned outcome rather than a thrown error in every case", () => {
    // Explicitly asserted: the instruction is that a failed CAS must not throw, and
    // it would be easy to regress this into an exception during a refactor.
    for (const observed of [null, { version: 1 }, { version: 2 }]) {
      expect(() => classifyStockFailure(observed, 1)).not.toThrow();
    }
  });
});

describe("stock guards mirror the SQL predicates", () => {
  it("reserves against free stock, not against available", () => {
    // The subtle rule: one unit already held by a pending order is not available to
    // a second buyer.
    expect(canReserve({ available: 5, reserved: 4 }, 1)).toBe(true);
    expect(canReserve({ available: 5, reserved: 5 }, 1)).toBe(false);
    expect(canReserve({ available: 5, reserved: 0 }, 5)).toBe(true);
    expect(canReserve({ available: 5, reserved: 0 }, 6)).toBe(false);
  });

  it("releases only what is actually held", () => {
    expect(canRelease({ reserved: 2 }, 2)).toBe(true);
    expect(canRelease({ reserved: 1 }, 2)).toBe(false);
    expect(canRelease({ reserved: 0 }, 1)).toBe(false);
  });

  it("commits only when both counters can absorb the decrement", () => {
    expect(canCommit({ available: 3, reserved: 3 }, 3)).toBe(true);
    expect(canCommit({ available: 3, reserved: 2 }, 3)).toBe(false);
    expect(canCommit({ available: 2, reserved: 3 }, 3)).toBe(false);
  });

  it("rejects non-positive and fractional unit counts everywhere", () => {
    const stock = { available: 100, reserved: 50 };
    for (const units of [0, -1, 1.5, Number.NaN]) {
      expect(canReserve(stock, units)).toBe(false);
      expect(canRelease(stock, units)).toBe(false);
      expect(canCommit(stock, units)).toBe(false);
    }
  });
});

describe("credential rotation CAS classification", () => {
  it("reports a missing account with a null current version", () => {
    expect(classifyRotateFailure(null)).toEqual({
      ok: false,
      reason: "missing",
      currentVersion: null,
    });
  });

  it("reports a conflict and hands back the version that won", () => {
    // §6 single-flight refresh: the loser needs the winner's version so it can
    // re-read rather than overwrite a newer credential with an older one.
    expect(classifyRotateFailure({ credentialVersion: 12 })).toEqual({
      ok: false,
      reason: "version_conflict",
      currentVersion: 12,
    });
  });
});

describe("pagination normalization", () => {
  it("defaults an absent page", () => {
    expect(normalizePagination()).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
    expect(normalizePagination({})).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
  });

  it("clamps an oversized limit rather than rejecting it", () => {
    expect(normalizePagination({ limit: 10_000 }).limit).toBe(MAX_PAGE_SIZE);
    expect(normalizePagination({ limit: MAX_PAGE_SIZE }).limit).toBe(MAX_PAGE_SIZE);
  });

  it("falls back to the default for a nonsensical limit", () => {
    for (const limit of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizePagination({ limit }).limit).toBe(DEFAULT_PAGE_SIZE);
    }
  });

  it("keeps a valid offset and zeroes an invalid one", () => {
    expect(normalizePagination({ offset: 100 }).offset).toBe(100);
    for (const offset of [0, -1, 2.5, Number.NaN]) {
      expect(normalizePagination({ offset }).offset).toBe(0);
    }
  });

  it("does not cap the offset, so deep pages remain reachable", () => {
    expect(normalizePagination({ offset: 100_000 }).offset).toBe(100_000);
  });
});

describe("order filter normalization", () => {
  it("turns a blank search box into no constraint", () => {
    // The bug this prevents: `WHERE user_id = ''` silently returning nothing.
    const normalized = normalizeOrderFilter({ userId: "   ", provider: "" });
    expect(normalized.userId).toBeNull();
    expect(normalized.provider).toBeNull();
  });

  it("trims a supplied value", () => {
    expect(normalizeOrderFilter({ userId: "  01JQ  " }).userId).toBe("01JQ");
  });

  it("drops statuses outside the allowed set", () => {
    const allowed = ["paid", "activated"];
    expect(normalizeOrderFilter({ status: ["paid", "bogus"] }, allowed).statuses).toEqual(["paid"]);
  });

  it("allows any status when no allow-list is supplied", () => {
    expect(normalizeOrderFilter({ status: ["anything"] }).statuses).toEqual(["anything"]);
  });

  it("de-duplicates repeated statuses", () => {
    expect(normalizeOrderFilter({ status: ["paid", "paid"] }, ["paid"]).statuses).toEqual(["paid"]);
  });

  it("ignores an invalid Date instead of producing a NaN bound", () => {
    const normalized = normalizeOrderFilter({ createdAfter: new Date("not a date") });
    expect(normalized.createdAfter).toBeNull();
  });

  it("keeps a valid Date", () => {
    const after = new Date("2026-07-01T00:00:00.000Z");
    expect(normalizeOrderFilter({ createdAfter: after }).createdAfter).toBe(after);
  });

  it("lists exactly the predicates a filter implies", () => {
    // Guards against a filter field being silently dropped from the WHERE clause:
    // the repository builds its branches from these same keys.
    expect(orderFilterPredicates(normalizeOrderFilter({}))).toEqual([]);

    expect(
      orderFilterPredicates(
        normalizeOrderFilter({
          userId: "u1",
          status: ["paid"],
          type: "new_key",
          provider: "pakasir",
          providerTransactionId: "tx_1",
          createdAfter: new Date("2026-01-01T00:00:00.000Z"),
          createdBefore: new Date("2026-02-01T00:00:00.000Z"),
        }),
      ),
    ).toEqual([
      "user_id",
      "status",
      "type",
      "provider",
      "provider_transaction_id",
      "created_at >=",
      "created_at <",
    ]);
  });

  it("emits no predicate for a field that normalized away", () => {
    expect(orderFilterPredicates(normalizeOrderFilter({ userId: "  " }))).toEqual([]);
  });
});

describe("audit filter normalization", () => {
  it("blanks become no constraint", () => {
    const normalized = normalizeAuditFilter({ actorId: " ", action: "" });
    expect(normalized.actorId).toBeNull();
    expect(normalized.action).toBeNull();
  });

  it("lists exactly the predicates a filter implies", () => {
    expect(auditFilterPredicates(normalizeAuditFilter({}))).toEqual([]);
    expect(
      auditFilterPredicates(
        normalizeAuditFilter({
          actorType: "admin",
          actorId: "a1",
          action: "order.activated",
          targetType: "order",
          targetId: "o1",
          createdAfter: new Date("2026-01-01T00:00:00.000Z"),
          createdBefore: new Date("2026-02-01T00:00:00.000Z"),
        }),
      ),
    ).toEqual([
      "actor_type",
      "actor_id",
      "action",
      "target_type",
      "target_id",
      "created_at >=",
      "created_at <",
    ]);
  });
});

describe("key auth verdict", () => {
  it("accepts an active key owned by an active user", () => {
    expect(decideKeyAuth({ key: { status: "active" }, userStatus: "active" })).toEqual({
      ok: true,
    });
  });

  it("reports an unknown key", () => {
    expect(decideKeyAuth(null)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("reports revoked and expired keys distinctly", () => {
    expect(decideKeyAuth({ key: { status: "revoked" }, userStatus: "active" })).toEqual({
      ok: false,
      reason: "key_revoked",
    });
    expect(decideKeyAuth({ key: { status: "expired" }, userStatus: "active" })).toEqual({
      ok: false,
      reason: "key_expired",
    });
  });

  it("puts suspension ahead of key state, since §12 stops the account entirely", () => {
    // Ordering is load-bearing: a suspended user's revoked key must report
    // `user_suspended`, because that is the reason an operator has to act on.
    expect(decideKeyAuth({ key: { status: "revoked" }, userStatus: "suspended" })).toEqual({
      ok: false,
      reason: "user_suspended",
    });
    expect(decideKeyAuth({ key: { status: "active" }, userStatus: "suspended" })).toEqual({
      ok: false,
      reason: "user_suspended",
    });
  });

  it("does not decide quota — that stays in @bosanda/metering", () => {
    // An active key with no quota left still authenticates; `canStartRequest` is what
    // rejects it. Duplicating the rule here would give two places to change.
    expect(decideKeyAuth({ key: { status: "active" }, userStatus: "active" }).ok).toBe(true);
  });
});
