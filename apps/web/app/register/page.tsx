import Link from "next/link";
import { AuthForm } from "../components/AuthForm";
import { Card } from "../components/Card";
import { registerAction } from "../lib/actions";
import { readCsrfToken } from "../lib/session";

/**
 * Create an account (PLAN.md §12 "Website accounts").
 *
 * §1 rules out guest checkout: an account exists before a purchase so the key,
 * its quota, and its order history have an owner.
 */

export const metadata = {
  title: "Create an account",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const csrfToken = await readCsrfToken();

  return (
    <main id="main" className="shell center-page">
      <Card className="auth-card">
        <h1 style={{ marginTop: 0 }}>Create an account</h1>
        <p className="muted">
          You need an account before buying — it is what your key and quota belong to. No email
          required.
        </p>

        <AuthForm mode="register" action={registerAction} csrfToken={csrfToken} />

        <hr className="divider" />

        <p className="muted" style={{ marginBottom: 0 }}>
          Choose a password you can retrieve. Recovery is manual and requires contacting support —
          there is no reset email, because we do not collect an address to send one to. See the{" "}
          <Link href="/docs">API docs</Link> for what happens after you buy.
        </p>
      </Card>
    </main>
  );
}
