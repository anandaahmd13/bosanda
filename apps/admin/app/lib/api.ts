/**
 * THE server-call boundary for the admin dashboard.
 *
 * Every call to the backend lives here — one typed function per endpoint, each
 * zod-validating its response. No component fetches, and no component fakes
 * data inline. `USE_FIXTURES` (./api-mode.ts) picks the implementation, and the
 * header shows which one is active.
 *
 * SERVER-ONLY. Importing this into a client component would leak
 * `ADMIN_API_BASE_URL` and defeat the HttpOnly cookie model: the session cookie
 * is not readable from client JS, so authenticated reads MUST happen in server
 * components / route handlers that forward the cookie explicitly (§16).
 *
 * Paths match PLAN.md §15 capabilities under an /admin/v1 prefix on the
 * internal API. They are NOT public gateway routes (§8 owns /v1/*).
 */

import { cookies } from "next/headers";
import { z } from "zod";
import { API_BASE_URL, USE_FIXTURES } from "./api-mode";
import { sessionCookieName } from "./session";
import {
  adminSession,
  apiKeyList,
  auditList,
  flagList,
  healthReport,
  modelList,
  orderDetail,
  orderList,
  overview,
  packageList,
  providerAccountList,
  userDetail,
  userList,
  mutationResult,
  type AdminSession,
  type ApiKeySummary,
  type AuditEvent,
  type FlagList,
  type HealthReport,
  type Model,
  type MutationResult,
  type OrderDetail,
  type OrderStatus,
  type OrderSummary,
  type Overview,
  type PackageDefinition,
  type ProviderAccount,
  type AdminUser,
  type UserDetail,
} from "./schemas";
import {
  fixtureAccounts,
  fixtureAudit,
  fixtureFlags,
  fixtureHealth,
  fixtureKeys,
  fixtureModels,
  fixtureOrderDetail,
  fixtureOrders,
  fixtureOverview,
  fixturePackages,
  fixtureSession,
  fixtureUsers,
} from "./fixtures";

/**
 * A failure that is safe to render. The message is already classified — this
 * type never carries an upstream body (§16/§17).
 */
export class AdminApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

/** Maps a transport/status failure to an operator-safe classification. */
function classify(status: number): string {
  if (status === 401 || status === 403) return "Not authorized.";
  if (status === 404) return "Not found.";
  if (status === 409) return "The record changed while you were editing it. Reload and retry.";
  if (status === 429) return "Rate limited. Wait a moment and retry.";
  if (status >= 500) return "The admin API is unavailable.";
  return "The request was rejected.";
}

type Method = "GET" | "POST";

/**
 * The one place a network request is made.
 *
 * Forwards the HttpOnly session cookie so the backend can authorize. `no-store`
 * on every call: an operator dashboard must never render a cached view of
 * account health or kill-switch state.
 */
async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: { method?: Method; body?: unknown; sessionToken?: string },
): Promise<T> {
  const method: Method = init?.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };

  let token = init?.sessionToken;
  if (token === undefined) {
    const jar = await cookies();
    token = jar.get(sessionCookieName)?.value;
  }
  if (token !== undefined && token.length > 0) {
    // Forwarded as a cookie, matching how the backend reads operator sessions.
    headers["cookie"] = `${sessionCookieName}=${token}`;
  }
  if (init?.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      cache: "no-store",
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    // Never surface the raw cause: it can contain internal hostnames.
    throw new AdminApiError(503, "The admin API is unreachable.");
  }

  if (!response.ok) throw new AdminApiError(response.status, classify(response.status));

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AdminApiError(502, "The admin API returned a malformed response.");
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // The validation issues themselves are logged, not rendered: a `.strict()`
    // rejection could name a field the backend should not have sent.
    console.error("admin api response failed validation", {
      path,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    });
    throw new AdminApiError(502, "The admin API returned an unexpected response shape.");
  }
  return parsed.data;
}

/* --------------------------------------------------------------- pagination */

export type Page = { limit: number; offset: number };
const DEFAULT_PAGE: Page = { limit: 50, offset: 0 };

function paginate<T>(rows: readonly T[], page: Page): { rows: T[]; total: number } {
  return {
    rows: rows.slice(page.offset, page.offset + page.limit),
    total: rows.length,
  };
}

/* ------------------------------------------------------------------ session */

