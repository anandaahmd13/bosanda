/**
 * Fake hosted payment page. DEV FIXTURES ONLY.
 *
 * `fixtureCreatedOrder` points `paymentUrl` here so the §13 checkout flow can be
 * walked end to end locally without contacting a third party. It stands in for
 * the provider's hosted page: the customer arrives, "pays", and is bounced to
 * /checkout/return exactly as the real provider would bounce them.
 *
 * IT SETTLES NOTHING. There is no webhook here, no order mutation, and no key
 * activation — §13 activates only inside the idempotent transaction driven by a
 * verified webhook, and this page cannot produce one. Clicking "pay" moves the
 * browser and nothing else, which is precisely what a real provider return does
 * too. The order therefore stays `pending_payment` afterwards, and that is the
 * correct, honest outcome rather than a bug to paper over.
 *
 * It 404s outside fixture mode. A route that fabricates a payment step must not
 * be reachable in production even if something upstream hands out its URL, so
 * the guard lives here rather than relying on nobody linking to it.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { apiMode } from "../../lib/api";
import { FixtureBanner } from "../../components/FixtureBanner";
import { Card } from "../../components/Card";

export const metadata = { title: "Mock payment provider — Bosanda dev" };

export const dynamic = "force-dynamic";

export default async function MockProviderPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (apiMode() !== "fixtures") notFound();

  const params = await searchParams;
  const raw = params["order_id"];
  const orderId = typeof raw === "string" && raw !== "" ? raw : null;

  const returnHref =
    orderId === null
      ? "/checkout/return"
      : `/checkout/return?order_id=${encodeURIComponent(orderId)}`;

  return (
    <>
      <FixtureBanner />
      <main id="main" className="center-page">
        <Card>
          <h1 className="card__title">Mock payment provider</h1>
          <div className="alert alert--warning" role="status">
            This is not a payment page. Nothing is charged, and nothing about your order changes.
          </div>
          <p className="muted">
            The real flow sends you to the provider&apos;s hosted page here. This stand-in exists so
            the checkout journey can be walked locally without a third-party request.
          </p>
          <p className="muted">
            Continuing only returns your browser to Bosanda. Your order stays{" "}
            <strong>pending payment</strong>, because activation happens when a verified webhook
            arrives from the provider — a browser redirect is never treated as proof of payment.
          </p>
          {orderId === null ? (
            <p className="muted">
              No order id was passed in, so the return page will not be able to name a specific
              order.
            </p>
          ) : null}
          <div className="btn-row">
            <Link href={returnHref} className="btn btn--primary">
              Continue as if paid
            </Link>
            <Link
              href={
                orderId === null ? "/dashboard/orders" : `/orders/${encodeURIComponent(orderId)}`
              }
              className="btn btn--ghost"
            >
              Abandon and go back
            </Link>
          </div>
        </Card>
      </main>
    </>
  );
}
