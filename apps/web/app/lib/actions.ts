"use server";

/**
 * Server actions — every state-changing operation the browser can trigger.
 *
 * Rules that hold for all of them:
 *  - CSRF is checked FIRST, before any form value is read (§12).
 *  - They return a plain `{ error }` object for a user-fixable problem, and
 *    redirect on success. Nothing throws a raw gateway error into the page.
 *  - No credential, token, or plaintext key is ever returned from an action.
 *    The one reveal path returns a key to the component that asked for it and is
 *    audited server-side.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  ApiError,
  cancelOrder,
  createOrder,
  getOrderStatus,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  revealApiKey as apiRevealApiKey,
  revokeApiKey as apiRevokeApiKey,
} from "./api";
import type { OrderStatus } from "./schemas";
import { COOKIE_SECURE, SESSION_COOKIE, USE_FIXTURES } from "./env";
import { assertCsrf, readSessionCookie, requireSessionCookie } from "./session";

/** Session lifetime for the browser cookie. Matches the §11 key validity window. */
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

export type FormState = { error: string | null };

const CSRF_FAILURE: FormState = {
  error: "Your session could not be verified. Reload the page and try again.",
};

/**
 * Extracts the session value from the gateway's Set-Cookie header and re-issues
 * it under our own attributes.
 *
 * Relaying the upstream header verbatim would mean trusting it to have set
 * HttpOnly/Secure/SameSite correctly. Setting the cookie ourselves makes those
 * attributes a property of this app rather than of whatever the gateway sent.
 */
