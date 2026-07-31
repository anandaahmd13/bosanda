"use client";

/**
 * Polls an order's status until it settles (§13 step 6-7).
 *
 * Why poll at all: activation is driven by the provider's webhook, which arrives
 * out of band. The browser has no way to know when it lands, and §13's
 * reconciliation path means a "paid" order can take a moment to become
 * "activated". Polling a narrow projection is the honest way to reflect that.
 *
 * Why it stops: `router.refresh()` on a settled status re-renders the server
 * component with the real order, and the interval is cleared. A poll that ran
 * forever on an activated order would be pure waste on both ends.
 *
 * The poll calls a server action rather than fetching the gateway directly: the
 * session cookie is HttpOnly, so the browser cannot authenticate the read itself.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { pollOrderStatusAction } from "../lib/actions";
import type { OrderStatus } from "../lib/schemas";

/** States that will not change on their own. Nothing to wait for. */
const SETTLED: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "activated",
  "expired",
  "cancelled",
  "review_required",
]);

const INTERVAL_MS = 4000;
/** Stop after ~4 minutes rather than polling a tab left open all day. */
const MAX_ATTEMPTS = 60;

export function OrderStatusPoll({ orderId, status }: { orderId: string; status: OrderStatus }) {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    if (SETTLED.has(status)) return;

    let attempts = 0;
    let cancelled = false;

    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) {
        clearInterval(timer);
        setGaveUp(true);
        return;
      }

      void pollOrderStatusAction(orderId).then((result) => {
        if (cancelled || result === null) return;
        // Only re-render when it actually moved; a refresh per tick would
        // remount the page every four seconds for no reason.
        if (result.status !== status) {
          clearInterval(timer);
          router.refresh();
        }
      });
    }, INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orderId, status, router]);

  if (SETTLED.has(status)) return null;

  return (
    <p className="muted" role="status" aria-live="polite">
      {gaveUp
        ? "Still waiting. Reload this page to check again, or contact support with the order ID."
        : "Checking for an update every few seconds…"}
    </p>
  );
}