/** Validates an opaque session cookie. Live mode only; see session.ts. */
export async function fetchSession(sessionToken: string): Promise<AdminSession | null> {
  if (USE_FIXTURES) return adminSession.parse(fixtureSession);
  try {
    return await request("/admin/v1/session", adminSession, { sessionToken });
  } catch (error) {
    if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
      return null;
    }
    throw error;
  }
}

/**
 * Exchanges credentials for a session. Returns the opaque token for the caller
 * to place in the HttpOnly cookie — it is never returned to the browser as a
 * body value.
 */
export async function login(
  username: string,
  password: string,
): Promise<{ ok: true; token: string; expiresAt: string } | { ok: false }> {
  if (USE_FIXTURES) {
    // Dev convenience only, and deliberately not a credential check: fixture
    // mode is refused in production by api-mode.ts.
    if (username.length === 0 || password.length === 0) return { ok: false };
    return { ok: true, token: "fixture-session", expiresAt: fixtureSession.expiresAt };
  }

  const schema = z.object({
    token: z.string().min(1),
    expiresAt: z.string().datetime(),
  });
  try {
    const result = await request("/admin/v1/session", schema, {
      method: "POST",
      body: { username, password },
    });
    return { ok: true, token: result.token, expiresAt: result.expiresAt };
  } catch (error) {
    if (error instanceof AdminApiError && error.status >= 500) throw error;
    // Any 4xx is reported identically: no user enumeration.
    return { ok: false };
  }
}

export async function logout(): Promise<void> {
  if (USE_FIXTURES) return;
  try {
    await request("/admin/v1/session/revoke", mutationResult, { method: "POST" });
  } catch {
    // A failed server-side revoke must not block clearing the local cookie.
  }
}

/* ----------------------------------------------------------------- overview */

export async function getOverview(): Promise<Overview> {
  if (USE_FIXTURES) return overview.parse(fixtureOverview);
  return request("/admin/v1/overview", overview);
}

/* ----------------------------------------------------------------- accounts */

export async function listProviderAccounts(): Promise<ProviderAccount[]> {
  if (USE_FIXTURES) return providerAccountList.parse({ accounts: fixtureAccounts }).accounts;
  return (await request("/admin/v1/provider-accounts", providerAccountList)).accounts;
}

export async function getProviderAccount(id: string): Promise<ProviderAccount | null> {
  const accounts = await listProviderAccounts();
  return accounts.find((account) => account.id === id) ?? null;
}

/**
 * Creates an account. `credential` is WRITE-ONLY: it is forwarded once and
 * never read back by any endpoint in this module (§16).
 */
export async function createProviderAccount(input: {
  label: string;
  region: string;
  persona: "cli" | "ide";
  credential: string;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return { ok: true, message: `Account ${input.label} would be created (fixture mode).` };
  }
  return request("/admin/v1/provider-accounts", mutationResult, {
    method: "POST",
    body: input,
  });
}

/** Rotates the stored credential. Write-only, same as creation. */
export async function rotateProviderCredential(input: {
  accountId: string;
  credential: string;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return { ok: true, message: "Credential would be rotated (fixture mode)." };
  }
  return request(
    `/admin/v1/provider-accounts/${encodeURIComponent(input.accountId)}/credential`,
    mutationResult,
    { method: "POST", body: { credential: input.credential, reason: input.reason } },
  );
}

export async function updateProviderAccount(input: {
  accountId: string;
  label: string;
  region: string;
  persona: "cli" | "ide";
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) return { ok: true, message: "Account would be updated (fixture mode)." };
  return request(
    `/admin/v1/provider-accounts/${encodeURIComponent(input.accountId)}`,
    mutationResult,
    { method: "POST", body: input },
  );
}

export async function setProviderAccountEnabled(input: {
  accountId: string;
  enabled: boolean;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return {
      ok: true,
      message: `Account would be ${input.enabled ? "enabled" : "disabled"} (fixture mode).`,
    };
  }
  return request(
    `/admin/v1/provider-accounts/${encodeURIComponent(input.accountId)}/enabled`,
    mutationResult,
    { method: "POST", body: { enabled: input.enabled, reason: input.reason } },
  );
}

