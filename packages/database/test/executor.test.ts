/**
 * Executor tests (PLAN.md §13 step 8, §16 invariant 5).
 *
 * `atomically` is the reason these tests exist. It dispatches on which handle it
 * was given — `savepoint` for a transaction, `begin` for the pool — and the
 * failure mode is not an exception, it is a SILENT LOSS OF ATOMICITY. If a future
 * edit "simplifies" it to always call `begin`, activation still appears to work
 * in every happy-path test while running outside the caller's transaction: the
 * order is marked paid, then the stock consume fails, and nothing rolls back.
 *
 * So the tests here assert WHICH driver method was called, not just that the
 * callback ran. `isTransaction`'s `savepoint` probe is likewise pinned against
 * the shape `postgres@3.4.9` actually produces (a transaction handle has
 * `savepoint` and NO `begin`), because that asymmetry is the whole basis of the
 * dispatch and it is not obvious from the shared `ISql` type.
 *
 * No live database is needed: every handle here is a fake that records calls.
 * A real-database test would cover more but would not cover this — the dispatch
 * question is about which method exists, and both handles work at runtime.
 */

import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import type { Sql } from "../src/client.js";
import {
  atomically,
  firstRow,
  isTransaction,
  jsonParam,
  requireRow,
  withTransaction,
  type Executor,
  type Tx,
} from "../src/repositories/executor.js";

/**
 * A fake pool handle: `begin` and no `savepoint`, matching the driver's top-level
 * object. Records each call so a test can assert which path ran.
 */
function fakePool(): { handle: Executor; calls: string[] } {
  const calls: string[] = [];
  const handle = {
    calls,
    async begin<T>(cb: (tx: Tx) => Promise<T>): Promise<T> {
      calls.push("begin");
      return cb(fakeTx().handle as unknown as Tx);
    },
  };
  return { handle: handle as unknown as Executor, calls };
}

/**
 * A fake transaction handle: `savepoint` and NO `begin`, matching what
 * `postgres@3.4.9` hands to a `begin` callback. The absent `begin` is the point —
 * calling it would be a TypeError, which is what `atomically` avoids.
 */
function fakeTx(): { handle: Executor; calls: string[] } {
  const calls: string[] = [];
  const handle = {
    calls,
    async savepoint<T>(cb: (tx: Tx) => Promise<T>): Promise<T> {
      calls.push("savepoint");
      return cb(handle as unknown as Tx);
    },
    async prepare() {
      /* present on real transaction handles; unused here */
    },
  };
  return { handle: handle as unknown as Executor, calls };
}

describe("isTransaction", () => {
  it("identifies a transaction handle by its savepoint method", () => {
    expect(isTransaction(fakeTx().handle)).toBe(true);
  });

  it("identifies the pool as not a transaction", () => {
    expect(isTransaction(fakePool().handle)).toBe(false);
  });

  it("does not treat a non-function savepoint property as a transaction", () => {
    // A row object carrying a `savepoint` column must not be mistaken for a handle.
    const impostor = { savepoint: "a string" } as unknown as Executor;
    expect(isTransaction(impostor)).toBe(false);
  });

  it("returns false for a bare object", () => {
    expect(isTransaction({} as unknown as Executor)).toBe(false);
  });
});

