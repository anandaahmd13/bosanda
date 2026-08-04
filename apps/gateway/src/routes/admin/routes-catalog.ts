/**
 * Packages, feature flags, and the audit log (PLAN.md §9, §3, §14, §15).
 *
 * ── THE STOCK ENDPOINT TAKES A DELTA AND THE REPOSITORY TAKES AN ABSOLUTE ─
 * `addPackageStock` sends `{delta}`; the only writer is `setStock(packageId, available)`,
 * which is an absolute set. So the handler reads inside the transaction and writes
 * `available + delta`. `lockStock` (FOR UPDATE) is what makes that safe — without it two
 * operators adding 10 each would both read the same base and one increment would vanish.
 * The read-modify-write is not a workaround for a missing method; it is the same thing a
 * `SET available = available + x` would do, with the lock held for the audit row too.
 *
 * `reserved` is deliberately not touched. `setStock` documents that it does not reset it,
 * because a reservation belongs to an in-flight order: clearing it would let the same unit
 * be sold twice.
 *
 * ── FLAGS HAVE FOUR CONTRACT FIELDS THE TABLE DOES NOT HAVE ───────────────
 * `feature_flags` is `(key, value, updated_by, updated_at)`. The contract additionally
 * requires `scope`, `target`, `label`, and `blastRadius`. Those are DESCRIPTIONS of a
 * switch, not state, so they live in the catalogue below rather than in the database —
 * storing prose in a config table would mean an operator could edit the warning text that
 * exists to make them think twice. The catalogue is the reason a flag list is
 * enumerable at all: an operator cannot turn on a switch that has never been written if
 * the endpoint only reports rows that exist.
 *
 * ── `enabled: true` MEANS TRAFFIC ALLOWED ─────────────────────────────────
 * The schema says so, and it inverts for the `disabled_*` flags: `kiro.disabled_models` is
 * a SET, not a boolean, and there is no coherent single `enabled` for it. Those two keys
 * are therefore reported as informational entries whose `enabled` reflects whether the set
 * is EMPTY (nothing disabled = traffic allowed), and they are not writable through
 * `POST /flags/:key`. Writing them would need a set-valued endpoint the contract does not
 * define, and coercing a boolean into a set would either wipe the operator's list or be a
 * no-op — both worse than a clear refusal.
 */

import type { FastifyInstance } from "fastify";
import { BosandaError } from "@bosanda/protocol";
import {
  FLAG_ADAPTER_ENABLED,
  FLAG_CODEX_ADAPTER_ENABLED,
  FLAG_CODEX_DISABLED_MODELS,
  FLAG_CODEX_TOOL_USE_ENABLED,
  FLAG_DISABLED_MODELS,
  FLAG_DISABLED_REGIONS,
  FLAG_TOOL_USE_ENABLED,
} from "@bosanda/database";
import type { AdminDeps } from "./deps.js";
import { ADMIN_ACTIONS, auditActor, writeAudit } from "./audit.js";
import {
  invalid,
  iso,
  isoOrNull,
  ok,
  readBody,
  readBoolean,
  readInteger,
  readParam,
  readPaging,
  readQuery,
  readReason,
  readSearch,
} from "./contract.js";
import { requireAdmin } from "./session.js";

/**
 * The writable kill switches, with the prose the confirmation dialog shows.
 *
 * Both are `scope: "global"` except tool use, which the schema gives its own scope — the
 * enum has a `tool_use` member for exactly this key, so using `global` for it would make
 * that member unreachable and the dashboard's grouping wrong.
 */
