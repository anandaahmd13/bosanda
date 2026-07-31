"use server";

/**
 * Server Actions — every mutation in the dashboard.
 *
 * Invariants enforced here, uniformly, for all of them:
 *  1. CSRF token verified FIRST (§12). No GET ever mutates.
 *  2. Admin role asserted on every call — an action is a public endpoint, so
 *     checking only in the page that renders the button is not enough.
 *  3. A reason is required and forwarded for the audit log (§12).
 *  4. Outcomes are redirected back as `?status=`/`?error=` so the result is
 *     announced in an aria-live region and a reload does not re-POST.
 *
 * Nothing here ever echoes a credential, password, or key back to the caller.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertCsrf, CsrfError, requireAdmin } from "./session";
import * as api from "./api";
import { AdminApiError } from "./api";
import type { MutationResult } from "./schemas";

/** Reason is mandatory on every audited action. */
const reasonSchema = z
  .string()
  .trim()
  .min(4, "Give a reason of at least 4 characters.")
  .max(500, "Keep the reason under 500 characters.");

function readString(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

/**
 * Wraps an action body with the CSRF check, the admin assertion, and uniform
 * error-to-redirect handling.
 *
 * `redirect()` throws internally in Next, so it is called AFTER the try/catch
 * rather than inside it — otherwise the catch would swallow the redirect.
 */
async function run(
  formData: FormData,
  path: string,
  body: (reason: string) => Promise<MutationResult>,
): Promise<never> {
  let outcome: { ok: boolean; message: string };

  try {
    await assertCsrf(formData);

    const session = await requireAdmin();
    if (session === null) {
      // Deliberately vague: same message an expired session gets.
      outcome = { ok: false, message: "Not authorized." };
    } else {
      const parsedReason = reasonSchema.safeParse(readString(formData, "reason"));
      if (!parsedReason.success) {
        outcome = {
          ok: false,
          message: parsedReason.error.issues[0]?.message ?? "A reason is required.",
        };
      } else {
        outcome = await body(parsedReason.data);
      }
    }
  } catch (error) {
    if (error instanceof CsrfError) {
      outcome = { ok: false, message: error.message };
    } else if (error instanceof AdminApiError) {
      // Already classified and safe to render.
      outcome = { ok: false, message: error.message };
    } else if (error instanceof z.ZodError) {
      outcome = { ok: false, message: error.issues[0]?.message ?? "Invalid input." };
    } else {
      // Never surface an unknown error's text: it may contain internals.
      console.error("admin action failed", {
        path,
        name: error instanceof Error ? error.name : "unknown",
      });
      outcome = { ok: false, message: "Something went wrong. The change was not applied." };
    }
  }

  if (outcome.ok) revalidatePath(path);

  const params = new URLSearchParams(
    outcome.ok ? { status: outcome.message } : { error: outcome.message },
  );
  redirect(`${path}?${params.toString()}`);
}

/* ----------------------------------------------------------------- accounts */

const personaSchema = z.enum(["cli", "ide"]);

export async function createAccountAction(formData: FormData): Promise<void> {
  await run(formData, "/accounts", async (reason) => {
    const label = z.string().trim().min(1).max(64).parse(readString(formData, "label"));
    const region = z.string().trim().min(1).max(32).parse(readString(formData, "region"));
    const persona = personaSchema.parse(readString(formData, "persona"));
    // WRITE-ONLY: forwarded once, never read back, never logged.
    const credential = z
      .string()
      .min(1, "A credential is required.")
      .max(8192)
      .parse(readString(formData, "credential"));

    return api.createProviderAccount({ label, region, persona, credential, reason });
  });
}

export async function rotateCredentialAction(formData: FormData): Promise<void> {
  await run(formData, "/accounts", async (reason) => {
    const accountId = z.string().min(1).parse(readString(formData, "accountId"));
    const credential = z
      .string()
      .min(1, "A credential is required.")
      .max(8192)
      .parse(readString(formData, "credential"));
    return api.rotateProviderCredential({ accountId, credential, reason });
  });
}

export async function updateAccountAction(formData: FormData): Promise<void> {
  await run(formData, "/accounts", async (reason) => {
    const accountId = z.string().min(1).parse(readString(formData, "accountId"));
    const label = z.string().trim().min(1).max(64).parse(readString(formData, "label"));
    const region = z.string().trim().min(1).max(32).parse(readString(formData, "region"));
    const persona = personaSchema.parse(readString(formData, "persona"));
    return api.updateProviderAccount({ accountId, label, region, persona, reason });
  });
}

export async function setAccountEnabledAction(formData: FormData): Promise<void> {
  await run(formData, "/accounts", async (reason) => {
    const accountId = z.string().min(1).parse(readString(formData, "accountId"));
    const enabled = readString(formData, "enabled") === "true";
    return api.setProviderAccountEnabled({ accountId, enabled, reason });
  });
}

export async function validateAccountAction(formData: FormData): Promise<void> {
  await run(formData, "/accounts", async () => {
    const accountId = z.string().min(1).parse(readString(formData, "accountId"));
    return api.validateProviderAccount(accountId);
  });
}

/* ------------------------------------------------------------------- models */

export async function updateMultiplierAction(formData: FormData): Promise<void> {
  await run(formData, "/models", async (reason) => {
    const publicId = z.string().min(1).parse(readString(formData, "publicId"));
    const multiplier = z.coerce
      .number()
      .positive("The multiplier must be greater than zero.")
      .max(100, "That multiplier looks wrong — cap is 100.")
      .parse(readString(formData, "multiplier"));
    return api.updateModelMultiplier({ publicId, multiplier, reason });
  });
}

export async function setModelPublishedAction(formData: FormData): Promise<void> {
  await run(formData, "/models", async (reason) => {
    const publicId = z.string().min(1).parse(readString(formData, "publicId"));
    const published = readString(formData, "published") === "true";
    return api.setModelPublished({ publicId, published, reason });
  });
}

/* ----------------------------------------------------------------- packages */

export async function addStockAction(formData: FormData): Promise<void> {
  await run(formData, "/packages", async (reason) => {
    const packageId = z.string().min(1).parse(readString(formData, "packageId"));
    const delta = z.coerce
      .number()
      .int("Stock moves in whole units.")
      .refine((value) => value !== 0, "Enter a non-zero amount.")
      .parse(readString(formData, "delta"));
    return api.addPackageStock({ packageId, delta, reason });
  });
}

export async function updatePackageAction(formData: FormData): Promise<void> {
  await run(formData, "/packages", async (reason) => {
    const packageId = z.string().min(1).parse(readString(formData, "packageId"));
    // Integer rupiah only — never a float (§14).
    const priceIdr = z.coerce
      .number()
      .int("Price must be a whole number of rupiah.")
      .nonnegative()
      .parse(readString(formData, "priceIdr"));
    const active = readString(formData, "active") === "true";
    return api.updatePackage({ packageId, priceIdr, active, reason });
  });
}

/* ------------------------------------------------------------------- orders */

export async function activateOrderAction(formData: FormData): Promise<void> {
  const orderId = readString(formData, "orderId");
  await run(formData, `/orders/${encodeURIComponent(orderId)}`, async (reason) => {
    const id = z.string().min(1).parse(orderId);
    return api.activateOrder({ orderId: id, reason });
  });
}

export async function refundOrderAction(formData: FormData): Promise<void> {
  const orderId = readString(formData, "orderId");
  await run(formData, `/orders/${encodeURIComponent(orderId)}`, async (reason) => {
    const id = z.string().min(1).parse(orderId);
    return api.refundOrder({ orderId: id, reason });
  });
}

/* -------------------------------------------------------------------- users */

export async function setUserEnabledAction(formData: FormData): Promise<void> {
  const userId = readString(formData, "userId");
  await run(formData, `/users/${encodeURIComponent(userId)}`, async (reason) => {
    const id = z.string().min(1).parse(userId);
    const enabled = readString(formData, "enabled") === "true";
    return api.setUserEnabled({ userId: id, enabled, reason });
  });
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const userId = readString(formData, "userId");
  await run(formData, `/users/${encodeURIComponent(userId)}`, async (reason) => {
    const id = z.string().min(1).parse(userId);
    // Length floor only: complexity rules push operators toward predictable
    // patterns. The value is forwarded and never returned or logged.
    const newPassword = z
      .string()
      .min(12, "Use at least 12 characters.")
      .max(200)
      .parse(readString(formData, "newPassword"));
    return api.resetUserPassword({ userId: id, newPassword, reason });
  });
}

/* --------------------------------------------------------------------- keys */

export async function revokeKeyAction(formData: FormData): Promise<void> {
  await run(formData, "/keys", async (reason) => {
    const keyId = z.string().min(1).parse(readString(formData, "keyId"));
    return api.revokeKey({ keyId, reason });
  });
}

export async function adjustQuotaAction(formData: FormData): Promise<void> {
  await run(formData, "/keys", async (reason) => {
    const keyId = z.string().min(1).parse(readString(formData, "keyId"));
    const weightedTokensDelta = z.coerce
      .number()
      .int("Weighted tokens are whole numbers.")
      .refine((value) => value !== 0, "Enter a non-zero adjustment.")
      .parse(readString(formData, "weightedTokensDelta"));
    return api.adjustKeyQuota({ keyId, weightedTokensDelta, reason });
  });
}

/* -------------------------------------------------------------------- flags */

export async function setFlagAction(formData: FormData): Promise<void> {
  await run(formData, "/flags", async (reason) => {
    const key = z.string().min(1).parse(readString(formData, "key"));
    const enabled = readString(formData, "enabled") === "true";
    return api.setFlag({ key, enabled, reason });
  });
}
