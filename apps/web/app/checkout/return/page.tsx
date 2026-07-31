/**
 * Payment provider return target (§13 step 5-6).
 *
 * The provider redirects the customer's browser here after payment. This page
 * deliberately does almost nothing: it resolves which order the return refers to
 * and forwards to /orders/[id], which reads the real status from the gateway.
 *
 * IT MUST NOT TREAT THE RETURN AS PROOF OF PAYMENT. §13 activates a key only in
 * the idempotent transaction driven by the verified webhook, and explicitly says
 * never to trust browser-supplied payment data. Anyone can type this URL with any
 * query string, so nothing here reads a status, an amount, or a success flag from
 * the query — only the order id, which is then authorised server-side by
 * /orders/[id] against the caller's own session.
 *
 * A redirect rather than a render, so the customer's history lands on the order
 * page and a refresh does not replay a provider return URL.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { FixtureBanner } from "../../components/FixtureBanner";
import { Card } from "../../components/Card";

export const metadata = { title: "Returning from payment — Bosanda" };

export const dynamic = "force-dynamic";

/** Accepted spellings of the order id, in the order they are tried. */
const ORDER_ID_KEYS = ["order_id", "orderId", "order"] as const;

function readOrderId(params: Record<string, string | string[] | undefined>): string | null {
  for (const key of ORDER_ID_KEYS) {
    const value = params[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

export default async function CheckoutReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const orderId = readOrderId(params);

  if (orderId !== null) {
    redirect(`/orders/${encodeURIComponent(orderId)}`);
  }

  // No order id in the return URL. Rather than guess, send the customer somewhere
  // they can find the order themselves — their payment is unaffected either way,
  // since activation is driven by the webhook and not by this page.
  return (
    <>
      <FixtureBanner />
      <main id="main" className="center-page">
        <Card>
          <h1 className="card__title">Payment received, checking your order</h1>
          <p className="muted">
            We could not tell which order this return refers to. If you completed a payment, it is
            still being processed — activation happens on our side and does not depend on this page.
          </p>
          <p className="muted">Open your orders to see the current status.</p>
          <Link href="/dashboard/orders" className="btn btn--primary">
            View my orders
          </Link>
        </Card>
      </main>
    </>
  );
}
