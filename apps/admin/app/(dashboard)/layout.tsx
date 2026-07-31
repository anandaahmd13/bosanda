/**
 * Authenticated chrome for every operator page.
 *
 * The admin role is asserted HERE for the whole route group, and again inside
 * each Server Action (actions.ts), because an action is independently reachable
 * and a layout check does not protect it.
 *
 * On failure this renders the neutral unauthorized state rather than redirecting
 * — a redirect to /login?next=/accounts would confirm that /accounts exists.
 */

import Link from "next/link";
import { cookies } from "next/headers";
import { Sidebar } from "../components/Sidebar";
import { Unauthorized } from "../components/Unauthorized";
import { CSRF_FIELD, csrfCookieName, generateCsrfToken, requireAdmin } from "../lib/session";
import { DATA_SOURCE_LABEL, USE_FIXTURES } from "../lib/api-mode";
import { logoutAction } from "../login/actions";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();
  if (session === null) return <Unauthorized />;

  const jar = await cookies();
  const existing = jar.get(csrfCookieName)?.value;
  const csrfToken = existing !== undefined && existing.length > 0 ? existing : generateCsrfToken();

  return (
    <>
      {/* Bypass block: first tab stop on every page (WCAG 2.4.1). */}
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <div className="shell">
        <Sidebar />

        <div className="content">
          <header className="topbar" aria-label="Session">
            <div className="topbar-titles">
              <span
                className={`source-badge ${USE_FIXTURES ? "source-fixture" : "source-live"}`}
                // Announced as part of the header so an operator cannot miss
                // that they are looking at fabricated numbers.
                title={
                  USE_FIXTURES
                    ? "Pages are rendering from local fixtures, not the admin API."
                    : "Pages are rendering from the admin API."
                }
              >
                {DATA_SOURCE_LABEL}
              </span>
            </div>

            <div className="topbar-actions">
              <span className="field-hint">
                Signed in as <strong>{session.username}</strong>
              </span>
              {/* Logout is a POST with CSRF: never a GET link (§12). */}
              <form action={logoutAction}>
                <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
                <button type="submit" className="btn btn-sm btn-ghost">
                  Sign out
                </button>
              </form>
            </div>
          </header>

          <main id="main">{children}</main>

          <footer className="field-hint" style={{ paddingBottom: 8 }}>
            All timestamps UTC. Money in integer rupiah. Prompt and response content is never stored
            or shown here (PLAN.md §16). <Link href="/audit">Audit log</Link>
          </footer>
        </div>
      </div>
    </>
  );
}
