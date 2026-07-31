/**
 * Order status page (§13 steps 5-7). Also the provider's return target.
 *
 * This is the one page a paying customer lands on from an external redirect, so
 * two things matter more here than anywhere else:
 *
 *  - It must render correctly for a session that arrived via a top-level
 *    cross-site GET. That is why the session cookie is SameSite=Lax rather than
 *    Strict (see `establishSession` in lib/actions.ts): with Strict, a paying
 *    customer would land here signed out.
 *  - It must never treat its own page state as proof of payment. The status
 *    shown is whatever the gateway says, and the gateway only trusts the
 *    verified webhook (§13 "never trust the browser return").
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiError, getOrder } from "../../lib/api";
import { readCsrfToken, requireSessionCookie } from "../../lib/session";
import { Card } from "../../components/Card";
import { OrderStatusChip, orderStatusExplanation } from "../../components/Chip";
import { CancelOrderForm } from "../../components/CancelOrderForm";
import { FixtureBanner } from "../../components/FixtureBanner";
import { OrderStatusPoll } from "../../components/OrderStatusPoll";
import { formatIdr, formatTokensExact, formatUtc } from "../../lib/format";

export const metadata = { title: "Order — Bosanda" };

/** Status changes out of band via webhook; a cached render would lie. */
export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSessionCookie(`/orders/${id}`);

  let order;
  try {
    order = await getOrder(session, id);
  } catch (error) {
    // 404 and 403 are both rendered as "not found": confirming that an order ID
    // exists but belongs to someone else is an information leak.
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      notFound();
    }
    throw error;
  }

  const csrfToken = await readCsrfToken();
  const payable = order.status === "pending_payment" && order.paymentUrl !== null;
  const cancellable = order.status === "draft" || order.status === "pending_payment";

  return (
    <>
      <FixtureBanner />
      <main id="main" className="shell section">
        <div className="stack">
          <div>
            <p className="eyebrow">Order</p>
            <h1 className="mono" style={{ margin: 0 }}>
              {order.orderId}
            </h1>
          </div>

          <Card>
            <div className="row-between">
              <div>
                <OrderStatusChip status={order.status} />
                <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
                  {orderStatusExplanation(order.status)}
                </p>
                <OrderStatusPoll orderId={order.orderId} status={order.status} />
              </div>
              {payable && order.paymentUrl !== null ? (
                <a className="btn btn--primary" href={order.paymentUrl}>
                  Pay now
                </a>
              ) : null}
            </div>

            {order.status === "activated" && order.activatedKeyId !== null ? (
              <p style={{ marginBottom: 0 }}>
                <Link href="/dashboard/keys" className="btn btn--primary">
                  View your key
                </Link>
              </p>
            ) : null}

            {order.status === "review_required" ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                Nothing further is needed from you right now. An operator has to look at this one by
                hand. Quote the order ID above when you contact support.
              </p>
            ) : null}
          </Card>

          <Card>
            <h2 className="card__title">What you ordered</h2>
            {/* The immutable purchase snapshot (§11): what was agreed at
                checkout, not today's catalog price. */}
            <div className="table-wrap">
              <table className="data">
                <caption>Purchase snapshot, fixed when the order was created.</caption>
                <tbody>
                  <tr>
                    <th scope="row">Quota</th>
                    <td>{formatTokensExact(order.tokens)} weighted tokens</td>
                  </tr>
                  <tr>
                    <th scope="row">Price</th>
                    <td>{formatIdr(order.priceIdr)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Type</th>
                    <td>{order.intent === "top_up" ? "Top-up of an existing key" : "New key"}</td>
                  </tr>
                  {order.targetKeyId !== null ? (
                    <tr>
                      <th scope="row">Target key</th>
                      <td className="mono">{order.targetKeyId}</td>
                    </tr>
                  ) : null}
                  <tr>
                    <th scope="row">Created</th>
                    <td>{formatUtc(order.createdAt)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          {cancellable && csrfToken !== null ? (
            <Card className="card--tight">
              <h2 className="card__title">Cancel this order</h2>
              <p className="muted">
                Cancelling releases the reserved stock so someone else can buy it. You are not
                charged for a cancelled order.
              </p>
              <CancelOrderForm orderId={order.orderId} csrfToken={csrfToken} />
            </Card>
          ) : null}

          <p className="muted">
            <Link href="/dashboard/orders">Back to orders</Link>
          </p>
        </div>
      </main>
    </>
  );
}
