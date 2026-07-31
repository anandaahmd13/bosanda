/**
 * /login — admin only (§15).
 *
 * No registration link, no password-recovery link, no "forgot password" flow:
 * §12 recovery is a manual admin action, and §1 forbids public registration on
 * this surface entirely. A user who needs a reset contacts the operator.
 *
 * Error messages are deliberately identical for unknown username, wrong
 * password, and valid-but-non-admin account.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { CSRF_FIELD, csrfCookieName, generateCsrfToken, requireAdmin } from "../lib/session";
import { DATA_SOURCE_LABEL, USE_FIXTURES } from "../lib/api-mode";
import { firstParam } from "../components/StatusRegion";
import { loginAction } from "./actions";

export const metadata: Metadata = { title: "Sign in — Bosanda operator console" };

const ERRORS: Record<string, string> = {
  invalid: "Those credentials were not accepted.",
  expired: "The form expired. Try again.",
  unavailable: "Sign-in is temporarily unavailable.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // An already-authenticated operator should not see a login form.
  if ((await requireAdmin()) !== null) redirect("/");

  const params = await searchParams;
  const errorKey = firstParam(params["error"]);
  const errorMessage = errorKey === undefined ? undefined : (ERRORS[errorKey] ?? ERRORS["invalid"]);

  /*
   * A page render cannot call cookies().set in Next 16 — only an action or route
   * handler can. So the token is minted here and written by the ACTION on the
   * first submit if the proxy-set cookie is somehow absent. Normally
   * `proxy.ts` has already set it and this reads the existing value.
   */
  const jar = await cookies();
  const existing = jar.get(csrfCookieName)?.value;
  const csrfToken = existing !== undefined && existing.length > 0 ? existing : generateCsrfToken();

  return (
    <main className="auth-wrap" id="main">
      <section className="card auth-card" aria-labelledby="login-title">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1 id="login-title" style={{ fontSize: 20 }}>
              Operator console
            </h1>
            <span className="brand-sub">admin.bosanda.dev</span>
          </div>
        </div>

        {USE_FIXTURES && (
          <div className="banner banner-warning" style={{ marginBottom: 16 }} role="note">
            <span className="banner-icon" aria-hidden="true">
              ⚑
            </span>
            <div>
              <div className="banner-title">{DATA_SOURCE_LABEL}</div>
              <p className="banner-body">
                No backend is wired up. Any non-empty username and password opens the dashboard with
                fabricated data.
              </p>
            </div>
          </div>
        )}

        {/* role="alert" so a failed attempt is announced immediately. */}
        <div role="alert" aria-live="assertive">
          {errorMessage !== undefined && (
            <div className="banner banner-danger" style={{ marginBottom: 16 }}>
              <span className="banner-icon" aria-hidden="true">
                !
              </span>
              <div>
                <p className="banner-body">{errorMessage}</p>
              </div>
            </div>
          )}
        </div>

        <form action={loginAction} className="stack">
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />

          <div className="field">
            <label className="field-label" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              name="username"
              className="input"
              type="text"
              required
              maxLength={64}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              // First field on a dedicated sign-in page: autofocus is the
              // expected behaviour and does not disorient.
              autoFocus
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              className="input"
              type="password"
              required
              maxLength={200}
              autoComplete="current-password"
            />
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
            Sign in
          </button>
        </form>

        <p className="field-hint" style={{ marginTop: 16, marginBottom: 0 }}>
          Operator accounts are created on the server with a one-time CLI command. There is no
          self-service registration or password reset on this host.
        </p>
      </section>
    </main>
  );
}
