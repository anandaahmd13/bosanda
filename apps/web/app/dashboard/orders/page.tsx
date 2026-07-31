/**
 * Order history (§13 order states, §11 purchase snapshot).
 *
 * Read-only. Every row links to /orders/[id], which is where cancelling and
 * payment hand-off live — a list of rows each carrying its own mutating form
 * would be a much wider CSRF surface for no benefit.
 *
 * The price and token figures rendered here come from the order's immutable
 * snapshot (§11), not from the current package table, so a historical order
 * keeps showing what the buyer actually agreed to pay after an admin reprices.
 */

import Link from "next/link";
import { listOrders } from "../../lib/api";
import { requireSessionCookie } from "../../lib/session";
import { Card } from "../../components/Card";
import { OrderStatusChip } from "../../components/Chip";
import { formatIdr, formatTokensCompact, formatUtc } from "../../lib/format";

export const metadata = { title: "Orders — Bosanda" };

/** Authenticated and per-user: never prerendered, never cached. */
export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const session = await requireSessionCookie("/dashboard/orders");
  const orders = await listOrders(session);

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1 style={{ margin: 0 }}>Orders</h1>
          <p className="lede">Every purchase, with the price and quota agreed at the time.</p>
        </div>
        <Link href="/checkout" className="btn btn--primary">
          Buy quota
        </Link>
      </div>

      {orders.length === 0 ? (
        <Card>
          <h2 className="card__title">No orders yet</h2>
          <p className="muted">Your purchases will appear here once you buy quota.</p>
          <Link href="/checkout" className="btn btn--primary">
            Buy quota
          </Link>
        </Card>
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <caption>Your orders, newest first. Timestamps are UTC.</caption>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Status</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="num">
                    Quota
                  </th>
                  <th scope="col" className="num">
                    Price
                  </th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.orderId}>
                    <th scope="row" style={{ fontWeight: 600 }}>
                      <Link href={`/orders/${encodeURIComponent(order.orderId)}`} className="mono">
                        {order.orderId}
                      </Link>
                    </th>
                    <td>
                      <OrderStatusChip status={order.status} />
                    </td>
                    <td>{order.intent === "top_up" ? "Top-up" : "New key"}</td>
                    <td className="num">{formatTokensCompact(order.tokens)}</td>
                    <td className="num">{formatIdr(order.priceIdr)}</td>
                    <td>{formatUtc(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
