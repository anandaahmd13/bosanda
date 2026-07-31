/**
 * /orders/[orderId] — one order, with the evidence needed to act on it (§13, §15).
 *
 * Activate and refund live here rather than on the list, because both need the
 * payment-event history and the ledger in view before an operator commits:
 *
 *  - Manual activation is for a paid order whose activation did not happen. It is
 *    idempotent server-side (§13), so a double click cannot grant two keys — but
 *    it is still offered only for `paid` and `review_required`, since activating
 *    an unpaid order would be giving away quota.
 *  - A refund NEVER deletes history. §13 records it as a ledger adjustment, so the
 *    dialog says that plainly: the purchase row stays and a negative entry is
 *    appended. An operator expecting the order to disappear afterwards would
 *    otherwise read the unchanged page as a failure.
 *
 * The package snapshot is shown, not the current package definition. §11 says a
 * paid order retains its purchase snapshot, and a support conversation about what
 * someone was charged has to be answerable from that snapshot even after prices
 * move.
 *
 * `notFound()` on a missing order, so a guessed id reveals nothing beyond a 404.
 */

import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Card, EmptyState, PageHeader, TableScroll } from "../../../components/Card";
import { Chip, OrderStatusChip } from "../../../components/Chip";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { StatusRegion, firstParam } from "../../../components/StatusRegion";
import { activateOrderAction, refundOrderAction } from "../../../lib/actions";
import { getOrder } from "../../../lib/api";
import { csrfCookieName, generateCsrfToken } from "../../../lib/session";
import {
  formatCount,
  formatRelative,
  formatRupiah,
  formatTokensCompact,
  formatUtc,
  humanizeToken,
} from "../../../lib/format";
import type { LedgerEntry } from "../../../lib/schemas";

export const metadata: Metadata = { title: "Order — Bosanda operator console" };

const LEDGER_TONES: Record<
  LedgerEntry["kind"],
  "success" | "info" | "warning" | "danger" | "neutral"
