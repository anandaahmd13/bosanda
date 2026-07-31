"use client";

/**
 * Cancel an order (§11: releases the stock reservation).
 *
 * A client component for two reasons: the confirmation step, and the inline
 * error. Cancelling is not destructive to anything the user owns — no money has
 * moved and no key exists yet — so the confirmation is a plain guard against a
 * mis-click rather than the harder warning the key-revoke path carries.
 *
 * On success the page is refreshed rather than patched, so the status chip and
 * the payment button both come from the server's view of the order instead of an
 * optimistic guess.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelOrderAction } from "../lib/actions";
import { CSRF_FIELD } from "../lib/csrf-field";
import { StatusRegion } from "./StatusRegion";

export function CancelOrderForm({ orderId, csrfToken }: { orderId: string; csrfToken: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function cancel() {
    if (!window.confirm("Cancel this order? The reserved stock is released.")) return;

    const form = new FormData();
    form.set(CSRF_FIELD, csrfToken);
    form.set("orderId", orderId);

    startTransition(async () => {
      const result = await cancelOrderAction(form);
      setError(result.error);
      if (result.error === null) router.refresh();
    });
  }

  return (
    <>
      <StatusRegion message={error} tone="danger" assertive />
      <button type="button" className="btn btn--ghost" onClick={cancel} disabled={pending}>
        {pending ? "Cancelling…" : "Cancel order"}
      </button>
    </>
  );
}