const FLAG_CATALOGUE = [
  {
    key: FLAG_ADAPTER_ENABLED,
    scope: "global" as const,
    target: null,
    label: "Kiro adapter",
    blastRadius:
      "Turning this off stops every inference request across all models and accounts, and hides the whole catalogue.",
    writable: true,
  },
  {
    key: FLAG_TOOL_USE_ENABLED,
    scope: "tool_use" as const,
    target: null,
    label: "Tool use",
    blastRadius:
      "Turning this off rejects any request carrying tools. Plain completions keep working.",
    writable: true,
  },
  {
    key: FLAG_DISABLED_REGIONS,
    scope: "region" as const,
    target: null,
    label: "Disabled regions",
    blastRadius:
      "Read-only here. Accounts in a listed region are removed from the pool; edit the list in the environment.",
    writable: false,
  },
  {
    key: FLAG_DISABLED_MODELS,
    scope: "model" as const,
    target: null,
    label: "Disabled models",
    blastRadius:
      "Read-only here. Listed models are hidden and rejected; edit the list in the environment.",
    writable: false,
  },
  {
    key: FLAG_CODEX_ADAPTER_ENABLED,
    scope: "global" as const,
    target: null,
    label: "Codex adapter",
    blastRadius:
      "Turning this off stops Codex routing. Cannot re-enable if OPENAI_CODEX_RUNTIME_ENABLED or COMMERCIAL is false.",
    writable: true,
  },
  {
    key: FLAG_CODEX_TOOL_USE_ENABLED,
    scope: "tool_use" as const,
    target: null,
    label: "Codex tool use",
    blastRadius: "Turning this off rejects Codex requests that carry tools.",
    writable: true,
  },
  {
    key: FLAG_CODEX_DISABLED_MODELS,
    scope: "model" as const,
    target: null,
    label: "Codex disabled models",
    blastRadius:
      "Read-only here. Listed Codex models are hidden and rejected; edit OPENAI_CODEX_DISABLED_MODELS.",
    writable: false,
  },
] as const;

