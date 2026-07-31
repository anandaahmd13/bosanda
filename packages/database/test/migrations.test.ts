import { describe, expect, it } from "vitest";
import { fixedClock } from "@bosanda/shared";
import { BosandaError } from "@bosanda/protocol";
import { checksumOf, migrate, planMigrations, type Migration } from "../src/migrations.js";
import { fakeStore } from "./fake-store.js";

const clock = fixedClock("2026-01-15T08:30:00.000Z");

function m(id: string, sql = `-- ${id}\nSELECT 1;`): Migration {
  return { id, sql };
}

function appliedRow(migration: Migration, at = clock.now()) {
  return { id: migration.id, checksum: checksumOf(migration.sql), appliedAt: at };
}

describe("checksumOf", () => {
  it("is stable across calls", () => {
    expect(checksumOf("CREATE TABLE t ();")).toBe(checksumOf("CREATE TABLE t ();"));
  });

  it("changes when a single character changes", () => {
    expect(checksumOf("SELECT 1;")).not.toBe(checksumOf("SELECT 2;"));
  });

  it("is sensitive to whitespace, because Postgres is not always", () => {
    // Reformatting a released migration still counts as modifying it.
    expect(checksumOf("SELECT 1;")).not.toBe(checksumOf("SELECT  1;"));
  });

  it("produces a 64-char hex digest", () => {
    expect(checksumOf("SELECT 1;")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("planMigrations", () => {
  it("treats everything as pending against an empty database", () => {
    const plan = planMigrations([m("0002_b"), m("0001_a")], []);
    expect(plan.pending.map((p) => p.id)).toEqual(["0001_a", "0002_b"]);
    expect(plan.alreadyApplied).toEqual([]);
  });

  it("orders pending migrations by id regardless of input order", () => {
    const plan = planMigrations([m("0010_j"), m("0002_b"), m("0001_a")], []);
    expect(plan.pending.map((p) => p.id)).toEqual(["0001_a", "0002_b", "0010_j"]);
  });

  it("returns nothing pending when history matches disk", () => {
    const first = m("0001_a");
    const plan = planMigrations([first], [appliedRow(first)]);
    expect(plan.pending).toEqual([]);
    expect(plan.alreadyApplied).toEqual(["0001_a"]);
  });

  it("plans only the migrations not yet applied", () => {
    const first = m("0001_a");
    const plan = planMigrations([first, m("0002_b")], [appliedRow(first)]);
    expect(plan.pending.map((p) => p.id)).toEqual(["0002_b"]);
  });

  it("refuses a migration whose contents changed after being applied", () => {
    const original = m("0001_a", "CREATE TABLE t (id INT);");
    const edited = m("0001_a", "CREATE TABLE t (id BIGINT);");

    expect(() => planMigrations([edited], [appliedRow(original)])).toThrowError(
      /was modified after being applied/,
    );
  });

  it("names both checksums so an operator can tell which side drifted", () => {
    const original = m("0001_a", "CREATE TABLE t (id INT);");
    const edited = m("0001_a", "CREATE TABLE t (id BIGINT);");

    try {
      planMigrations([edited], [appliedRow(original)]);
      expect.unreachable("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      const detail = (error as BosandaError).internalDetail ?? "";
      expect(detail).toContain(checksumOf(original.sql).slice(0, 12));
      expect(detail).toContain(checksumOf(edited.sql).slice(0, 12));
      expect(detail).toContain("add a new migration instead");
    }
  });

  it("refuses when a recorded migration is missing from disk", () => {
    // Deleting a released migration makes the schema unreproducible.
    expect(() => planMigrations([], [appliedRow(m("0001_a"))])).toThrowError(
      /recorded as applied but no longer exists on disk/,
    );
  });

  it("refuses a new migration inserted before one already applied", () => {
    const second = m("0002_b");
    expect(() => planMigrations([m("0001_a"), second], [appliedRow(second)])).toThrowError(
      /sorts before already-applied/,
    );
  });

  it("allows a migration appended after the highest applied id", () => {
    const second = m("0002_b");
    const plan = planMigrations([second, m("0003_c")], [appliedRow(second)]);
    expect(plan.pending.map((p) => p.id)).toEqual(["0003_c"]);
  });

  it("refuses duplicate ids", () => {
    expect(() => planMigrations([m("0001_a"), m("0001_a", "SELECT 2;")], [])).toThrowError(
      /duplicate migration id 0001_a/,
    );
  });

  it("raises internal_error, not a bare Error", () => {
    try {
      planMigrations([], [appliedRow(m("0001_a"))]);
      expect.unreachable("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      expect((error as BosandaError).code).toBe("internal_error");
    }
  });
});

describe("migrate", () => {
  it("creates the registry before reading history", async () => {
    const store = fakeStore();
    await migrate(store, [m("0001_a")], clock);
    expect(store.ensureRegistryCalls).toBe(1);
  });

  it("applies pending migrations in id order", async () => {
    const store = fakeStore();
    const result = await migrate(store, [m("0003_c"), m("0001_a"), m("0002_b")], clock);

    expect(result.applied).toEqual(["0001_a", "0002_b", "0003_c"]);
    expect(store.applied.map((row) => row.id)).toEqual(["0001_a", "0002_b", "0003_c"]);
  });

  it("records the checksum of what it applied", async () => {
    const store = fakeStore();
    const only = m("0001_a", "CREATE TABLE t ();");
    await migrate(store, [only], clock);

    expect(store.applied[0]?.checksum).toBe(checksumOf(only.sql));
  });

  it("stamps applied_at from the injected clock", async () => {
    const store = fakeStore();
    await migrate(store, [m("0001_a")], clock);
    expect(store.applied[0]?.appliedAt.toISOString()).toBe("2026-01-15T08:30:00.000Z");
  });

  it("is a no-op on a second run", async () => {
    const store = fakeStore();
    const available = [m("0001_a"), m("0002_b")];

    await migrate(store, available, clock);
    const second = await migrate(store, available, clock);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["0001_a", "0002_b"]);
    expect(store.appliedSql).toHaveLength(2);
  });

  it("applies only the newly added migration on a later run", async () => {
    const store = fakeStore();
    await migrate(store, [m("0001_a")], clock);
    const second = await migrate(store, [m("0001_a"), m("0002_b")], clock);

    expect(second.applied).toEqual(["0002_b"]);
  });

  it("stops at the first failure and leaves later migrations unapplied", async () => {
    const store = fakeStore();
    store.failNextApply(new Error("syntax error at or near )"));

    await expect(migrate(store, [m("0001_a"), m("0002_b")], clock)).rejects.toThrow(/syntax error/);

    // 0002 must not run: it may depend on tables 0001 was meant to create.
    expect(store.applied).toEqual([]);
    expect(store.appliedSql).toEqual([]);
  });

  it("refuses to apply anything when history is already inconsistent", async () => {
    const store = fakeStore();
    store.seed([appliedRow(m("0001_a", "CREATE TABLE t (id INT);"))]);

    await expect(
      migrate(store, [m("0001_a", "CREATE TABLE t (id BIGINT);"), m("0002_b")], clock),
    ).rejects.toThrow(/was modified after being applied/);

    expect(store.appliedSql).toEqual([]);
  });
});