export async function validateProviderAccount(accountId: string): Promise<MutationResult> {
  if (USE_FIXTURES) return { ok: true, message: "Validation probe queued (fixture mode)." };
  return request(
    `/admin/v1/provider-accounts/${encodeURIComponent(accountId)}/validate`,
    mutationResult,
    { method: "POST" },
  );
}

/* ------------------------------------------------------------------- models */

export async function listModels(): Promise<Model[]> {
  if (USE_FIXTURES) return modelList.parse({ models: fixtureModels }).models;
  return (await request("/admin/v1/models", modelList)).models;
}

export async function getModel(publicId: string): Promise<Model | null> {
  const models = await listModels();
  return models.find((model) => model.publicId === publicId) ?? null;
}

/**
 * Updates a multiplier. The backend assigns the next `multiplierVersion` and an
 * effective timestamp; historical usage rows are never rewritten (§9).
 */
export async function updateModelMultiplier(input: {
  publicId: string;
  multiplier: number;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return {
      ok: true,
      message: `Multiplier for ${input.publicId} would become ${input.multiplier} going forward (fixture mode).`,
    };
  }
  return request(
    `/admin/v1/models/${encodeURIComponent(input.publicId)}/multiplier`,
    mutationResult,
    { method: "POST", body: { multiplier: input.multiplier, reason: input.reason } },
  );
}

export async function setModelPublished(input: {
  publicId: string;
  published: boolean;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return {
      ok: true,
      message: `${input.publicId} would be ${input.published ? "published" : "unpublished"} (fixture mode).`,
    };
  }
  return request(
    `/admin/v1/models/${encodeURIComponent(input.publicId)}/published`,
    mutationResult,
    { method: "POST", body: { published: input.published, reason: input.reason } },
  );
}

/* ----------------------------------------------------------------- packages */

export async function listPackages(): Promise<PackageDefinition[]> {
  if (USE_FIXTURES) return packageList.parse({ packages: fixturePackages }).packages;
  return (await request("/admin/v1/packages", packageList)).packages;
}

export async function addPackageStock(input: {
  packageId: string;
  delta: number;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return { ok: true, message: `Stock would change by ${input.delta} (fixture mode).` };
  }
  return request(
    `/admin/v1/packages/${encodeURIComponent(input.packageId)}/stock`,
    mutationResult,
    { method: "POST", body: { delta: input.delta, reason: input.reason } },
  );
}

export async function updatePackage(input: {
  packageId: string;
  priceIdr: number;
  active: boolean;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) return { ok: true, message: "Package would be updated (fixture mode)." };
  return request(`/admin/v1/packages/${encodeURIComponent(input.packageId)}`, mutationResult, {
    method: "POST",
    body: input,
  });
}

/* ------------------------------------------------------------------- orders */

export async function listOrders(filter?: {
  status?: OrderStatus | "all";
  query?: string;
  page?: Page;
}): Promise<{ orders: OrderSummary[]; total: number }> {
  const page = filter?.page ?? DEFAULT_PAGE;
  if (USE_FIXTURES) {
    const status = filter?.status;
    const query = filter?.query?.trim().toLowerCase() ?? "";
    const filtered = fixtureOrders.filter((order) => {
      const statusOk = status === undefined || status === "all" || order.status === status;
      const queryOk =
        query.length === 0 ||
        order.username.toLowerCase().includes(query) ||
        order.id.toLowerCase().includes(query) ||
        (order.providerTransactionId ?? "").toLowerCase().includes(query);
      return statusOk && queryOk;
    });
    const { rows, total } = paginate(filtered, page);
    const validated = orderList.parse({ orders: rows, total });
    return { orders: validated.orders, total: validated.total };
  }

  const params = new URLSearchParams({
    limit: String(page.limit),
    offset: String(page.offset),
  });
  if (filter?.status !== undefined && filter.status !== "all") {
    params.set("status", filter.status);
  }
  if (filter?.query !== undefined && filter.query.length > 0) params.set("q", filter.query);
  return request(`/admin/v1/orders?${params.toString()}`, orderList);
}

export async function getOrder(orderId: string): Promise<OrderDetail | null> {
  if (USE_FIXTURES) {
    const detail = fixtureOrderDetail(orderId);
    return detail === null ? null : orderDetail.parse(detail);
  }
  try {
    return await request(`/admin/v1/orders/${encodeURIComponent(orderId)}`, orderDetail);
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) return null;
    throw error;
  }
}