describe("atomically — dispatch (§16 invariant 5)", () => {
  it("uses begin on the pool, opening a real transaction", () => {
    const pool = fakePool();
    return atomically(pool.handle, async () => "done").then((result) => {
      expect(result).toBe("done");
      expect(pool.calls).toEqual(["begin"]);
    });
  });

  it("uses savepoint on a transaction, so the caller still gets ONE commit", async () => {
    // The failure this guards: calling begin here would either throw or start a
    // second transaction, splitting activation across two commits.
    const tx = fakeTx();
    await atomically(tx.handle, async () => "done");
    expect(tx.calls).toEqual(["savepoint"]);
  });

  it("prefers savepoint when a handle somehow exposes both", () => {
    // Defensive ordering with a reason: if the driver ever attaches `begin` to a
    // transaction handle, nesting a savepoint is correct and nesting a
    // transaction is not.
    const calls: string[] = [];
    const both = {
      async savepoint<T>(cb: (tx: Tx) => Promise<T>) {
        calls.push("savepoint");
        return cb(both as unknown as Tx);
      },
      async begin<T>(cb: (tx: Tx) => Promise<T>) {
        calls.push("begin");
        return cb(both as unknown as Tx);
      },
    } as unknown as Executor;
    return atomically(both, async () => 1).then(() => {
      expect(calls).toEqual(["savepoint"]);
    });
  });

  it("passes the inner handle to the callback, not the outer one", async () => {
    // The callback must run against the transaction, otherwise its statements
    // execute outside the atomic unit it was promised.
    const pool = fakePool();
    let received: Executor | undefined;
    await atomically(pool.handle, async (executor) => {
      received = executor;
      return 0;
    });
    expect(received).toBeDefined();
    expect(isTransaction(received!)).toBe(true);
  });

  it("returns the callback's value unchanged", async () => {
    const value = { orderId: "ord_1", nested: [1, 2, 3] };
    await expect(atomically(fakePool().handle, async () => value)).resolves.toBe(value);
  });

  it("propagates a throw so the driver rolls back", async () => {
    // Swallowing here would commit a partial activation.
    const failure = new Error("stock consume failed");
    await expect(
      atomically(fakePool().handle, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("propagates a throw from inside a savepoint too", async () => {
    const failure = new BosandaError("conflict", { internalDetail: "version race" });
    await expect(
      atomically(fakeTx().handle, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("raises internal_error rather than silently skipping the transaction", async () => {
    // A handle with neither method means a wiring mistake. Running `fn` anyway
    // would drop atomicity while every test still passed.
    const useless = {} as unknown as Executor;
    let ran = false;
    try {
      await atomically(useless, async () => {
        ran = true;
        return 0;
      });
      expect.unreachable("expected internal_error");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      expect((error as BosandaError).code).toBe("internal_error");
      expect((error as BosandaError).status).toBe(500);
    }
    expect(ran, "callback must not run without atomicity").toBe(false);
  });

  it("nests: a savepoint inside a transaction inside the pool", async () => {
    // What a repository method that calls atomically() does when its caller
    // already opened a transaction via withTransaction.
    const order: string[] = [];
    const inner = {
      async savepoint<T>(cb: (tx: Tx) => Promise<T>) {
        order.push("savepoint");
        return cb(inner as unknown as Tx);
      },
    } as unknown as Executor;
    const outer = {
      async begin<T>(cb: (tx: Tx) => Promise<T>) {
        order.push("begin");
        return cb(inner as unknown as Tx);
      },
    } as unknown as Executor;

    await atomically(outer, async (executor) => atomically(executor, async () => "ok"));
    expect(order).toEqual(["begin", "savepoint"]);
  });
});

describe("withTransaction", () => {
  it("delegates to the driver's begin and returns the result", async () => {
    const pool = fakePool();
    const result = await withTransaction(pool.handle as unknown as Sql, async () => 42);
    expect(result).toBe(42);
    expect(pool.calls).toEqual(["begin"]);
  });

  it("hands the callback a transaction handle", async () => {
    const pool = fakePool();
    let isTx = false;
    await withTransaction(pool.handle as unknown as Sql, async (tx) => {
      isTx = isTransaction(tx);
      return 0;
    });
    expect(isTx).toBe(true);
  });

  it("propagates a throw for rollback", async () => {
    const pool = fakePool();
    await expect(
      withTransaction(pool.handle as unknown as Sql, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("returns an array result without unwrapping it", async () => {
    // The driver's UnwrapPromiseArray<T> is why this wrapper carries a cast; an
    // array return is the case that cast is about.
    const rows = [{ id: "a" }, { id: "b" }];
    await expect(
      withTransaction(fakePool().handle as unknown as Sql, async () => rows),
    ).resolves.toEqual(rows);
  });
});

describe("jsonParam", () => {
  it("passes plain JSON values through unchanged", () => {
    for (const value of [
      {},
      { actor: "admin", count: 3 },
      { nested: { deep: [1, "two", null, true] } },
      [],
      [1, 2, 3],
      null,
      "text",
      42,
      true,
    ]) {
      expect(jsonParam(value, "test"), JSON.stringify(value)).toBe(value);
    }
  });

  it("accepts a Date, which the driver serializes itself", () => {
    const at = new Date("2026-07-31T12:00:00.000Z");
    expect(jsonParam({ at }, "test")).toEqual({ at });
  });

  it("rejects a bigint rather than writing a mangled row", () => {
    // JSON.stringify THROWS on bigint. Casting past the type would surface as a
    // failed query at best and a wrong audit row at worst.
    expect(() => jsonParam({ tokens: 10n }, "audit_events.metadata")).toThrow(BosandaError);
  });

  it("names the column in the failure, without the value", () => {
    try {
      jsonParam({ tokens: 10n }, "audit_events.metadata");
      expect.unreachable("expected internal_error");
    } catch (error) {
      const bosanda = error as BosandaError;
      expect(bosanda.code).toBe("internal_error");
      expect(bosanda.internalDetail).toContain("audit_events.metadata");
    }
  });

  it("rejects a circular structure", () => {
    const circular: Record<string, unknown> = { name: "flag" };
    circular.self = circular;
    expect(() => jsonParam(circular, "feature_flags.value")).toThrow(BosandaError);
  });

  it("allows a symbol-valued key, matching what JSON.stringify does", () => {
    // Documented rather than guarded: JSON.stringify silently DROPS these, and
    // rejecting them would break callers passing ordinary objects that happen to
    // carry a symbol. The bigint case throws, so it is the one worth catching.
    const value = { real: 1, [Symbol("hidden")]: 2 };
    expect(jsonParam(value, "test")).toBe(value);
  });

  it("preserves undefined properties for the driver to drop", () => {
    const value = { present: 1, missing: undefined };
    expect(jsonParam(value, "test")).toBe(value);
  });
});

describe("firstRow", () => {
  it("returns the first row", () => {
    expect(firstRow([{ id: "a" }, { id: "b" }])).toEqual({ id: "a" });
  });

  it("returns null for no rows", () => {
    expect(firstRow([])).toBeNull();
  });

  it("returns null, not undefined, so a caller's === null check works", () => {
    // The whole reason this helper exists under noUncheckedIndexedAccess.
    expect(firstRow([])).not.toBeUndefined();
  });

  it("preserves a falsy first row instead of collapsing it to null", () => {
    // `rows[0] ?? null` and `rows[0] || null` differ exactly here.
    expect(firstRow([0])).toBe(0);
    expect(firstRow([""])).toBe("");
    expect(firstRow([false])).toBe(false);
  });

  it("returns null for an explicit null row", () => {
    expect(firstRow([null])).toBeNull();
  });
});

describe("requireRow", () => {
  it("returns the first row when present", () => {
    expect(requireRow([{ id: "a" }], "order")).toEqual({ id: "a" });
  });

  it("raises internal_error, not not_found, for a missing row", () => {
    // A statement whose shape guarantees a row returning none means the query
    // changed. Reporting not_found would blame the caller and return a 404 for a
    // Bosanda-side bug.
    try {
      requireRow([], "activation insert");
      expect.unreachable("expected internal_error");
    } catch (error) {
      expect((error as BosandaError).code).toBe("internal_error");
      expect((error as BosandaError).internalDetail).toContain("activation insert");
    }
  });

  it("preserves a falsy first row", () => {
    expect(requireRow([0], "count")).toBe(0);
  });

  it("raises for an explicit undefined row", () => {
    expect(() => requireRow([undefined], "row")).toThrow(BosandaError);
  });

  it("does not raise for an explicit null row", () => {
    // null is a value the database can legitimately return; undefined is absence.
    expect(requireRow([null], "row")).toBeNull();
  });
});
