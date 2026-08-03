import { describe, expect, it } from "vitest";
import { fixedClock } from "@bosanda/shared";
import { bootstrapAdmin } from "../src/cli/bootstrap-admin.js";
import type { Sql } from "../src/client.js";

type QueryCall = { text: string; values: readonly unknown[] };

function fakeSql(rows: unknown[][]): { sql: Sql; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  let index = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (result, part, partIndex) =>
        `${result}${part}${partIndex < values.length ? `$${partIndex + 1}` : ""}`,
      "",
    );
    calls.push({ text, values });
    return Promise.resolve(rows[index++] ?? []) as never;
  }) as unknown as Sql;
  return { sql, calls };
}

function fakeTransactionSql(rows: unknown[][]): { sql: Sql; calls: QueryCall[] } {
  const fake = fakeSql(rows);
  const sql = Object.assign(fake.sql, {
    async begin<T>(callback: (tx: Sql) => Promise<T>): Promise<T> {
      return callback(fake.sql);
    },
  }) as unknown as Sql;
  return { sql, calls: fake.calls };
}

const clock = fixedClock(new Date("2026-08-03T00:00:00.000Z"));

describe("bootstrapAdmin", () => {
  it("creates one admin and never sends the password to SQL", async () => {
    const { sql, calls } = fakeTransactionSql([
      [],
      [{ present: false }],
      [
        {
          id: "01JADMIN",
          username: "op_user",
          password_hash: "$argon2id$v=19$m=1,t=1,p=1$test$hash",
          role: "admin",
          status: "active",
          created_at: new Date("2026-08-03T00:00:00.000Z"),
          updated_at: new Date("2026-08-03T00:00:00.000Z"),
        },
      ],
    ]);

    const result = await bootstrapAdmin(
      " Op_user ",
      "correct horse battery staple",
      "correct horse battery staple",
      {
        sql,
        clock,
      },
    );

    expect(result).toEqual({ status: "created", userId: "01JADMIN", username: "op_user" });
    if (result.status !== "created") throw new Error("expected admin creation");
    expect(result.username).toBe("op_user");
    expect(calls[0]?.text).toContain("pg_advisory_xact_lock");
    expect(calls.at(-1)?.text).toContain("INSERT INTO users");
    expect(calls.flatMap((call) => call.values)).not.toContain("correct horse battery staple");
  });

  it("reports the existing-admin guard without inserting", async () => {
    const { sql, calls } = fakeTransactionSql([[], [{ present: true }]]);

    await expect(
      bootstrapAdmin("op_user", "correct horse battery staple", "correct horse battery staple", {
        sql,
        clock,
      }),
    ).resolves.toEqual({ status: "already_exists" });

    expect(calls).toHaveLength(2);
    expect(calls.at(-1)?.text).toContain("EXISTS");
  });

  it("rejects a confirmation mismatch before opening a transaction", async () => {
    const { sql, calls } = fakeTransactionSql([]);

    await expect(
      bootstrapAdmin("op_user", "correct horse battery staple", "different password", {
        sql,
        clock,
      }),
    ).rejects.toThrow("admin bootstrap password confirmation did not match");
    expect(calls).toHaveLength(0);
  });
});
