/**
 * Checkout (§13 steps 1-3: choose, create the order, hand off to the provider).
 *
 * This page only reads and renders. Creating the order is `createOrderAction`,
 * which POSTs and then redirects to /orders/[id] — so a refresh here never
 * re-creates an order and never re-reserves stock.
 *
 * §12: no guest checkout. The layout-level gate does not apply to /checkout, so
 * the session is required explicitly here.
 */

import Link from "next/link";
import { getStorefront, listTopUpCandidates } from "../lib/api";
import { readCsrfToken, requireSessionCookie } from "../lib/session";
import { Card } from "../components/Card";
import { CheckoutForm } from "../components/CheckoutForm";
import { FixtureBanner } from "../components/FixtureBanner";
import { StatusRegion } from "../components/StatusRegion";
import { VALIDITY_HOURS } from "../lib/packages";

export const metadata = { title: "Checkout — Bosanda" };

/** Stock changes underneath this page; a cached copy would oversell. */
export const dynamic = "force-dynamic";

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionCookie("/checkout");
  const [params, storefront, candidates, csrfToken] = await Promise.all([
    searchParams,
    getStorefront(),
    listTopUpCandidates(session),
    readCsrfToken(),
  ]);

  const raw = params["package"];
  const initialPackageId = typeof raw === "string" ? raw : null;

  return (
    <>
      <FixtureBanner />
      <main id="main" className="shell section">
        <div className="stack">
          <div>
            <p className="eyebrow">Checkout</p>
            <h1 style={{ margin: 0 }}>Buy quota</h1>
            <p className="lede">
              Pick a size, then choose whether to issue a new key or add the quota to a key you
              already have. A new key is valid for {VALIDITY_HOURS} hours from confirmed payment.
            </p>
          </div>

          {!storefront.salesEnabled ? (
            <StatusRegion
              tone="warning"
              assertive
              message="Sales are paused right now. Nothing can be purchased until they resume."
            />
          ) : null}

          <Card>
            {storefront.salesEnabled ? (
              <CheckoutForm
                stock={storefront.stock}
                candidates={candidates}
                csrfToken={csrfToken}
                initialPackageId={initialPackageId}
              />
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                <Link href="/">Back to packages</Link>
              </p>
            )}
          </Card>

          <Card className="card--tight">
            <h2 className="card__title">What happens next</h2>
            <ol className="muted" style={{ margin: 0, paddingLeft: "1.2em" }}>
              <li>The order is created and stock is reserved for it.</li>
              <li>You are sent to the payment provider to pay.</li>
              <li>
                When payment is confirmed, the quota is activated on your key and the{" "}
                {VALIDITY_HOURS}
                -hour window starts.
              </li>
            </ol>
            <p className="muted" style={{ marginBottom: 0 }}>
              If payment does not arrive before the reservation expires, the order is cancelled and
              the stock is released. You are never charged for a cancelled order.
            </p>
          </Card>
        </div>
      </main>
    </>
  );
}