/** Manual activation for a stuck-but-paid order. Idempotent server-side (§13). */
export async function activateOrder(input: {
  orderId: string;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return { ok: true, message: `Order ${input.orderId} would be activated (fixture mode).` };
  }
  return request(`/admin/v1/orders/${encodeURIComponent(input.orderId)}/activate`, mutationResult, {
    method: "POST",
    body: { reason: input.reason },
  });
}

/**
 * Records a refund as a ledger ADJUSTMENT (§13). History is never deleted, so
 * this appends a negative entry rather than removing the purchase.
 */
export async function refundOrder(input: {
  orderId: string;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return {
      ok: true,
      message: "A refund ADJUSTMENT would be appended to the ledger (fixture mode).",
    };
  }
  return request(`/admin/v1/orders/${encodeURIComponent(input.orderId)}/refund`, mutationResult, {
    method: "POST",
    body: { reason: input.reason },
  });
}

/* -------------------------------------------------------------------- users */

export async function listUsers(filter?: {
  query?: string;
  page?: Page;
}): Promise<{ users: AdminUser[]; total: number }> {
  const page = filter?.page ?? DEFAULT_PAGE;
  if (USE_FIXTURES) {
    const query = filter?.query?.trim().toLowerCase() ?? "";
    const filtered = fixtureUsers.filter(
      (user) => query.length === 0 || user.username.toLowerCase().includes(query),
    );
    const { rows, total } = paginate(filtered, page);
    const validated = userList.parse({ users: rows, total });
    return { users: validated.users, total: validated.total };
  }
  const params = new URLSearchParams({
    limit: String(page.limit),
    offset: String(page.offset),
  });
  if (filter?.query !== undefined && filter.query.length > 0) params.set("q", filter.query);
  return request(`/admin/v1/users?${params.toString()}`, userList);
}

export async function getUser(userId: string): Promise<UserDetail | null> {
  if (USE_FIXTURES) {
    const user = fixtureUsers.find((candidate) => candidate.id === userId);
    if (user === undefined) return null;
    return userDetail.parse({
      user,
      keys: fixtureKeys.filter((key) => key.userId === userId),
    });
  }
  try {
    return await request(`/admin/v1/users/${encodeURIComponent(userId)}`, userDetail);
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) return null;
    throw error;
  }
}

export async function setUserEnabled(input: {
  userId: string;
  enabled: boolean;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return {
      ok: true,
      message: `User would be ${input.enabled ? "enabled" : "disabled"} (fixture mode).`,
    };
  }
  return request(`/admin/v1/users/${encodeURIComponent(input.userId)}/enabled`, mutationResult, {
    method: "POST",
    body: { enabled: input.enabled, reason: input.reason },
  });
}

/**
 * Admin-initiated password reset (§12).
 *
 * The new password is sent to the backend and NEVER returned or rendered. The
 * backend revokes all of the user's sessions and writes an audit row. The old
 * password is never revealed because only an Argon2id hash is stored.
 */
export async function resetUserPassword(input: {
  userId: string;
  newPassword: string;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return {
      ok: true,
      message: "Password would be reset and all sessions revoked (fixture mode).",
    };
  }
  return request(`/admin/v1/users/${encodeURIComponent(input.userId)}/password`, mutationResult, {
    method: "POST",
    body: { newPassword: input.newPassword, reason: input.reason },
  });
}

/* --------------------------------------------------------------------- keys */

/**
 * Looks up keys by PREFIX or by LOOKUP DIGEST only — never by plaintext (§12).
 * A plaintext key must never reach this process, so there is no parameter for
 * one.
 */
export async function searchKeys(filter?: {
  prefix?: string;
  lookupDigest?: string;
  page?: Page;
}): Promise<{ keys: ApiKeySummary[]; total: number }> {
  const page = filter?.page ?? DEFAULT_PAGE;
  if (USE_FIXTURES) {
    const prefix = filter?.prefix?.trim().toLowerCase() ?? "";
    const digest = filter?.lookupDigest?.trim() ?? "";
    const filtered = fixtureKeys.filter((key) => {
      if (digest.length > 0) {
        // Fixtures store no digest; a digest search matches nothing, which is
        // the honest behaviour rather than a fake hit.
        return false;
      }
      return prefix.length === 0 || key.prefix.toLowerCase().includes(prefix);
    });
    const { rows, total } = paginate(filtered, page);
    const validated = apiKeyList.parse({ keys: rows, total });
    return { keys: validated.keys, total: validated.total };
  }

  const params = new URLSearchParams({
    limit: String(page.limit),
    offset: String(page.offset),
  });
  if (filter?.prefix !== undefined && filter.prefix.length > 0) {
    params.set("prefix", filter.prefix);
  }
  if (filter?.lookupDigest !== undefined && filter.lookupDigest.length > 0) {
    params.set("lookup_digest", filter.lookupDigest);
  }
  return request(`/admin/v1/api-keys?${params.toString()}`, apiKeyList);
}

