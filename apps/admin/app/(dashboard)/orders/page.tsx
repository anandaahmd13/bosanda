/**
 * /orders — order list and reconciliation queue (§13, §15).
 *
 * Sorted by nothing here: the API decides order, and this page renders what it
 * gets. What it does add is a standing count of the two states an operator has to
 * act on — `review_required` (a payment that could not be reconciled
 * automatically) and `paid` (money taken, key not yet activated). Those are the
 * only rows where inaction costs a customer something.
 *
 * Filtering is a GET form so a filtered view is shareable and reloadable. No
 * mutation lives on this page: activate and refund are on the detail page, where
 * the full snapshot and payment-event history are visible. Approving a refund
 * from a list row would mean approving it without having read the evidence.
 */

import Link from "next/link";
import type { Metadata } from "next";
import { Card, EmptyState, Kpi, PageHeader, TableScroll } from "../../components/Card";
import { Chip, OrderStatusChip } from "../../components/Chip";
import { FilterForm, PAGE_SIZE, Pagination, readOffset } from "../../components/Pagination";
import { StatusRegion, firstParam } from "../../components/StatusRegion";
import { listOrders } from "../../lib/api";
import { formatRelative, formatRupiah, formatUtc } from "../../lib/format";
import { orderStatus, type OrderStatus } from "../../lib/schemas";

export const metadata: Metadata = { title: "Orders — Bosanda operator console" };

const STATUS_OPTIONS: { value: OrderStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "review_required", label: "Review required" },
  { value: "paid", label: "Paid, not activated" },
  { value: "pending_payment", label: "Pending payment" },
  { value: "activated", label: "Activated" },
  { value: "draft", label: "Draft" },
  { value: "expired", label: "Expired" },
  { value: "cancelled", label: "Cancelled" },
];

/** Validates the status param against the schema rather than trusting the URL. */
function readStatus(value: string | string[] | undefined): OrderStatus | "all" {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === "all") return "all";
  const parsed = orderStatus.safeParse(raw);
  return parsed.success ? parsed.data : "all";
}

function readQuery(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined ? "" : raw.slice(0, 200);
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = readStatus(params["status_filter"]);
  const query = readQuery(params["q"]);
  const offset = readOffset(params["offset"]);

  const { orders, total } = await listOrders({
    status,
    query,
    page: { limit: PAGE_SIZE, offset },
  });

  // Counted on the page of results in view, not across the whole table — a count
  // that claimed to be global while paginating would be a lie.
  const needsReview = orders.filter((order) => order.status === "review_required");
  const paidNotActivated = orders.filter((order) => order.status === "paid");
  const grossOnPage = orders
    .filter((order) => order.status === "activated" || order.status === "paid")
    .reduce((sum, order) => sum + order.amountIdr, 0);

  const preserved: Record<string, string> = {};
  if (status !== "all") preserved["status_filter"] = status;
  if (query.length > 0) preserved["q"] = query;

  return (
    <div className="stack">
      <PageHeader eyebrow="Commerce" title="Orders">
        <Link href="/packages" className="btn btn-sm btn-ghost">
          Packages & stock
        </Link>
        <Link href="/health" className="btn btn-sm btn-info">
          Reconciliation
        </Link>
      </PageHeader>

      <StatusRegion status={firstParam(params["status"])} error={firstParam(params["error"])} />

      {needsReview.length > 0 && (
        <div className="banner banner-danger banner-strong" role="alert">
          <span className="banner-icon" aria-hidden="true">
            !
          </span>
          <div>
            <div className="banner-title">
              {needsReview.length} order{needsReview.length === 1 ? "" : "s"} on this page need
              review
            </div>
            <p className="banner-body">
              Automatic reconciliation could not settle these. Each one is a customer who may have
              paid without receiving a key.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-kpi">
        <Kpi label="Matching orders" value={String(total)} chip="⇄" delta="across all pages" />
        <Kpi
          label="Review required"
          value={String(needsReview.length)}
          chip="⚑"
          chipTone="primary"
          deltaDirection={needsReview.length > 0 ? "down" : "up"}
          delta={needsReview.length > 0 ? "on this page" : "none on this page"}
        />
        <Kpi
          label="Paid, not activated"
          value={String(paidNotActivated.length)}
          chip="◷"
          deltaDirection={paidNotActivated.length > 0 ? "down" : "up"}
          delta={paidNotActivated.length > 0 ? "awaiting activation" : "none waiting"}
        />
        <Kpi label="Value on this page" value={formatRupiah(grossOnPage)} chip="₨" />
      </div>

      <Card
        title="Filter"
        hint="A filtered view is a plain URL — safe to bookmark or paste to another operator."
      >
        <FilterForm action="/orders" label="Filter orders">
          <div className="field">
            <label className="field-label" htmlFor="status_filter">
              Status
            </label>
            <select
              id="status_filter"
              name="status_filter"
              className="select"
              defaultValue={status}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="q">
              Search
            </label>
            <input
              id="q"
              name="q"
              className="input"
              type="search"
              defaultValue={query}
              maxLength={200}
              placeholder="username, order id, or transaction ref"
            />
            <span className="field-hint">Matches username, order id, or provider reference.</span>
          </div>
        </FilterForm>
      </Card>

      <Card title="Orders" hint="Open an order to see its snapshot, ledger, and payment events.">
        {orders.length === 0 ? (
          <EmptyState>
            {status === "all" && query.length === 0
              ? "No orders yet."
              : "No orders match this filter."}
          </EmptyState>
        ) : (
          <>
            <TableScroll label="Orders">
              <table className="table">
                <caption className="visually-hidden">
                  Matching orders with customer, package, amount, status, provider reference, and
                  timestamps.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Package</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="num">
                      Amount
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Provider ref</th>
                    <th scope="col">Created (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <th scope="row">
                        {/* The id is the link target: it is the unambiguous
                            handle an operator copies into a support thread. */}
                        <Link href={`/orders/${encodeURIComponent(order.id)}`} className="mono">
                          {order.id}
                        </Link>
                      </th>
                      <td>
                        <Link href={`/users/${encodeURIComponent(order.userId)}`}>
                          {order.username}
                        </Link>
                      </td>
                      <td>{order.packageName}</td>
                      <td>
                        <Chip tone={order.type === "top_up" ? "info" : "neutral"}>
                          {order.type === "top_up" ? "Top-up" : "New key"}
                        </Chip>
                      </td>
                      <td className="num mono">{formatRupiah(order.amountIdr)}</td>
                      <td>
                        <OrderStatusChip status={order.status} />
                      </td>
                      <td className="mono">
                        {order.providerTransactionId ?? <span className="field-hint">none</span>}
                        <div className="field-hint">{order.provider}</div>
                      </td>
                      <td className="mono" title={order.createdAt}>
                        {formatUtc(order.createdAt)}
                        <div className="field-hint">{formatRelative(order.createdAt)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
            <Pagination
              base="/orders"
              params={preserved}
              offset={offset}
              total={total}
              count={orders.length}
            />
          </>
        )}
      </Card>
    </div>
  );
}
