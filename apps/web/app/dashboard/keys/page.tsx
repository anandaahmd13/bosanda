/**
 * API keys (§12: "keys are displayed masked by default", revocable, rotatable).
 *
 * The list read happens here on the server and returns masked values only. The
 * per-row reveal and revoke controls are client components because they are
 * user-initiated actions with confirmation and state — see `KeyRow`.
 */

import Link from "next/link";
import { listApiKeys } from "../../lib/api";
import { readCsrfToken, requireSessionCookie } from "../../lib/session";
import { Card } from "../../components/Card";
import { KeyRow } from "../../components/KeyRow";
import { StatusRegion } from "../../components/StatusRegion";

export const metadata = { title: "API keys — Bosanda" };

/** Authenticated and per-user: never prerendered, never cached. */
export const dynamic = "force-dynamic";

export default async function KeysPage() {
  const session = await requireSessionCookie("/dashboard/keys");
  const [keys, csrfToken] = await Promise.all([listApiKeys(session), readCsrfToken()]);

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1 style={{ margin: 0 }}>API keys</h1>
          <p className="lede">Keys are shown masked. Revealing one is recorded in the audit log.</p>
        </div>
        <Link href="/checkout" className="btn btn--primary">
          Buy quota
        </Link>
      </div>

      {csrfToken === null ? (
        <StatusRegion
          tone="warning"
          assertive
          message="This page could not be verified, so revoking is disabled. Reload to continue."
        />
      ) : null}

      {keys.length === 0 ? (
        <Card>
          <h2 className="card__title">No keys yet</h2>
          <p className="muted">
            A key is issued when an order is paid and activated. It carries the quota you bought and
            is valid for 24 hours from payment.
          </p>
          <Link href="/checkout" className="btn btn--primary">
            Buy quota
          </Link>
        </Card>
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <caption>
                Your keys, newest first. Quota is in weighted tokens; timestamps are UTC.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Quota remaining
                  </th>
                  <th scope="col">Expires</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    {/* The column holds only buttons; each button names itself. */}
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((apiKey) => (
                  <KeyRow key={apiKey.keyId} apiKey={apiKey} csrfToken={csrfToken} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="card--tight">
        <h2 className="card__title">Keeping a key safe</h2>
        <p className="muted">
          A key is a bearer credential: anyone holding it can spend your quota. Bosanda stores it
          encrypted and can show it to you, but cannot tell you who else has seen it. If you suspect
          a key has leaked, revoke it — remaining quota is not refunded, so revoke early rather than
          late.
        </p>
      </Card>
    </div>
  );
}