export function registerCatalogRoutes(app: FastifyInstance, deps: AdminDeps): void {
  /* ──────────────────────────────── packages ──────────────────────────────── */

  /**
   * The package catalogue with stock.
   *
   * `readStock` returns null when no operator has ever set stock for a package, and the
   * repository preserves that distinction on purpose ("null = no operator-set row,
   * distinct from zero"). The contract's `stock` is a REQUIRED object, so a null must be
   * rendered as something — and zero is the operationally correct rendering: a package
   * with no stock row cannot be sold, exactly like one with `available: 0`. The
   * distinction is lost at this boundary and nowhere else; `version: 0` is the value
   * `setStock`'s first write will CAS against, so the dashboard's next update still works.
   */
  app.get("/admin/v1/packages", async (request, reply) => {
    await requireAdmin(request, deps);
    const records = await deps.packages.listAll();

    const stocks = await Promise.all(records.map((record) => deps.packages.readStock(record.id)));

    return reply.status(200).send({
      packages: records.map((record, index) => {
        const stock = stocks[index] ?? null;
        const available = stock?.available ?? 0;
        const reserved = stock?.reserved ?? 0;
        return {
          id: record.id,
          name: record.name,
          weightedTokenQuota: record.weightedTokenQuota,
          priceIdr: record.priceIdr,
          durationSeconds: record.durationSeconds,
          maxKeyQuota: record.maxKeyQuota,
          active: record.active,
          stock: {
            available,
            reserved,
            version: stock?.version ?? 0,
            // No stock row means nothing has been set, so the package row's own timestamp
            // is the most recent true statement about it.
            updatedAt: iso(stock?.updatedAt ?? record.updatedAt),
          },
          /**
           * Sold out is about FREE units, not gross available: a unit held by a live
           * reservation is already spoken for. `freeUnits` in the database package encodes
           * the same subtraction for the reservation path, so the storefront and this
           * table agree on what "sold out" means.
           */
          soldOut: available - reserved <= 0,
        };
      }),
    });
  });

  /**
   * Updates a package's price and active flag.
   *
   * The client sends only `{packageId, priceIdr, active, reason}` while `upsert` demands
   * the full definition, so the remaining fields are read inside the transaction and
   * passed through unchanged. Read-then-write rather than two calls (`setActive` plus an
   * `upsert`) because both fields must land together — an operator lowering a price and
   * deactivating in one action must not leave the new price live if the deactivation fails.
   *
   * `weightedTokenQuota` and `durationSeconds` are NOT editable here, and that is the
   * contract's choice rather than an omission: they are captured in `orders.package_snapshot`
   * at purchase time, so changing them would silently alter what a package means without
   * affecting anything already sold. Price is safe to change for the same reason — the
   * snapshot fixes what a paying customer agreed to.
   */
  app.post<{ Params: { packageId: string } }>(
    "/admin/v1/packages/:packageId",
    async (request, reply) => {
      const actor = await requireAdmin(request, deps);
      const packageId = readParam(request.params, "packageId");
      const body = readBody(request.body, ["packageId", "priceIdr", "active", "reason"]);

      if (typeof body["packageId"] === "string" && body["packageId"] !== packageId) {
        throw invalid("packageId", "must match the package in the path");
      }
      // Integer rupiah only (§14: never floating point). Zero is allowed — a free package
      // is a legitimate promotional configuration.
      const priceIdr = readInteger(body, "priceIdr", 0, 1_000_000_000_000);
      const active = readBoolean(body, "active");
      const reason = readReason(body);
      const at = deps.clock.now();

      const found = await deps.transact(async (tx) => {
        const existing = await tx.packages.findById(packageId);
        if (existing === null) return false;

        await tx.packages.upsert({
          id: existing.id,
          name: existing.name,
          weightedTokenQuota: existing.weightedTokenQuota,
          priceIdr,
          durationSeconds: existing.durationSeconds,
          maxKeyQuota: existing.maxKeyQuota,
          allowedModels: existing.allowedModels,
          active,
          at,
        });
        await writeAudit(
          tx,
          auditActor(actor),
          {
            action: ADMIN_ACTIONS.packageUpdated,
            targetType: "package",
            targetId: packageId,
            reason,
            details: {
              priceIdr,
              previousPriceIdr: existing.priceIdr,
              active,
              previousActive: existing.active,
            },
          },
          at,
        );
        return true;
      });

      if (!found) {
        throw new BosandaError("not_found", { internalDetail: `package ${packageId} not found` });
      }
      return reply.status(200).send(ok("Package updated."));
    },
  );

  /**
   * Adds (or removes) stock.
   *
   * A negative delta is allowed — pulling stock is how an operator stops sales without
   * deactivating a package — but the result is floored at zero rather than rejected. A
   * negative `available` violates the column's CHECK, and refusing the whole action
   * because the operator's number was larger than the current count would be pedantic
   * when the intent ("take it all out") is unambiguous. The clamp is reported in the audit
   * row so the difference between requested and applied is on the record.
   */
  app.post<{ Params: { packageId: string } }>(
    "/admin/v1/packages/:packageId/stock",
    async (request, reply) => {
      const actor = await requireAdmin(request, deps);
      const packageId = readParam(request.params, "packageId");
      const body = readBody(request.body, ["delta", "reason"]);
      const delta = readInteger(body, "delta", -1_000_000, 1_000_000);
      if (delta === 0) throw invalid("delta", "must not be zero");
      const reason = readReason(body);
      const at = deps.clock.now();

      const outcome = await deps.transact(async (tx) => {
        const existing = await tx.packages.findById(packageId);
        if (existing === null) return { kind: "missing" as const };

        // FOR UPDATE, so a concurrent add or a reservation cannot interleave between the
        // read and the write. Null means no stock row yet, which reads as zero.
        const locked = await tx.packages.lockStock(packageId);
        const before = locked?.available ?? 0;
        const after = Math.max(0, before + delta);

        await tx.packages.setStock(packageId, after, at);
        await writeAudit(
          tx,
          auditActor(actor),
          {
            action: ADMIN_ACTIONS.packageStockChanged,
            targetType: "package",
            targetId: packageId,
            reason,
            details: {
              requestedDelta: delta,
              appliedDelta: after - before,
              availableBefore: before,
              availableAfter: after,
              reserved: locked?.reserved ?? 0,
            },
          },
          at,
        );
        return { kind: "ok" as const, before, after };
      });

      if (outcome.kind === "missing") {
        throw new BosandaError("not_found", { internalDetail: `package ${packageId} not found` });
      }

      return reply
        .status(200)
        .send(
          ok(
            outcome.after === outcome.before + delta
              ? "Stock updated."
              : "Stock updated. The requested decrease was larger than the available count, so it was floored at zero.",
          ),
        );
    },
  );

  /* ────────────────────────────────── flags ───────────────────────────────── */

  /**
   * The switch list.
   *
   * Every catalogued key appears whether or not a row exists. A missing row means "not
   * overridden", and the effective value then comes from the environment — which is what
   * `deps.killSwitches()` already resolves, including the rule that a flag can only ever
   * narrow the environment's baseline. Reporting the EFFECTIVE value rather than the
   * stored one is the honest answer to "is traffic flowing", and it is the only value that
   * matches what the gateway will actually do on the next request.
   */
  app.get("/admin/v1/flags", async (request, reply) => {
    await requireAdmin(request, deps);

    const [rows, switches] = await Promise.all([deps.flags.readAll(), deps.killSwitches()]);
    const stored = new Map(rows.map((row) => [row.key, row]));

    const effective = (key: string): boolean => {
      switch (key) {
        case FLAG_ADAPTER_ENABLED:
          return switches.adapterEnabled;
        case FLAG_TOOL_USE_ENABLED:
          return switches.toolUseEnabled;
        case FLAG_DISABLED_REGIONS:
          return switches.disabledRegions.size === 0;
        case FLAG_DISABLED_MODELS:
          return switches.disabledModels.size === 0;
        case FLAG_CODEX_ADAPTER_ENABLED:
          // Env commercial+runtime already gate customer traffic; the flag only
          // further disables. Surface env baseline so the console is honest.
          return deps.env.OPENAI_CODEX_RUNTIME_ENABLED && deps.env.OPENAI_CODEX_COMMERCIAL_ENABLED;
        case FLAG_CODEX_TOOL_USE_ENABLED:
          return deps.env.OPENAI_CODEX_TOOL_USE_ENABLED;
        case FLAG_CODEX_DISABLED_MODELS:
          return deps.env.OPENAI_CODEX_DISABLED_MODELS.length === 0;
        default:
          return false;
      }
    };

    return reply.status(200).send({
      flags: FLAG_CATALOGUE.map((entry) => {
        const row = stored.get(entry.key);
        return {
          key: entry.key,
          scope: entry.scope,
          target: entry.target,
          label: entry.label,
          enabled: effective(entry.key),
          blastRadius: entry.blastRadius,
          updatedAt: isoOrNull(row?.updatedAt),
          updatedBy: row?.updatedBy ?? null,
        };
      }),
      /**
       * Read-only, and the contract says so: it is an environment variable, and §3 requires
       * that `KIRO_DIRECT_ENABLED=false` cannot be overridden by a database write.
       */
      kiroDirectEnabled: deps.env.KIRO_DIRECT_ENABLED,
      openaiCodexRuntimeEnabled: deps.env.OPENAI_CODEX_RUNTIME_ENABLED,
      openaiCodexCommercialEnabled: deps.env.OPENAI_CODEX_COMMERCIAL_ENABLED,
    });
  });

  /**
   * Flips one switch.
   *
   * An unknown key is a 404 rather than an upsert. `flagsRepository.upsert` would happily
   * write any key, and a typo would then create a switch that nothing reads while the
   * operator believed they had disabled something — during an incident that is the worst
   * possible failure. The catalogue is the allowlist.
   *
   * Note the asymmetry the environment imposes: setting `enabled: true` on a flag the
   * environment has turned off does NOT restore traffic, because `killSwitchesFrom` ANDs
   * the booleans. The response says so rather than reporting a bare success, so an
   * operator is not left wondering why the dashboard still shows the switch as off.
   */
  app.post<{ Params: { key: string } }>("/admin/v1/flags/:key", async (request, reply) => {
    const actor = await requireAdmin(request, deps);
    const key = readParam(request.params, "key");
    const body = readBody(request.body, ["enabled", "reason"]);
    const enabled = readBoolean(body, "enabled");
    const reason = readReason(body);

    const entry = FLAG_CATALOGUE.find((candidate) => candidate.key === key);
    if (entry === undefined) {
      throw new BosandaError("not_found", {
        internalDetail: `feature flag ${key} is not a known switch`,
      });
    }
    if (!entry.writable) {
      throw new BosandaError("invalid_request", {
        internalDetail: `feature flag ${key} is a set-valued switch and is not writable here`,
      });
    }

    const at = deps.clock.now();

    await deps.transact(async (tx) => {
      const previous = await tx.flags.findByKey(key);
      await tx.flags.upsert(key, enabled, actor.user.username, at);
      await writeAudit(
        tx,
        auditActor(actor),
        {
          action: ADMIN_ACTIONS.flagChanged,
          targetType: "feature_flag",
          targetId: key,
          reason,
          details: {
            enabled,
            // A JSON boolean or null; never a secret. `null` distinguishes "first write"
            // from "changed from true".
            previousValue: typeof previous?.value === "boolean" ? previous.value : null,
          },
        },
        at,
      );
    });

    // Re-read so the message reflects what the gateway will DO, not what was written.
    const switches = await deps.killSwitches();
    const nowAllowed =
      key === FLAG_ADAPTER_ENABLED || key === FLAG_CODEX_ADAPTER_ENABLED
        ? key === FLAG_CODEX_ADAPTER_ENABLED
          ? deps.env.OPENAI_CODEX_RUNTIME_ENABLED &&
            deps.env.OPENAI_CODEX_COMMERCIAL_ENABLED &&
            enabled
          : switches.adapterEnabled
        : key === FLAG_CODEX_TOOL_USE_ENABLED
          ? deps.env.OPENAI_CODEX_TOOL_USE_ENABLED && enabled
          : switches.toolUseEnabled;

    request.bosandaLog.warn({ flag: key, enabled }, "admin changed a kill switch");

    if (enabled && !nowAllowed) {
      return reply
        .status(200)
        .send(
          ok(
            "Saved, but traffic is still blocked: the environment disables this switch and a flag cannot re-enable it.",
          ),
        );
    }
    return reply
      .status(200)
      .send(ok(enabled ? "Switch enabled. Traffic is allowed." : "Switch disabled."));
  });

  /* ────────────────────────────────── audit ───────────────────────────────── */

  /**
   * The audit log.
   *
   * ── `actorLabel` AND `reason` ARE RECONSTRUCTED, NOT STORED ────────────
   * `audit_events` has neither column. `reason` is lifted out of `metadata` where
   * `writeAudit` put it; `actorLabel` comes from `metadata.actorUsername` when the row was
   * written by this module, and falls back to the actor id otherwise. The fallback matters:
   * `executeActivation` and any future worker write rows with `actorType: "system"` and no
   * username, and the contract's `actorLabel` is `z.string().min(1)`, so a blank would fail
   * the dashboard's parse and hide the entire page over one system row.
   *
   * ── WHY NULL IDS BECOME LITERALS ──────────────────────────────────────
   * `actorId`, `targetType`, and `targetId` are all nullable in the table and all
   * `z.string().min(1)` in the contract. A system row legitimately has no actor. `"system"`
   * and `"—"` are rendered rather than the row being dropped, because silently omitting
   * rows from an audit log is strictly worse than rendering a placeholder in one column.
   */
  app.get("/admin/v1/audit", async (request, reply) => {
    await requireAdmin(request, deps);

    const query = readQuery(request.query, ["limit", "offset", "actor", "action", "target_type"]);
    const paging = readPaging(query);
    const actor = readSearch(query, "actor");
    const action = readSearch(query, "action");
    const targetType = readSearch(query, "target_type");

    const filter = {
      ...(actor === undefined ? {} : { actorId: actor }),
      ...(action === undefined ? {} : { action }),
      ...(targetType === undefined ? {} : { targetType }),
    };

    const [listed, total] = await Promise.all([
      deps.audit.list(filter, paging),
      deps.audit.count(filter),
    ]);

    return reply.status(200).send({
      events: listed.events.map((event) => {
        const username = event.metadata["actorUsername"];
        const reason = event.metadata["reason"];
        return {
          id: event.id,
          actorType: event.actorType,
          actorId: event.actorId ?? "system",
          actorLabel:
            typeof username === "string" && username.length > 0
              ? username
              : (event.actorId ?? "system"),
          action: event.action,
          targetType: event.targetType ?? "—",
          targetId: event.targetId ?? "—",
          reason: typeof reason === "string" && reason.length > 0 ? reason : null,
          createdAt: iso(event.createdAt),
        };
      }),
      total,
    });
  });
}
