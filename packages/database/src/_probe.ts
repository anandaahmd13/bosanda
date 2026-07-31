import type postgres from "postgres";
import type { Sql } from "./client.js";

export type Tx = postgres.TransactionSql<Record<string, never>>;
export type Executor = postgres.ISql<Record<string, never>>;

export async function probeUnion(e: Sql | Tx): Promise<number> {
  const rows = await e<{ n: number }[]>`SELECT 1 AS n`;
  return rows.length;
}

export async function probeISql(e: Executor): Promise<number> {
  const rows = await e<{ n: number }[]>`SELECT 1 AS n WHERE ${1} = 1`;
  const first = rows[0];
  return first === undefined ? 0 : first.n;
}

export function probeFragment(e: Executor, on: boolean): unknown {
  return e`SELECT 1 ${on ? e`AND 2 = ${2}` : e``}`;
}

export function isTx(e: Sql | Tx): e is Tx {
  return typeof (e as Tx).savepoint === "function";
}

export async function probeBegin(sql: Sql): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ n: number }[]>`SELECT 1 AS n`;
    return rows.length;
  });
}
