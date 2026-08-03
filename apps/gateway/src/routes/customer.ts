import type { FastifyInstance } from "fastify";
import { BosandaError } from "@bosanda/protocol";
import { maskKey, revealApiKey } from "@bosanda/api-keys";
import { MAX_KEY_QUOTA } from "@bosanda/metering";
import { KEY_VALIDITY_MS, ulid } from "@bosanda/shared";
import { DEFAULT_TOP_UP_STOCK_POLICY, reserveStock } from "@bosanda/payments";
import type { ApiKey, Order } from "@bosanda/database";
import type { CustomerDeps } from "../customer-dependencies.js";
import { requireCustomer, type CustomerActor } from "./customer-session.js";

function notFound(detail: string): BosandaError {
  return new BosandaError("not_found", { internalDetail: detail });
}

function conflict(detail: string): BosandaError {
  return new BosandaError("conflict", { internalDetail: detail });
}

function invalid(detail: string): BosandaError {
  return new BosandaError("invalid_request", { internalDetail: detail });
}

function param(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function bodyObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("body must be an object");
  }
  return raw as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string, max = 128): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function accountResponse(
  actor: CustomerActor,
  user: { role: string; status: string; createdAt: Date },
) {
  return {
    userId: actor.userId,
    username: actor.username,
    role: user.role === "admin" ? "admin" : "user",
    status: user.status === "active" ? "active" : "disabled",
    createdAt: user.createdAt.toISOString(),
  };
}

function keyStatus(key: ApiKey): "active" | "expired" | "revoked" | "exhausted" {
  if (key.status === "revoked") return "revoked";
  if (key.status === "expired") return "expired";
  return key.quotaRemaining <= 0 ? "exhausted" : "active";
}

function keyResponse(key: ApiKey) {
  return {
    keyId: key.id,
    masked: maskKey(key.prefix),
    status: keyStatus(key),
    createdAt: key.createdAt.toISOString(),
    expiresAt: key.expiresAt.toISOString(),
    quotaTotal: key.quotaLimit,
    quotaRemaining: key.quotaRemaining,
  };
}

function orderResponse(
  order: Order,
  paymentUrl: string | null = null,
  activatedKeyId: string | null = null,
) {
  return {
    orderId: order.id,
    status: order.status,
    priceIdr: order.packageSnapshot.priceIdr,
    tokens: order.packageSnapshot.weightedTokenQuota,
    packageId: order.packageId,
    intent: order.type,
    targetKeyId: order.targetApiKeyId,
    createdAt: order.createdAt.toISOString(),
    paymentUrl,
    activatedKeyId,
  };
}

async function activatedIds(
  deps: CustomerDeps,
  orders: readonly Order[],
): Promise<ReadonlyMap<string, string>> {
  return deps.orderQuery.activatedKeyIds(orders.map((order) => order.id));
}

async function ownedKey(deps: CustomerDeps, actor: CustomerActor, keyId: string): Promise<ApiKey> {
  const key = await deps.apiKeys.findById(keyId);
  if (key === null || key.userId !== actor.userId)
    throw notFound(`customer key ${keyId} not found`);
  return key;
}

async function ownedOrder(
  deps: CustomerDeps,
  actor: CustomerActor,
  orderId: string,
): Promise<Order> {
  const order = await deps.orders.findById(orderId);
  if (order === null || order.userId !== actor.userId) {
    throw notFound(`customer order ${orderId} not found`);
  }
  return order;
}

function paymentUrlFor(deps: CustomerDeps, order: Order): string | null {
  if (order.status !== "pending_payment" || order.provider !== "pakasir") return null;
  const url = new URL(
    `${deps.env.PAKASIR_BASE_URL.replace(/\/+$/, "")}/pay/${encodeURIComponent(deps.env.PAKASIR_PROJECT)}/${order.amountIdr}`,
  );
  url.searchParams.set("order_id", order.id);
  url.searchParams.set("redirect", `${deps.env.PUBLIC_WEB_URL}/checkout/return`);
  return url.toString();
}

