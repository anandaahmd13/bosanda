/**
 * Dashboard shell: sidebar + content (DESIGN.md §2.3).
 *
 * The session gate lives here rather than in each page so a new route under
 * /dashboard cannot accidentally ship unauthenticated. `requireSessionCookie`
 * redirects to /login with a `next` hint, so nothing below this renders for a
 * signed-out visitor.
 */

import type { ReactNode } from "react";
import { requireSessionCookie } from "../lib/session";
import { DashboardNav } from "../components/DashboardNav";
import { FixtureBanner } from "../components/FixtureBanner";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await requireSessionCookie("/dashboard");

  return (
    <>
      <FixtureBanner />
      <div className="dash">
        <DashboardNav />
        {/* The landmark a keyboard user lands on from the skip link. */}
        <main id="main">{children}</main>
      </div>
    </>
  );
}
