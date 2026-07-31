/**
 * Asserts against the real `migrations/*.sql` shipped in this package.
 *
 * These are contract tests, not a database: they check that the schema encodes
 * the invariants PLAN.md requires, so a table added later without its CHECK
 * constraints fails here instead of in production.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMigrations, migrationsDirectory } from "../src/migration-files.js";

const migrations = await loadMigrations();
const schema = migrations.map((m) => m.sql).join("\n");
const sessionsRepositorySource = await readFile(
  new URL("../src/repositories/sessions.ts", import.meta.url),
  "utf8",
);

/** PLAN.md §14 lists exactly these 14 tables. */
const REQUIRED_TABLES = [
  "users",
  "sessions",
  "packages",
  "package_stock",
  "orders",
  "payment_events",
  "api_keys",
  "quota_ledger",
  "provider_accounts",
  "provider_health_events",
  "models",
  "usage_events",
  "audit_events",
  "feature_flags",
];

describe("loadMigrations", () => {
  it("finds at least the initial schema", () => {
    expect(migrations.map((m) => m.id)).toContain("0001_initial_schema");
  });

  it("returns migrations sorted by id", () => {
    const ids = migrations.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("points at a directory inside this package", () => {
    expect(migrationsDirectory()).toContain(path.join("packages", "database"));
  });

  it("rejects a file without a 4-digit ordinal prefix", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bosanda-mig-"));
    await writeFile(path.join(dir, "add_column.sql"), "SELECT 1;", "utf8");

    await expect(loadMigrations(dir)).rejects.toThrow(/does not match NNNN_lower_snake_case/);
  });

  it("rejects an empty migration file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bosanda-mig-"));
    await writeFile(path.join(dir, "0001_empty.sql"), "   \n", "utf8");

    await expect(loadMigrations(dir)).rejects.toThrow(/is empty/);
  });

  it("rejects two files sharing an ordinal", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bosanda-mig-"));
    await writeFile(path.join(dir, "0001_one.sql"), "SELECT 1;", "utf8");
    await writeFile(path.join(dir, "0001_two.sql"), "SELECT 2;", "utf8");

    await expect(loadMigrations(dir)).rejects.toThrow(/share ordinal 0001/);
  });

  it("ignores non-.sql files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bosanda-mig-"));
    await writeFile(path.join(dir, "0001_ok.sql"), "SELECT 1;", "utf8");
    await writeFile(path.join(dir, "README.md"), "notes", "utf8");

    const loaded = await loadMigrations(dir);
    expect(loaded.map((m) => m.id)).toEqual(["0001_ok"]);
  });
});

describe("schema completeness (PLAN.md §14)", () => {
  it.each(REQUIRED_TABLES)("creates %s", (table) => {
    expect(schema).toContain(`CREATE TABLE ${table} (`);
  });

  it("creates no tables beyond those PLAN.md lists", () => {
    const created = [...schema.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+) \(/g)].map(
      (match) => match[1]!,
    );
    expect(created.sort()).toEqual([...REQUIRED_TABLES].sort());
  });
});

