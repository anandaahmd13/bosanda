import { AuthForm } from "../components/AuthForm";
import { Card } from "../components/Card";
import { loginAction } from "../lib/actions";
import { SUPPORT_CHANNEL } from "../lib/env";
import { readCsrfToken } from "../lib/session";

/**
 * Sign in (PLAN.md §12 "Website accounts").
 *
 * Username + password only — §12 does not require an email in v1, and there is
 * deliberately no self-service password reset: recovery is manual, admin-
 * initiated, and audited. Saying that plainly here is better than offering a
 * "Forgot password?" link that leads nowhere.
 */

export const metadata = {
  title: "Sign in",
  // A sign-in page has no business in an index, and §16 favours withholding
  // surface area.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const csrfToken = await readCsrfToken();
  const { next } = await searchParams;

  return (
    <main id="main" className="shell center-page">
      <Card className="auth-card">
        <h1 style={{ marginTop: 0 }}>Sign in</h1>
        <p className="muted">Your dashboard holds your keys, quota, and order history.</p>

        <AuthForm mode="login" action={loginAction} csrfToken={csrfToken} next={next} />

        <hr className="divider" />

        <p className="muted" style={{ marginBottom: 0 }}>
          Locked out? There is no automatic password reset. Contact {SUPPORT_CHANNEL} — an operator
          verifies your identity and sets a one-time password manually, and the change is recorded
          in our audit log.
        </p>
      </Card>
    </main>
  );
}
