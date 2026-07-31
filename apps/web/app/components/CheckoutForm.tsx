"use client";

/**
 * Checkout: pick a size, then new key or top-up (§11 "New key versus top-up").
 *
 * What this form does NOT send is the point: only `packageId`, `intent`, and
 * `targetKeyId` cross the boundary. Price and quota are never submitted, because
 * §13 forbids trusting a browser-supplied price, package, or quota — the server
 * resolves the price from its own package record and snapshots it onto the order.
 * The figures rendered here are display only.
 *
 * The per-key top-up ceiling (§11: 100M per key) is shown and enforced in the UI
 * so a user is not sent to a payment page for an order the server will reject.
 * That check is a courtesy; the server's is the one that counts.
 */

import { useActionState, useState } from "react";
import { createOrderAction, type FormState } from "../lib/actions";
import { CSRF_FIELD } from "../lib/csrf-field";
import { formatIdr, formatTokensCompact, formatTokensExact, formatUtc } from "../lib/format";
import { PACKAGE_SIZES } from "../lib/packages";
import type { StockEntry, TopUpCandidate } from "../lib/schemas";

const INITIAL: FormState = { error: null };

export function CheckoutForm({
  stock,
  candidates,
  csrfToken,
  initialPackageId,
}: {
  stock: readonly StockEntry[];
  candidates: readonly TopUpCandidate[];
  csrfToken: string | null;
  initialPackageId: string | null;
}) {
  const [state, formAction, pending] = useActionState(createOrderAction, INITIAL);

  const byId = new Map(stock.map((entry) => [entry.packageId, entry]));
  const buyable = PACKAGE_SIZES.filter((size) => {
    const entry = byId.get(size.id);
    return entry !== undefined && entry.enabled && entry.available > 0;
  });

  const defaultPackage =
    (initialPackageId !== null && buyable.some((size) => size.id === initialPackageId)
      ? initialPackageId
      : buyable[0]?.id) ?? null;

  const [packageId, setPackageId] = useState<string | null>(defaultPackage);
  const [intent, setIntent] = useState<"new_key" | "top_up">("new_key");
  const [targetKeyId, setTargetKeyId] = useState<string>(candidates[0]?.keyId ?? "");

  const selected = PACKAGE_SIZES.find((size) => size.id === packageId);
  const priceIdr =
    (packageId !== null ? byId.get(packageId)?.priceIdr : undefined) ?? selected?.priceIdr ?? 0;
  const target = candidates.find((candidate) => candidate.keyId === targetKeyId);

  // §11: a top-up may not push a key past the per-key cap.
  const exceedsCap =
    intent === "top_up" && target !== undefined && selected !== undefined
      ? selected.tokens > target.maxTopUpTokens
      : false;

  const blocked =
    csrfToken === null ||
    packageId === null ||
    (intent === "top_up" && (targetKeyId === "" || exceedsCap));

  if (buyable.length === 0) {
    return (
      <div className="alert alert--warning" role="alert">
        <div className="alert__body">
          Nothing is available to buy right now. Every package size is either sold out or disabled.
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate className="stack">
      {csrfToken !== null ? <input type="hidden" name={CSRF_FIELD} value={csrfToken} /> : null}
      <input type="hidden" name="packageId" value={packageId ?? ""} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="targetKeyId" value={intent === "top_up" ? targetKeyId : ""} />

      <div aria-live="polite">
        {state.error !== null ? (
          <div className="alert alert--danger" role="alert">
            <div className="alert__body">{state.error}</div>
          </div>
        ) : null}
      </div>

      {csrfToken === null ? (
        <div className="alert alert--warning" role="alert">
          <div className="alert__body">
            This page could not be initialised securely. Reload to continue.
          </div>
        </div>
      ) : null}

      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="card__title">1. Choose a size</legend>
        <ul className="grid cols-3" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {buyable.map((size) => {
            const entry = byId.get(size.id);
            const checked = size.id === packageId;
            return (
              <li key={size.id}>
                {/* A real radio input, styled as a card: keyboard arrow-key
                    selection and screen-reader group semantics come free. */}
                <label className={`card card--tight${checked ? " card--selected" : ""}`}>
                  <span className="row-between">
                    <span>
                      <input
                        type="radio"
                        name="size"
                        value={size.id}
                        checked={checked}
                        onChange={() => setPackageId(size.id)}
                      />{" "}
                      <strong>{formatTokensCompact(size.tokens)}</strong>
                    </span>
                    <span className="price">{formatIdr(entry?.priceIdr ?? size.priceIdr)}</span>
                  </span>
                  <span className="muted">{formatTokensExact(size.tokens)} weighted tokens</span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="card__title">2. New key or top-up</legend>

        <label className="field">
          <span>
            <input
              type="radio"
              name="intentChoice"
              value="new_key"
              checked={intent === "new_key"}
              onChange={() => setIntent("new_key")}
            />{" "}
            Issue a new key
          </span>
          <span className="field__hint">
            A fresh key with its own 24-hour validity window, starting when payment is confirmed.
          </span>
        </label>

        <label className="field">
          <span>
            <input
              type="radio"
              name="intentChoice"
              value="top_up"
              checked={intent === "top_up"}
              onChange={() => setIntent("top_up")}
              disabled={candidates.length === 0}
            />{" "}
            Top up an existing key
          </span>
          <span className="field__hint">
            {candidates.length === 0
              ? "No key is eligible: a key must be active and not exhausted to receive a top-up."
              : "Adds quota to a key you already have. The expiry does not change."}
          </span>
        </label>

        {intent === "top_up" && candidates.length > 0 ? (
          <label className="field">
            <span className="field__label">Key to top up</span>
            <select
              className="input"
              value={targetKeyId}
              onChange={(event) => setTargetKeyId(event.target.value)}
            >
              {candidates.map((candidate) => (
                <option key={candidate.keyId} value={candidate.keyId}>
                  {`${candidate.masked} — ${formatTokensCompact(candidate.quotaRemaining)} left, expires ${formatUtc(candidate.expiresAt)}`}
                </option>
              ))}
            </select>
            {target !== undefined ? (
              <span className="field__hint">
                {`This key can take up to ${formatTokensCompact(target.maxTopUpTokens)} more before hitting the 100M per-key cap.`}
              </span>
            ) : null}
          </label>
        ) : null}

        {exceedsCap && target !== undefined && selected !== undefined ? (
          <div className="alert alert--warning" role="alert">
            <div className="alert__body">
              {`${formatTokensCompact(selected.tokens)} would push that key past the 100M cap. Choose at most ${formatTokensCompact(target.maxTopUpTokens)}, or issue a new key instead.`}
            </div>
          </div>
        ) : null}
      </fieldset>

      <div className="divider" />

      <div className="row-between">
        <div>
          <p className="eyebrow">Total</p>
          <p className="price" style={{ margin: 0 }}>
            {formatIdr(priceIdr)}
          </p>
          <p className="muted" style={{ margin: 0 }}>
            {selected === undefined
              ? "Choose a size."
              : `${formatTokensExact(selected.tokens)} weighted tokens · ${intent === "top_up" ? "added to the selected key" : "new key, valid 24 hours from payment"}`}
          </p>
        </div>
        <button className="btn btn--primary" type="submit" disabled={pending || blocked}>
          {pending ? "Starting…" : "Continue to payment"}
        </button>
      </div>

      <p className="muted" style={{ marginBottom: 0 }}>
        The final price is confirmed by the server from its own package record. Stock is reserved
        once the order is created and released if payment does not arrive in time.
      </p>
    </form>
  );
}