export async function revokeKey(input: { keyId: string; reason: string }): Promise<MutationResult> {
  if (USE_FIXTURES) return { ok: true, message: "Key would be revoked (fixture mode)." };
  return request(`/admin/v1/api-keys/${encodeURIComponent(input.keyId)}/revoke`, mutationResult, {
    method: "POST",
    body: { reason: input.reason },
  });
}

/** Manual quota adjustment. Written as an append-only ledger row (§10). */
export async function adjustKeyQuota(input: {
  keyId: string;
  weightedTokensDelta: number;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return {
      ok: true,
      message: `An ADJUSTMENT of ${input.weightedTokensDelta} would be appended to the ledger (fixture mode).`,
    };
  }
  return request(`/admin/v1/api-keys/${encodeURIComponent(input.keyId)}/quota`, mutationResult, {
    method: "POST",
    body: { weightedTokensDelta: input.weightedTokensDelta, reason: input.reason },
  });
}

/* -------------------------------------------------------------------- flags */

export async function listFlags(): Promise<FlagList> {
  if (USE_FIXTURES) {
    return flagList.parse({
      flags: fixtureFlags,
      kiroDirectEnabled: fixtureOverview.killSwitchSummary.kiroDirectEnabled,
    });
  }
  return request("/admin/v1/flags", flagList);
}

export async function setFlag(input: {
  key: string;
  enabled: boolean;
  reason: string;
}): Promise<MutationResult> {
  if (USE_FIXTURES) {
    return {
      ok: true,
      message: `${input.key} would be ${input.enabled ? "enabled" : "DISABLED"} (fixture mode).`,
    };
  }
  return request(`/admin/v1/flags/${encodeURIComponent(input.key)}`, mutationResult, {
    method: "POST",
    body: { enabled: input.enabled, reason: input.reason },
  });
}

/* -------------------------------------------------------------------- audit */

export async function listAudit(filter?: {
  actor?: string;
  action?: string;
  targetType?: string;
  page?: Page;
}): Promise<{ events: AuditEvent[]; total: number }> {
  const page = filter?.page ?? DEFAULT_PAGE;
  if (USE_FIXTURES) {
    const actor = filter?.actor?.trim().toLowerCase() ?? "";
    const action = filter?.action?.trim().toLowerCase() ?? "";
    const targetType = filter?.targetType?.trim().toLowerCase() ?? "";
    const filtered = fixtureAudit.filter((event) => {
      const actorOk = actor.length === 0 || event.actorLabel.toLowerCase().includes(actor);
      const actionOk = action.length === 0 || event.action.toLowerCase().includes(action);
      const targetOk = targetType.length === 0 || event.targetType.toLowerCase() === targetType;
      return actorOk && actionOk && targetOk;
    });
    const { rows, total } = paginate(filtered, page);
    const validated = auditList.parse({ events: rows, total });
    return { events: validated.events, total: validated.total };
  }

  const params = new URLSearchParams({
    limit: String(page.limit),
    offset: String(page.offset),
  });
  if (filter?.actor !== undefined && filter.actor.length > 0) params.set("actor", filter.actor);
  if (filter?.action !== undefined && filter.action.length > 0) {
    params.set("action", filter.action);
  }
  if (filter?.targetType !== undefined && filter.targetType.length > 0) {
    params.set("target_type", filter.targetType);
  }
  return request(`/admin/v1/audit?${params.toString()}`, auditList);
}

/* ------------------------------------------------------------------- health */

export async function getHealth(): Promise<HealthReport> {
  if (USE_FIXTURES) return healthReport.parse(fixtureHealth);
  return request("/admin/v1/health", healthReport);
}