> = {
  purchase: "success",
  top_up: "success",
  usage: "info",
  adjustment: "warning",
  expiry: "neutral",
};

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orderId } = await params;
  const query = await searchParams;

  const jar = await cookies();
  const existing = jar.get(csrfCookieName)?.value;
  const csrfToken = existing !== undefined && existing.length > 0 ? existing : generateCsrfToken();

  const detail = await getOrder(orderId);
  if (detail === null) notFound();

  const {
    order,
    packageSnapshot,
    targetApiKeyPrefix,
    stockReservationExpiresAt,
    ledger,
    paymentEvents,
  } = detail;

  // Activation is only meaningful once money has actually arrived. `paid` is the
  // normal stuck case; `review_required` is the one reconciliation flagged.
  const activatable = order.status === "paid" || order.status === "review_required";
  // Refundable while money is held: activated (customer has the key) or paid
  // (not yet delivered). An unpaid order has nothing to refund.
  const refundable =
    order.status === "activated" || order.status === "paid" || order.status === "review_required";

  const failedEvents = paymentEvents.filter((event) => event.errorCode !== null);
  const unprocessedEvents = paymentEvents.filter((event) => event.processedAt === null);

  return (
    <div className="stack">
      <PageHeader eyebrow="Commerce" title={`Order ${order.id}`}>
        <Link href="/orders" className="btn btn-sm btn-ghost">
          ← All orders
        </Link>
        <Link href={`/users/${encodeURIComponent(order.userId)}`} className="btn btn-sm btn-ghost">
          {order.username}
        </Link>
      </PageHeader>

      <StatusRegion status={firstParam(query["status"])} error={firstParam(query["error"])} />

      {order.status === "review_required" && (
        <div className="banner banner-danger banner-strong" role="alert">
          <span className="banner-icon" aria-hidden="true">
            !
          </span>
          <div>
            <div className="banner-title">Reconciliation could not settle this order</div>
            <p className="banner-body">
              Check the payment events below against the provider&apos;s own record before
              activating. If money did not arrive, activating hands out quota for free.
            </p>
          </div>
        </div>
      )}

      {order.status === "paid" && (
        <div className="banner banner-warning" role="status">
          <span className="banner-icon" aria-hidden="true">
            ◷
          </span>
          <div>
            <div className="banner-title">Paid but not activated</div>
            <p className="banner-body">
              The customer has been charged and has no key yet. Activation is idempotent, so
              retrying is safe.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-2">
        <Card title="Order" labelledBy="card-order">
          <dl className="dl">
            <dt>Status</dt>
            <dd>
              <OrderStatusChip status={order.status} />
            </dd>
            <dt>Type</dt>
            <dd>
              <Chip tone={order.type === "top_up" ? "info" : "neutral"}>
                {order.type === "top_up" ? "Top-up" : "New key"}
              </Chip>
            </dd>
            <dt>Amount charged</dt>
            <dd className="mono">{formatRupiah(order.amountIdr)}</dd>
            <dt>Customer</dt>
            <dd>
              <Link href={`/users/${encodeURIComponent(order.userId)}`}>{order.username}</Link>
            </dd>
            {order.type === "top_up" && (
              <>
                <dt>Target key</dt>
                <dd className="mono">
                  {targetApiKeyPrefix === null ? (
                    <span className="field-hint">not recorded</span>
                  ) : (
                    /* A prefix only — the full key is never retrievable here (§12). */
                    `${targetApiKeyPrefix}…`
                  )}
                </dd>
              </>
            )}
            <dt>Created</dt>
            <dd className="mono">
              {formatUtc(order.createdAt)}
              <div className="field-hint">{formatRelative(order.createdAt)}</div>
            </dd>
            <dt>Paid</dt>
            <dd className="mono">
              {order.paidAt === null ? (
                <span className="field-hint">not paid</span>
              ) : (
                formatUtc(order.paidAt)
              )}
            </dd>
            <dt>Activated</dt>
            <dd className="mono">
              {order.activatedAt === null ? (
                <span className="field-hint">not activated</span>
              ) : (
                formatUtc(order.activatedAt)
              )}
            </dd>
            <dt>Stock reservation</dt>
            <dd className="mono">
              {stockReservationExpiresAt === null ? (
                <span className="field-hint">none held</span>
              ) : (
                <>
                  expires {formatUtc(stockReservationExpiresAt)}
                  <div className="field-hint">
                    releases automatically — the unit returns to available stock
                  </div>
                </>
              )}
            </dd>
          </dl>
        </Card>

        <Card
          title="Purchase snapshot"
          hint="What was actually sold, frozen at purchase. Current package prices do not change these figures (§11)."
        >
          <dl className="dl">
            <dt>Package</dt>
            <dd>{packageSnapshot.name}</dd>
            <dt>Quota</dt>
            <dd title={`${formatCount(packageSnapshot.weightedTokenQuota)} weighted tokens`}>
              {formatTokensCompact(packageSnapshot.weightedTokenQuota)} weighted
            </dd>
            <dt>Price at purchase</dt>
            <dd className="mono">{formatRupiah(packageSnapshot.priceIdr)}</dd>
            <dt>Validity</dt>
            <dd>
              {Math.round(packageSnapshot.durationSeconds / 3600)} hours from confirmed payment
            </dd>
            <dt>Provider</dt>
            <dd className="mono">{order.provider}</dd>
            <dt>Provider reference</dt>
            <dd className="mono">
              {order.providerTransactionId ?? <span className="field-hint">none recorded</span>}
            </dd>
          </dl>
          {packageSnapshot.priceIdr !== order.amountIdr && (
            /*
              Snapshot price and charged amount should agree. When they do not, one
              of them is wrong and no refund or activation decision should be made
              on this page until it is understood.
            */
            <div className="banner banner-danger" role="alert">
              <span className="banner-icon" aria-hidden="true">
                !
              </span>
              <div>
                <div className="banner-title">Snapshot and charge disagree</div>
                <p className="banner-body">
                  Snapshot says {formatRupiah(packageSnapshot.priceIdr)}, the order records{" "}
                  {formatRupiah(order.amountIdr)}. Investigate before acting.
                </p>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Operator actions"
        hint="Both are audited with your username, a UTC timestamp, and the reason you give."
      >
        <div className="btn-row">
          <ConfirmDialog
            triggerLabel="Activate manually"
            triggerClassName="btn btn-sm btn-primary"
            triggerDisabled={!activatable}
            title={`Activate order ${order.id}`}
            description="Creates or tops up the key for this order. The operation is idempotent server-side, so if activation already happened this will not grant a second key."
            targetLabel={order.id}
            blastRadius={`This grants ${formatTokensCompact(
              packageSnapshot.weightedTokenQuota,
            )} weighted tokens to ${order.username}. Confirm from the provider's own dashboard that ${formatRupiah(
              order.amountIdr,
            )} actually arrived — the payment events below are our record, not theirs.`}
            confirmLabel="Activate now"
            confirmTone="danger"
            action={activateOrderAction}
            csrfToken={csrfToken}
            hiddenFields={{ orderId: order.id }}
            reasonPlaceholder="What confirms the payment, and why did automatic activation not happen?"
          />

          <ConfirmDialog
            triggerLabel="Record refund"
            triggerClassName="btn btn-sm btn-danger"
            triggerDisabled={!refundable}
            title={`Refund order ${order.id}`}
            description="Appends a negative ledger adjustment. The purchase entry stays — history is never deleted (§13), so this page will still show the original order afterwards."
            targetLabel={order.id}
            blastRadius="This records the refund in our ledger. It does NOT move money at the payment provider — issue the actual refund there separately, or the books will disagree."
            confirmLabel="Record refund"
            confirmTone="danger"
            action={refundOrderAction}
            csrfToken={csrfToken}
            hiddenFields={{ orderId: order.id }}
            reasonPlaceholder="Why is this being refunded, and has the provider-side refund been issued?"
          />
        </div>
        {!activatable && !refundable && (
          <p className="card-hint" style={{ marginTop: 12 }}>
            No action applies to an order in this state. Activation needs a paid or review-required
            order; a refund needs money to have been taken.
          </p>
        )}
      </Card>

      <Card
        title="Payment events"
        hint="Every callback received from the provider, in arrival order. Duplicates are expected — processing is idempotent (§11)."
      >
        {paymentEvents.length === 0 ? (
          <EmptyState>
            No payment event has been received. For a pending order that is normal; for a paid one
            it means the order was settled by reconciliation rather than a webhook.
          </EmptyState>
        ) : (
          <>
            {(failedEvents.length > 0 || unprocessedEvents.length > 0) && (
              <div className="btn-row" style={{ marginBottom: 12 }}>
                {failedEvents.length > 0 && (
                  <Chip tone="danger">{failedEvents.length} with an error</Chip>
                )}
                {unprocessedEvents.length > 0 && (
                  <Chip tone="warning">{unprocessedEvents.length} unprocessed</Chip>
                )}
              </div>
            )}
            <TableScroll label="Payment events">
              <table className="table">
                <caption className="visually-hidden">
                  Provider callbacks with their reported status, arrival and processing times, and
                  any error classification.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Reported status</th>
                    <th scope="col">Received (UTC)</th>
                    <th scope="col">Processed (UTC)</th>
                    <th scope="col">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentEvents.map((event) => (
                    <tr key={event.id}>
                      <th scope="row" className="mono">
                        {event.id}
                      </th>
                      <td className="mono">{event.status}</td>
                      <td className="mono">{formatUtc(event.receivedAt)}</td>
                      <td className="mono">
                        {event.processedAt === null ? (
                          <span className="field-hint">not processed</span>
                        ) : (
                          formatUtc(event.processedAt)
                        )}
                      </td>
                      <td>
                        {event.errorCode === null ? (
                          <span className="field-hint">none</span>
                        ) : (
                          /* A classification, never a raw provider body (§16). */
                          <Chip tone="danger">{humanizeToken(event.errorCode)}</Chip>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </>
        )}
      </Card>

      <Card
        title="Ledger"
        hint="Append-only. A correction is a new entry, never an edit to an old one."
      >
        {ledger.length === 0 ? (
          <EmptyState>No ledger entries for this order yet.</EmptyState>
        ) : (
          <TableScroll label="Ledger entries">
            <table className="table">
              <caption className="visually-hidden">
                Ledger entries for this order with kind, token delta, resulting balance, meter
                version, and correlation id.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col" className="num">
                    Weighted delta
                  </th>
                  <th scope="col" className="num">
                    Balance after
                  </th>
                  <th scope="col">Meter</th>
                  <th scope="col">Request id</th>
                  <th scope="col">Created (UTC)</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <Chip tone={LEDGER_TONES[entry.kind]}>{humanizeToken(entry.kind)}</Chip>
                    </td>
                    <td className="num mono">
                      {entry.weightedTokensDelta > 0 ? "+" : ""}
                      {formatCount(entry.weightedTokensDelta)}
                      {entry.estimated && (
                        /* §10 requires estimated usage be disclosed rather than
                           presented as settled. */
                        <div className="field-hint">estimated</div>
                      )}
                    </td>
                    <td className="num mono">{formatCount(entry.balanceAfter)}</td>
                    <td className="mono">{entry.meterVersion}</td>
                    <td className="mono">
                      {/* A correlation id only. Prompt and response content is
                          never stored, so there is nothing to drill into (§16). */}
                      {entry.requestId ?? <span className="field-hint">none</span>}
                    </td>
                    <td className="mono" title={entry.createdAt}>
                      {formatUtc(entry.createdAt)}
                    </td>
                    <td>{entry.reason ?? <span className="field-hint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>
    </div>
  );
}