function sessionValueFrom(setCookie: string | null): string | null {
  if (setCookie === null) return null;
  for (const part of setCookie.split(/,(?=[^;]*=)/)) {
    const [pair] = part.trimStart().split(";");
    if (pair === undefined) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}

async function establishSession(setCookie: string | null): Promise<void> {
  // In fixtures mode there is no gateway to issue a session, so a clearly-fake
  // marker value is used. It authenticates nothing: every read is a fixture.
  const value = sessionValueFrom(setCookie) ?? (USE_FIXTURES ? "fixture-session" : null);
  if (value === null) return;

  const jar = await cookies();
  jar.set({
    name: SESSION_COOKIE,
    value,
    // Invisible to client JS: the whole reason authenticated reads happen in
    // server components (§12).
    httpOnly: true,
    secure: COOKIE_SECURE,
    // Lax so the top-level GET back from the payment provider (§13) still
    // arrives authenticated. No mutation is reachable by GET.
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/** Field-level validation mirroring what the server enforces, for a fast message. */
function credentialProblem(username: string, password: string): string | null {
  if (username.length < 3 || username.length > 32) {
    return "Username must be between 3 and 32 characters.";
  }
  if (!/^[a-z0-9_.-]+$/i.test(username)) {
    return "Username may only contain letters, numbers, dot, dash, and underscore.";
  }
  if (password.length < 12) {
    return "Password must be at least 12 characters.";
  }
  if (password.length > 200) {
    return "Password must be at most 200 characters.";
  }
  return null;
}

function readCredentials(form: FormData): { username: string; password: string } {
  const username = form.get("username");
  const password = form.get("password");
  return {
    username: typeof username === "string" ? username.trim() : "",
    password: typeof password === "string" ? password : "",
  };
}

/** Only same-origin absolute paths, so `?next=` cannot become an open redirect. */
function safeNext(value: FormDataEntryValue | null): string {
  if (typeof value !== "string") return "/dashboard";
  if (!value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

export async function loginAction(_previous: FormState, form: FormData): Promise<FormState> {
  if (!(await assertCsrf(form))) return CSRF_FAILURE;

  const { username, password } = readCredentials(form);
  if (username === "" || password === "") {
    return { error: "Enter your username and password." };
  }

  const outcome = await apiLogin(username, password);
  if (!outcome.ok) return { error: outcome.message };

  await establishSession(outcome.setCookie);
  redirect(safeNext(form.get("next")));
}

export async function registerAction(_previous: FormState, form: FormData): Promise<FormState> {
  if (!(await assertCsrf(form))) return CSRF_FAILURE;

  const { username, password } = readCredentials(form);
  const confirm = form.get("confirm");

  const problem = credentialProblem(username, password);
  if (problem !== null) return { error: problem };
  if (password !== (typeof confirm === "string" ? confirm : "")) {
    return { error: "The two passwords do not match." };
  }

  const outcome = await apiRegister(username, password);
  if (!outcome.ok) return { error: outcome.message };

  await establishSession(outcome.setCookie);
  redirect("/dashboard");
}

export async function logoutAction(form: FormData): Promise<void> {
  // A failed CSRF check must not leave the user stuck signed in, but it also
  // must not revoke a session on a forged request. Clearing only the local
  // cookie is the safe middle: harmless if forged, effective if genuine.
  const session = await readSessionCookie();
  const jar = await cookies();

  if (await assertCsrf(form)) {
    if (session !== null) await apiLogout(session);
  }

  jar.delete(SESSION_COOKIE);
  redirect("/");
}

export async function revokeKeyAction(form: FormData): Promise<FormState> {
  if (!(await assertCsrf(form))) return CSRF_FAILURE;

  const keyId = form.get("keyId");
  if (typeof keyId !== "string" || keyId === "") {
    return { error: "That key could not be identified." };
  }

  const session = await requireSessionCookie("/dashboard/keys");
  try {
    await apiRevokeApiKey(session, keyId);
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : "Could not revoke that key." };
  }

  revalidatePath("/dashboard/keys");
  return { error: null };
}

/**
 * Reveal a key's plaintext for the dashboard eye toggle.
 *
 * Returns the plaintext to the calling client component and nothing else. The
 * gateway writes the audit row (§12) — this action is only the transport, which
 * is why it cannot be satisfied from any cached or already-rendered payload.
 */
export async function revealKeyAction(
  keyId: string,
): Promise<{ plaintext: string; auditedAt: string } | { error: string }> {
  const session = await readSessionCookie();
  if (session === null) return { error: "Your session has expired. Please sign in again." };

  try {
    const revealed = await apiRevealApiKey(session, keyId);
    return { plaintext: revealed.plaintext, auditedAt: revealed.auditedAt };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : "Could not reveal that key." };
  }
}

/**
 * Create an order and hand off to the payment provider (§13 steps 3-5).
 *
 * Price and quota are NOT read from the form: §13 forbids trusting a
 * browser-supplied price, package, or quota. Only the package id and the intent
 * cross the boundary, and the server resolves everything else from its own
 * package record.
 */
export async function createOrderAction(_previous: FormState, form: FormData): Promise<FormState> {
  if (!(await assertCsrf(form))) return CSRF_FAILURE;

  const packageId = form.get("packageId");
  if (typeof packageId !== "string" || packageId === "") {
    return { error: "Choose a package size first." };
  }

  const intent = form.get("intent") === "top_up" ? "top_up" : "new_key";
  const rawTarget = form.get("targetKeyId");
  const targetKeyId = typeof rawTarget === "string" && rawTarget !== "" ? rawTarget : null;

  if (intent === "top_up" && targetKeyId === null) {
    return { error: "Choose which key to top up." };
  }

  const session = await requireSessionCookie("/checkout");

  let order;
  try {
    order = await createOrder(session, { packageId, intent, targetKeyId });
  } catch (error) {
    return {
      error: error instanceof ApiError ? error.message : "Could not start that order.",
    };
  }

  redirect(`/orders/${encodeURIComponent(order.orderId)}`);
}

/**
 * Read an order's current status for the return-page poll (§13 step 6-7).
 *
 * A read, not a mutation, so there is no CSRF check: it changes nothing, and it
 * is scoped to the caller's own session. It exists as a server action only
 * because the session cookie is HttpOnly and the browser therefore cannot
 * authenticate the gateway read itself.
 *
 * Returns null on any failure. The poll treats that as "no news" and tries
 * again, which is the right behaviour for a transient gateway blip — surfacing
 * an error banner mid-payment would be worse than staying quiet.
 */
export async function pollOrderStatusAction(
  orderId: string,
): Promise<{ status: OrderStatus; activatedKeyId: string | null } | null> {
  const session = await readSessionCookie();
  if (session === null) return null;

  try {
    const status = await getOrderStatus(session, orderId);
    return { status: status.status, activatedKeyId: status.activatedKeyId };
  } catch {
    return null;
  }
}

export async function cancelOrderAction(form: FormData): Promise<FormState> {
  if (!(await assertCsrf(form))) return CSRF_FAILURE;

  const orderId = form.get("orderId");
  if (typeof orderId !== "string" || orderId === "") {
    return { error: "That order could not be identified." };
  }

  const session = await requireSessionCookie("/dashboard/orders");
  try {
    await cancelOrder(session, orderId);
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : "Could not cancel that order." };
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/dashboard/orders");
  return { error: null };
}
