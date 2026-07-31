/**
 * One row of the API keys table: masked value, eye toggle, revoke (§12).
 *
 * §12 requires keys to be "displayed masked by default", with the eye toggle
 * decrypting "only after a valid website session", and every reveal audited.
 * That shapes this component:
 *
 *  - The plaintext is NOT in the page payload. The server sends only `masked`.
 *    A hidden-by-CSS plaintext would still be in the HTML, in the browser cache,
 *    and in any DOM snapshot, so revealing is a round trip rather than a toggle.
 *  - Each reveal is a fresh server call, because each reveal must write its own
 *    audit row. The result is deliberately NOT memoized: caching it would mean
 *    the second reveal is unaudited.
 *  - The plaintext lives in component state and is dropped on hide, on revoke,
 *    and on unmount. It is never logged and never written to storage.
 */

"use client";

import { useState, useTransition } from "react";
import { revealKeyAction, revokeKeyAction } from "../lib/actions";
import { CSRF_FIELD } from "../lib/csrf-field";
import { KeyStatusChip } from "./Chip";
import { formatTokensCompact, formatTokensExact, formatUtc, fraction } from "../lib/format";
import type { KeySummary } from "../lib/schemas";

export function KeyRow({ apiKey, csrfToken }: { apiKey: KeySummary; csrfToken: string | null }) {
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const revealed = plaintext !== null;
  // A revoked or expired key has no working secret to show, and revoking again
  // is meaningless — both controls are pointless once it is not active.
  const actionable = apiKey.status === "active" || apiKey.status === "exhausted";

  function toggleReveal() {
    if (revealed) {
      setPlaintext(null);
      setMessage(null);
      return;
    }
    startTransition(async () => {
      const result = await revealKeyAction(apiKey.keyId);
      if ("error" in result) {
        setMessage(result.error);
        return;
      }
      setPlaintext(result.plaintext);
      // Stating that the reveal was recorded is part of the deterrent (§12).
      setMessage(`Revealed and recorded in the audit log at ${formatUtc(result.auditedAt)}.`);
    });
  }

  function revoke() {
    // Irreversible: §12 has no un-revoke, and the quota does not come back.
    const confirmed = window.confirm(
      `Revoke this key permanently?\n\n${apiKey.masked}\n\n` +
        `Any application using it stops working immediately. Remaining quota is not refunded. ` +
        `This cannot be undone.`,
    );
    if (!confirmed) return;

    if (csrfToken === null) {
      setMessage("This page could not be verified. Reload and try again.");
      return;
    }

    const form = new FormData();
    form.set(CSRF_FIELD, csrfToken);
    form.set("keyId", apiKey.keyId);

    startTransition(async () => {
      const result = await revokeKeyAction(form);
      // Drop any revealed secret: it is dead now and should not linger on screen.
      setPlaintext(null);
      setMessage(result.error ?? "Key revoked.");
    });
  }

  const remainingFraction = fraction(apiKey.quotaRemaining, apiKey.quotaTotal);

  return (
    <tr>
      <td>
        <span className="mono">{revealed ? plaintext : apiKey.masked}</span>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={toggleReveal}
            disabled={pending || !actionable}
            // aria-pressed makes this a toggle rather than an action to a
            // screen reader, so the current state is announced.
            aria-pressed={revealed}
          >
            {revealed ? "Hide" : "Reveal"}
          </button>
          {revealed ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                void navigator.clipboard?.writeText(plaintext).then(
                  () => setMessage("Copied to clipboard."),
                  () => setMessage("Could not copy. Select the key and copy it manually."),
                );
              }}
            >
              Copy
            </button>
          ) : null}
        </div>
        {/* Per-row live region: announces the audit notice and any error. */}
        <div role="status" aria-live="polite" aria-atomic="true">
          {message === null ? null : (
            <p className="muted" style={{ marginTop: 6 }}>
              {message}
            </p>
          )}
        </div>
      </td>

      <td>
        <KeyStatusChip status={apiKey.status} />
      </td>

      <td className="num">
        {formatTokensCompact(apiKey.quotaRemaining)}
        <div className="muted">{`${formatTokensExact(apiKey.quotaRemaining)} of ${formatTokensExact(apiKey.quotaTotal)}`}</div>
        <div className="meter" aria-hidden="true" style={{ marginTop: 6 }}>
          <div
            className={`meter__fill${remainingFraction <= 0.1 ? " meter__fill--low" : remainingFraction <= 0.25 ? " meter__fill--warn" : ""}`}
            style={{ width: `${Math.round(remainingFraction * 100)}%` }}
          />
        </div>
      </td>

      <td>
        {apiKey.expiresAt === null ? <span className="muted">—</span> : formatUtc(apiKey.expiresAt)}
      </td>
      <td>{formatUtc(apiKey.createdAt)}</td>

      <td>
        <button
          type="button"
          className="btn btn--danger btn--sm"
          onClick={revoke}
          disabled={pending || !actionable}
        >
          Revoke
        </button>
      </td>
    </tr>
  );
}