describe("schema invariants", () => {
  it("stores every timestamp as timestamptz, never naive timestamp", () => {
    // A bare `TIMESTAMP` column would silently drop the offset (PLAN.md §14).
    expect(schema).not.toMatch(/\bTIMESTAMP\b(?!TZ)/);
  });

  it("uses no floating-point type for money", () => {
    expect(schema).not.toMatch(/\b(FLOAT|REAL|DOUBLE PRECISION|MONEY)\b/);
  });

  it("makes username uniqueness case-insensitive", () => {
    expect(schema).toContain(
      "CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username))",
    );
  });

  it("makes the payment provider event key unique, so webhook replay cannot double-credit", () => {
    expect(schema).toMatch(
      /payment_events_provider_event_key UNIQUE \(provider, provider_event_key\)/,
    );
  });

  it("keeps api_keys.quota_remaining within quota_limit", () => {
    expect(schema).toMatch(
      /api_keys_remaining_within_limit CHECK \(quota_remaining <= quota_limit\)/,
    );
  });

  it("forbids a negative quota balance", () => {
    expect(schema).toMatch(/balance_after\s+BIGINT NOT NULL CHECK \(balance_after >= 0\)/);
  });

  it("allows exactly the order states PLAN.md §13 names", () => {
    // Pinned because the schema and @bosanda/payments must agree on this
    // vocabulary: a status one side accepts and the other rejects strands an
    // order mid-flow, with the customer already charged.
    for (const status of [
      "draft",
      "pending_payment",
      "paid",
      "activated",
      "expired",
      "cancelled",
      "review_required",
    ]) {
      expect(schema).toContain(`'${status}'`);
    }
    // Refunds go through review_required, never a status that implies the
    // money was silently unwound.
    expect(schema).not.toContain("'refund_required'");
  });

  it("indexes stale pending orders by the state reconciliation actually scans", () => {
    expect(schema).toMatch(
      /orders_pending_reservation_idx[\s\S]*?WHERE status = 'pending_payment'/,
    );
  });

  it("requires a debit to be non-positive and a grant to be positive", () => {
    expect(schema).toContain("quota_ledger_debit_is_negative");
    expect(schema).toMatch(/kind = 'debit' AND weighted_tokens_delta <= 0/);
    expect(schema).toMatch(/kind IN \('grant', 'top_up'\) AND weighted_tokens_delta > 0/);
  });

  it("makes a per-request debit unique, so a retried settle cannot double-charge", () => {
    expect(schema).toMatch(
      /CREATE UNIQUE INDEX quota_ledger_request_debit_key[\s\S]*?WHERE kind = 'debit'/,
    );
  });

  it("ties a top-up order to a target key and a new-key order to none", () => {
    expect(schema).toContain("orders_target_matches_type");
    expect(schema).toMatch(/type = 'top_up' AND target_api_key_id IS NOT NULL/);
    expect(schema).toMatch(/type = 'new_key' AND target_api_key_id IS NULL/);
  });

  it("forbids activating an order that was never paid", () => {
    expect(schema).toMatch(/orders_paid_before_activated CHECK \([\s\S]*?paid_at IS NOT NULL/);
  });

  it("keeps an immutable package snapshot on each order", () => {
    expect(schema).toMatch(/package_snapshot\s+JSONB NOT NULL/);
  });

  it("refuses to publish a model whose compatibility gate has not passed", () => {
    // PLAN.md §3: an untested model must never appear on /v1/models.
    expect(schema).toMatch(
      /models_published_requires_passing CHECK \([\s\S]*?compatibility_status IN \('passing', 'degraded'\)/,
    );
  });

  it("carries a version column on package_stock for compare-and-swap", () => {
    expect(schema).toMatch(/version\s+BIGINT NOT NULL DEFAULT 0/);
  });

  it("versions both encrypted columns so keys can rotate", () => {
    const versioned = [...schema.matchAll(/encryption_key_version INTEGER NOT NULL/g)];
    expect(versioned).toHaveLength(2);
  });

  it("indexes api_keys by lookup_digest uniquely, since that is the auth lookup", () => {
    expect(schema).toMatch(/lookup_digest\s+TEXT NOT NULL UNIQUE/);
  });

  it("stores no prompt or response text on usage_events", () => {
    const block = schema.slice(
      schema.indexOf("CREATE TABLE usage_events ("),
      schema.indexOf("CREATE TABLE audit_events ("),
    );
    for (const forbidden of ["prompt", "response_body", "completion", "messages", "tool_result"]) {
      expect(block).not.toContain(forbidden);
    }
  });

  it("persists session activity for the sliding idle timeout", () => {
    expect(schema).toMatch(/last_used_at\s+TIMESTAMPTZ NOT NULL/);
    expect(schema).toContain("sessions_activity_within_lifetime");
    expect(schema).toMatch(/last_used_at >= created_at AND last_used_at <= expires_at/);
    expect(sessionsRepositorySource).toMatch(
      /created_at, last_used_at[\s\S]*?input\.createdAt}, \$\{input\.lastUsedAt}/,
    );
    expect(sessionsRepositorySource).toMatch(
      /SET last_used_at = LEAST\(\$\{at}, expires_at\)[\s\S]*?AND revoked_at IS NULL[\s\S]*?AND last_used_at < \$\{at}/,
    );
  });

  it("scopes a session token hash uniquely", () => {
    expect(schema).toMatch(/token_hash\s+TEXT NOT NULL UNIQUE/);
  });

  it("restricts deletion of users that still own keys or orders", () => {
    // Deleting a user must not orphan billing history.
    expect(schema).toMatch(/api_keys[\s\S]*?REFERENCES users \(id\) ON DELETE RESTRICT/);
    expect(schema).toMatch(/orders[\s\S]*?REFERENCES users \(id\) ON DELETE RESTRICT/);
  });
});
