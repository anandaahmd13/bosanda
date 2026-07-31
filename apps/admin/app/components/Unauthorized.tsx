/**
 * The unauthorized state (§16).
 *
 * Reveals NOTHING about what exists: identical output whether the visitor is
 * anonymous, has an expired session, or is a valid non-admin user. No record
 * count, no username, no hint that a given path is a real route. The only
 * affordance is a link to the login form.
 *
 * The caller must return this INSTEAD of the page content, and must not have
 * fetched anything first — otherwise timing differences leak existence.
 */

import Link from "next/link";

export function Unauthorized() {
  return (
    <main className="auth-wrap" id="main">
      <section className="card auth-card" aria-labelledby="unauth-title">
        <h1 id="unauth-title" style={{ fontSize: 20, marginBottom: 8 }}>
          Not available
        </h1>
        <p className="banner-body" style={{ marginBottom: 18 }}>
          This page is not available for your session.
        </p>
        <Link href="/login" className="btn btn-primary">
          Go to sign in
        </Link>
      </section>
    </main>
  );
}
