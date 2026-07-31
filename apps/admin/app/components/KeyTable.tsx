/**
 * API key table, shared by /keys and /users/[userId].
 *
 * THE ADMIN SURFACE NEVER REVEALS A KEY. §12 gives the customer an eye toggle on
 * their own key in apps/web; §16/§17 give the operator nothing but a prefix.
 * `ApiKeySummary` is `.strict()` and has no plaintext, ciphertext, or lookup-digest
 * field, so there is nothing here to leak even by mistake — this component only
 * has to avoid inventing a reveal control, which it does.
 *
 * Quota is rendered as remaining-of-limit with a meter. The meter is decorative
 * (`aria-hidden`) with the real numbers in text beside it, because a bar alone
 * conveys nothing to a screen reader and colour alone conveys nothing to a
 * colourblind operator.
 */

import Link from "next/link";
import { EmptyState, TableScroll } from "./Card";
import { Chip, KeyStatusChip } from "./Chip";
import { ConfirmDialog } from "./ConfirmDialog";
import { adjustQuotaAction, revokeKeyAction } from "../lib/actions";
import { formatCount, formatRelative, formatTokensCompact, formatUtc } from "../lib/format";
import type { ApiKeySummary } from "../lib/schemas";

/** Fraction of quota consumed, clamped so a negative balance still renders. */
function consumedRatio(key: ApiKeySummary): number {
  if (key.quotaLimit <= 0) return 1;
  const used = key.quotaLimit - key.quotaRemaining;
  return Math.min(1, Math.max(0, used / key.quotaLimit));
}

export function KeyTable({
  keys,
  csrfToken,
  /** Hide the customer column when the whole table belongs to one user. */
  showUser = true,
  emptyMessage = "No API keys.",
}: {
  keys: ApiKeySummary[];
  csrfToken: string;
  showUser?: boolean;
  emptyMessage?: string;
}) {
  if (keys.length === 0) return <EmptyState>{emptyMessage}</EmptyState>;

  return (
    <TableScroll label="API keys">
      <table className="table">
        <caption className="visually-hidden">
          API keys with their prefix, owner, status, remaining quota, validity, and operator
          actions. Key values are never shown.
        </caption>
        <thead>
          <tr>
            <th scope="col">Key</th>
            {showUser && <th scope="col">Customer</th>}
            <th scope="col">Status</th>
            <th scope="col" className="num">
              Quota remaining
            </th>
            <th scope="col">Expires (UTC)</th>
            <th scope="col">Last used</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const ratio = consumedRatio(key);
            const exhausted = key.quotaRemaining <= 0;
            const revocable = key.status === "active" || key.status === "exhausted";

            return (
              <tr key={key.id}>
                <th scope="row">
                  {/* Prefix plus an ellipsis, so it reads as a fragment rather
                      than as a short key. */}
                  <span className="mono">{key.prefix}…</span>
                  <div className="field-hint">
                    {key.label ?? <span className="field-hint">no label</span>}
                  </div>
                  <div className="field-hint mono">{key.id}</div>
                </th>
                {showUser && (
                  <td>
                    <Link href={`/users/${encodeURIComponent(key.userId)}`}>{key.username}</Link>
                  </td>
                )}
                <td>
                  <KeyStatusChip status={key.status} />
                </td>
                <td className="num">
                  <span
                    className="mono"
                    title={`${formatCount(key.quotaRemaining)} of ${formatCount(key.quotaLimit)} weighted tokens`}
                  >
                    {formatTokensCompact(key.quotaRemaining)} /{" "}
                    {formatTokensCompact(key.quotaLimit)}
                  </span>
                  {/*
                    Decorative only. The figures above are the accessible carrier;
                    this just makes a nearly-empty key visible at a glance.
                  */}
                  <div className="meter" aria-hidden="true">
                    <div
                      className={`meter-fill${ratio > 0.9 ? " meter-warn" : ""}`}
                      style={{ width: `${Math.round(ratio * 100)}%` }}
                    />
                  </div>
                  {key.quotaRemaining < 0 && (
                    /*
                      A negative balance means metering settled above the limit —
                      possible with estimated usage (§10) reconciling upward. Worth
                      flagging rather than clamping to zero and hiding it.
                    */
                    <Chip tone="danger">overdrawn</Chip>
                  )}
                </td>
                <td className="mono">
                  {key.expiresAt === null ? (
                    <span className="field-hint">no expiry</span>
                  ) : (
                    <>
                      {formatUtc(key.expiresAt)}
                      <div className="field-hint">{formatRelative(key.expiresAt)}</div>
                    </>
                  )}
                </td>
                <td className="mono">
                  {key.lastUsedAt === null ? (
                    <span className="field-hint">never used</span>
                  ) : (
                    formatRelative(key.lastUsedAt)
                  )}
                </td>
                <td>
                  <div className="btn-row">
                    <ConfirmDialog
                      triggerLabel="Adjust quota"
                      triggerClassName="btn btn-sm btn-ghost"
                      title={`Adjust quota: ${key.prefix}…`}
                      description="Appends an adjustment to the ledger. Existing usage rows are not rewritten — the balance moves forward from here."
                      targetLabel={key.id}
                      confirmLabel="Apply adjustment"
                      confirmTone="primary"
                      action={adjustQuotaAction}
                      csrfToken={csrfToken}
                      hiddenFields={{ keyId: key.id }}
                      reasonPlaceholder="Why is quota being granted or removed?"
                    >
                      <div className="field">
                        <label className="field-label" htmlFor={`delta-${key.id}`}>
                          Weighted tokens (negative to remove)
                        </label>
                        <input
                          id={`delta-${key.id}`}
                          name="weightedTokensDelta"
                          className="input mono"
                          type="number"
                          step="1"
                          required
                          placeholder="1000000"
                        />
                        <span className="field-hint">
                          Currently {formatCount(key.quotaRemaining)} remaining of{" "}
                          {formatCount(key.quotaLimit)}. Whole numbers only.
                        </span>
                      </div>
                    </ConfirmDialog>

                    <ConfirmDialog
                      triggerLabel="Revoke"
                      triggerClassName="btn btn-sm btn-danger"
                      triggerDisabled={!revocable}
                      title={`Revoke key ${key.prefix}…`}
                      description="Stops this key working immediately. Revocation cannot be undone and remaining quota is not refunded."
                      targetLabel={key.id}
                      blastRadius={`${key.username} loses access on their next request, with ${formatTokensCompact(
                        Math.max(0, key.quotaRemaining),
                      )} weighted tokens unused. A new key requires a new purchase.`}
                      confirmLabel="Revoke permanently"
                      confirmTone="danger"
                      action={revokeKeyAction}
                      csrfToken={csrfToken}
                      hiddenFields={{ keyId: key.id }}
                      reasonPlaceholder="Why is this key being revoked?"
                    />
                  </div>
                  {exhausted && key.status === "active" && (
                    <div className="field-hint">quota spent — requests are already failing</div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
