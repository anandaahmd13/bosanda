"use server";

/**
 * Admin login / logout (§12, §16).
 *
 * There is NO registration action here and no public registration route
 * anywhere in this app — the first admin is created by a one-time CLI command on
 * the VPS (§15 "Admin bootstrap").
 *
 * The session token goes straight into an HttpOnly cookie and is never returned
 * to the browser as a body value, so client JS can never read it.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import * as api from "../lib/api";
import {
  assertCsrf,
  cookieOptions,
  CsrfError,
  csrfCookieName,
  generateCsrfToken,
  sessionCookieName,
} from "../lib/session";

const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

export async function loginAction(formData: FormData): Promise<void> {
  let failed = false;

  try {
    await assertCsrf(formData);

    const parsed = credentialsSchema.safeParse({
      username: formData.get("username"),
      password: formData.get("password"),
    });

    if (!parsed.success) {
      failed = true;
    } else {
      const result = await api.login(parsed.data.username, parsed.data.password);
      if (result.ok) {
        const jar = await cookies();
        jar.set(sessionCookieName, result.token, {
          ...cookieOptions,
          expires: new Date(result.expiresAt),
        });
        // Session rotation on login (§12): a fresh CSRF token too, so a token
        // captured pre-authentication cannot be replayed against the session.
        jar.set(csrfCookieName, generateCsrfToken(), cookieOptions);
      } else {
        failed = true;
      }
    }
  } catch (error) {
    if (error instanceof CsrfError) {
      redirect("/login?error=expired");
    }
    console.error("admin login failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
    redirect("/login?error=unavailable");
  }

  // Outside the try: redirect() throws internally and must not be caught.
  //
  // One generic failure for bad username, bad password, and non-admin role — no
  // user enumeration, and no signal about which admin accounts exist.
  if (failed) redirect("/login?error=invalid");
  redirect("/");
}

export async function logoutAction(formData: FormData): Promise<void> {
  let csrfOk = true;
  try {
    await assertCsrf(formData);
  } catch {
    csrfOk = false;
  }

  if (csrfOk) {
    await api.logout();
    const jar = await cookies();
    jar.delete(sessionCookieName);
  }

  redirect("/login");
}
