/**
 * `pnpm admin:bootstrap` — create the first operator account.
 *
 * This is deliberately interactive and one-time. Passwords never appear in argv, env,
 * logs, or output, and the database transaction rechecks the admin guard under an
 * advisory lock so two simultaneous invocations cannot create two operators.
 */

import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadEnv } from "@bosanda/config";
import {
  assertPasswordAcceptable,
  assertUsernameAcceptable,
  hashPassword,
  normalizeUsername,
} from "@bosanda/auth";
import { createClientFromEnv, closeClient, checkConnection, type Sql } from "../client.js";
import { usersRepository } from "../repositories/users.js";
import { withTransaction } from "../repositories/executor.js";
import { systemClock, ulid } from "@bosanda/shared";
import { BosandaError } from "@bosanda/protocol";

export type BootstrapPrompter = {
  ask(question: string): Promise<string>;
  password(question: string): Promise<string>;
  close(): void;
};

export function createPrompter(): BootstrapPrompter {
  const readline = createInterface({ input, output });
  const ask = (question: string): Promise<string> => readline.question(question);
  const password = async (question: string): Promise<string> => {
    if (!input.isTTY || !output.isTTY) return readline.question(question);
    output.write(question);
    const wasRaw = Boolean(input.isRaw);
    input.setRawMode(true);
    input.resume();
    let value = "";
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          if (byte === 3) {
            input.setRawMode(wasRaw);
            input.off("data", onData);
            readline.close();
            process.exitCode = 130;
            resolve();
            return;
          }
          if (byte === 13 || byte === 10) {
            output.write("\n");
            input.setRawMode(wasRaw);
            input.off("data", onData);
            resolve();
            return;
          }
          if (byte === 127 || byte === 8) {
            value = value.slice(0, -1);
            continue;
          }
          if (byte >= 32) value += String.fromCharCode(byte);
        }
      };
      input.on("data", onData);
    });
    return value;
  };
  return { ask, password, close: () => readline.close() };
}

export type BootstrapResult =
  { status: "created"; userId: string; username: string } | { status: "already_exists" };

export async function bootstrapAdmin(
  usernameInput: string,
  password: string,
  confirmation: string,
  options: { sql: Sql; clock?: typeof systemClock },
): Promise<BootstrapResult> {
  const username = normalizeUsername(usernameInput);
  assertUsernameAcceptable(username);
  assertPasswordAcceptable(password);
  if (password !== confirmation) {
    throw new BosandaError("invalid_request", {
      internalDetail: "admin bootstrap password confirmation did not match",
    });
  }
  const clock = options.clock ?? systemClock;
  const createdAt = clock.now();
  const passwordHash = await hashPassword(password);
  const result = await withTransaction(options.sql, async (tx) => {
    const user = await usersRepository(tx).bootstrapAdmin({
      id: ulid(),
      username,
      passwordHash,
      role: "admin",
      status: "active",
      createdAt,
    });
    return user === null
      ? { status: "already_exists" as const }
      : { status: "created" as const, userId: user.id, username: user.username };
  });
  return result;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const sql = createClientFromEnv(env);
  const prompter = createPrompter();
  try {
    await checkConnection(sql);
    const username = await prompter.ask("Admin username: ");
    const password = await prompter.password("Admin password: ");
    const confirmation = await prompter.password("Confirm password: ");
    const result = await bootstrapAdmin(username, password, confirmation, { sql });
    if (result.status === "already_exists") {
      throw new BosandaError("conflict", { internalDetail: "an admin account already exists" });
    }
    console.error(`[admin:bootstrap] created admin ${result.username} (${result.userId})`);
  } finally {
    prompter.close();
    await closeClient(sql);
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  try {
    await main();
  } catch (error) {
    const message =
      error instanceof BosandaError
        ? (error.internalDetail ?? error.code)
        : error instanceof Error
          ? error.message
          : "unknown failure";
    console.error(`[admin:bootstrap] FAILED: ${message}`);
    process.exitCode = 1;
  }
}