export function registerCustomerRoutes(app: FastifyInstance, deps: CustomerDeps): void {
  app.get("/v1/account", async (request) => {
    const actor = await requireCustomer(request, deps);
    const user = await deps.users.findPublicById(actor.userId);
    if (user === null) throw notFound(`customer user ${actor.userId} not found`);
    return accountResponse(actor, user);
  });

  app.get("/v1/account/quota", async (request) => {
    const actor = await requireCustomer(request, deps);
    const now = deps.clock.now();
    const keys = await deps.apiKeys.listActiveForUser(actor.userId, now);
    const balances = await Promise.all(keys.map((key) => deps.quota.trueBalance(key.id)));
    const total = keys.reduce((sum, key) => sum + key.quotaLimit, 0);
    const remaining = balances.reduce((sum, balance) => sum + balance, 0);
    const expiresAt = keys.reduce<Date | null>(
      (soonest, key) => (soonest === null || key.expiresAt < soonest ? key.expiresAt : soonest),
      null,
    );
    const usage = await deps.usage.totalsForUser(
      actor.userId,
      new Date(now.getTime() - KEY_VALIDITY_MS),
      now,
    );
    return {
      remaining,
      total,
      expiresAt: expiresAt?.toISOString() ?? null,
      activeKeyCount: keys.length,
      hasEstimatedUsage: usage.estimatedRequests > 0,
    };
  });

  app.get("/v1/account/usage", async (request) => {
    const actor = await requireCustomer(request, deps);
    const to = deps.clock.now();
    const from = new Date(to.getTime() - KEY_VALIDITY_MS);
    const buckets = await deps.usageQuery.seriesForUser(actor.userId, from, to, 3_600);
    return {
      bucketMinutes: 60,
      buckets: buckets.map((bucket) => ({
        at: bucket.at.toISOString(),
        weightedTokens: bucket.weightedTokens,
      })),
    };
  });

  app.get("/v1/packages", async () => {
    const [switches, models, rows] = await Promise.all([
      deps.killSwitches(),
      deps.models.listPublished(),
      deps.packages.listActiveWithStock(),
    ]);
    const salesEnabled = switches.adapterEnabled && models.length > 0;
    return {
      salesEnabled,
      stock: rows.map(({ package: item, stock }) => ({
        packageId: item.id,
        tokens: item.weightedTokenQuota,
        priceIdr: item.priceIdr,
        available: stock === null ? 0 : Math.max(0, stock.available - stock.reserved),
        enabled: item.active,
      })),
    };
  });

  app.get("/v1/keys", async (request) => {
    const actor = await requireCustomer(request, deps);
    const keys = await deps.apiKeys.listForUser(actor.userId);
    return { keys: keys.map(keyResponse) };
  });

  app.get("/v1/keys/top-up-candidates", async (request) => {
    const actor = await requireCustomer(request, deps);
    const keys = await deps.apiKeys.listActiveForUser(actor.userId, deps.clock.now());
    return {
      keys: keys
        .filter((key) => key.quotaRemaining > 0)
        .map((key) => ({
          keyId: key.id,
          masked: maskKey(key.prefix),
          quotaRemaining: key.quotaRemaining,
          expiresAt: key.expiresAt.toISOString(),
          maxTopUpTokens: Math.max(0, MAX_KEY_QUOTA - key.quotaRemaining),
        })),
    };
  });

  app.post<{ Params: { keyId: string } }>("/v1/keys/:keyId/reveal", async (request) => {
    const actor = await requireCustomer(request, deps);
    const key = await ownedKey(deps, actor, param(request.params.keyId, "keyId"));
    const plaintext = await revealApiKey({
      key: {
        id: key.id,
        prefix: key.prefix,
        ciphertext: key.encryptedKey,
        revokedAt: key.revokedAt,
      },
      actor: {
        userId: actor.userId,
        sessionId: actor.sessionId,
        ip: request.ip ?? null,
        userAgent:
          typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
      },
      keyring: deps.keyring,
      clock: deps.clock,
      audit: {
        record: async (entry) => {
          await deps.transact((tx) =>
            tx.audit.append({
              id: ulid(),
              actorType: "user",
              actorId: actor.userId,
              action: entry.action,
              targetType: "api_key",
              targetId: entry.apiKeyId,
              metadata: {
                sessionId: entry.sessionId,
                outcome: entry.outcome,
                reason: entry.reason,
              },
              createdAt: entry.at,
            }),
          );
        },
      },
    });
    return { keyId: key.id, plaintext, auditedAt: deps.clock.now().toISOString() };
  });

  app.post<{ Params: { keyId: string } }>("/v1/keys/:keyId/revoke", async (request) => {
    const actor = await requireCustomer(request, deps);
    const key = await ownedKey(deps, actor, param(request.params.keyId, "keyId"));
    const revoked = await deps.transact(async (tx) => {
      const result = await tx.apiKeys.revoke(key.id, deps.clock.now());
      if (result !== null) {
        await tx.audit.append({
          id: ulid(),
          actorType: "user",
          actorId: actor.userId,
          action: "api_key.revoked",
          targetType: "api_key",
          targetId: key.id,
          metadata: { sessionId: actor.sessionId },
          createdAt: deps.clock.now(),
        });
      }
      return result;
    });
    if (revoked === null) throw conflict(`customer key ${key.id} was already revoked`);
    return { ok: true };
  });

  app.get("/v1/orders", async (request) => {
    const actor = await requireCustomer(request, deps);
    const orders = await deps.orders.listForUser(actor.userId);
    const ids = await activatedIds(deps, orders);
    return {
      orders: orders.map((order) =>
        orderResponse(order, paymentUrlFor(deps, order), ids.get(order.id) ?? null),
      ),
    };
  });

  app.get<{ Params: { orderId: string } }>("/v1/orders/:orderId", async (request) => {
    const actor = await requireCustomer(request, deps);
    const order = await ownedOrder(deps, actor, param(request.params.orderId, "orderId"));
    const ids = await activatedIds(deps, [order]);
    return orderResponse(order, paymentUrlFor(deps, order), ids.get(order.id) ?? null);
  });

  app.get<{ Params: { orderId: string } }>("/v1/orders/:orderId/status", async (request) => {
    const actor = await requireCustomer(request, deps);
    const order = await ownedOrder(deps, actor, param(request.params.orderId, "orderId"));
    const ids = await activatedIds(deps, [order]);
    return {
      orderId: order.id,
      status: order.status,
      activatedKeyId: ids.get(order.id) ?? null,
      paymentUrl: paymentUrlFor(deps, order),
    };
  });

  app.post("/v1/orders", async (request) => {
    const actor = await requireCustomer(request, deps);
    const input = bodyObject(request.body);
    const packageId = stringField(input, "packageId");
    const intent = input.intent;
    if (intent !== "new_key" && intent !== "top_up") throw invalid("intent is invalid");
    const rawTarget = input.targetKeyId;
    const targetKeyId =
      rawTarget === null || rawTarget === undefined ? null : stringField(input, "targetKeyId");
    if (intent === "new_key" && targetKeyId !== null)
      throw invalid("targetKeyId must be null for new_key");
    if (intent === "top_up" && targetKeyId === null)
      throw invalid("targetKeyId is required for top_up");

    const created = await deps.transact(async (tx) => {
      const packageRow = await tx.packages.findById(packageId);
      if (packageRow === null || !packageRow.active)
        throw notFound(`package ${packageId} not found`);
      if (intent === "top_up") {
        const target = await tx.apiKeys.findById(targetKeyId as string);
        if (target === null || target.userId !== actor.userId)
          throw notFound("top-up target not found");
        if (
          target.status !== "active" ||
          target.expiresAt <= deps.clock.now() ||
          target.quotaRemaining <= 0
        ) {
          throw conflict("top-up target is not eligible");
        }
      }
      const stock = await tx.packages.lockStock(packageId);
      if (stock === null) throw conflict("package stock is not configured");
      const decision = reserveStock(
        {
          weightedTokenQuota: packageRow.weightedTokenQuota,
          available: stock.available,
          reserved: stock.reserved,
        },
        intent,
        deps.clock,
        { policy: DEFAULT_TOP_UP_STOCK_POLICY },
      );
      if (!decision.reserved) throw decision.error;
      const reserved = await tx.packages.reserveStock(
        packageId,
        decision.units,
        stock.version,
        deps.clock.now(),
      );
      if (!reserved.ok) throw conflict(`package stock reservation failed: ${reserved.reason}`);
      const order = await tx.orders.create({
        id: ulid(),
        userId: actor.userId,
        packageId,
        packageSnapshot: {
          packageId,
          weightedTokenQuota: packageRow.weightedTokenQuota,
          priceIdr: packageRow.priceIdr,
          maxKeyQuota: packageRow.maxKeyQuota,
          durationSeconds: packageRow.durationSeconds,
        },
        type: intent,
        targetApiKeyId: targetKeyId,
        amountIdr: packageRow.priceIdr,
        status: "pending_payment",
        stockReservationExpiresAt: decision.expiresAt,
        provider: "pakasir",
        providerTransactionId: null,
        createdAt: deps.clock.now(),
      });
      await tx.audit.append({
        id: ulid(),
        actorType: "user",
        actorId: actor.userId,
        action: "order.created",
        targetType: "order",
        targetId: order.id,
        metadata: { packageId, intent, targetKeyId },
        createdAt: deps.clock.now(),
      });
      return order;
    });

    const checkout = await deps.checkout(created);
    if (checkout.providerTransactionId !== null) {
      await deps.transact(async (tx) => {
        await tx.orders.attachProviderTransaction(
          created.id,
          "pakasir",
          checkout.providerTransactionId as string,
          deps.clock.now(),
        );
      });
    }
    const latest = await deps.orders.findById(created.id);
    return orderResponse(latest ?? created, checkout.paymentUrl);
  });

  app.post<{ Params: { orderId: string } }>("/v1/orders/:orderId/cancel", async (request) => {
    const actor = await requireCustomer(request, deps);
    const orderId = param(request.params.orderId, "orderId");
    const result = await deps.transact(async (tx) => {
      const order = await tx.orders.lockById(orderId);
      if (order === null || order.userId !== actor.userId) throw notFound("order not found");
      if (order.status !== "draft" && order.status !== "pending_payment") {
        throw conflict("order cannot be cancelled in its current state");
      }
      const cancelled = await tx.orders.markCancelled(order.id, deps.clock.now());
      if (cancelled === null) throw conflict("order changed while cancelling");
      // Customer-created pending orders reserve one unit. Release under the same
      // transaction and row lock; a failed CAS is handled as an idempotent no-op.
      const stock = await tx.packages.lockStock(order.packageId);
      if (stock !== null) {
        const released = await tx.packages.releaseStock(
          order.packageId,
          1,
          stock.version,
          deps.clock.now(),
        );
        if (!released.ok && released.reason !== "insufficient") {
          throw conflict("stock changed while cancelling");
        }
      }
      await tx.audit.append({
        id: ulid(),
        actorType: "user",
        actorId: actor.userId,
        action: "order.cancelled",
        targetType: "order",
        targetId: order.id,
        metadata: { sessionId: actor.sessionId },
        createdAt: deps.clock.now(),
      });
      return cancelled;
    });
    return { ok: true, orderId: result.id };
  });
}

export { accountResponse, keyResponse, orderResponse, paymentUrlFor };
