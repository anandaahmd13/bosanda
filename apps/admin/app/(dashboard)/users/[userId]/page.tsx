/**
 * /users/[userId] — one customer, with the two account actions (§15).
 *
 * The two writes here differ in kind and are separated on the page:
 *
 *  - Disable/enable is reversible and blocks every key the account holds at once,
 *    so its blast radius names the count and the quota that goes dark.
 *  - Reset password is NOT reversible in the sense that matters: the old password
 *    is gone, the customer is locked out until told the new one, and there is no
 *    email delivery in this system (§12 stores no address) — the operator has to
 *    hand the value over out of band.
 *
 * Neither action touches API keys. A disabled account's keys stop working because
 * the account is disabled, not because they were revoked, which is why re-enabling
 * restores service without reissuing anything.
 *
 * The route path matches where `setUserEnabledAction` and `resetPasswordAction`
 * redirect (`/users/${userId}`), so their `?status=` lands back here.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Card, Kpi, PageHeader } from "../../../components/Card";
import { Chip } from "../../../components/Chip";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { KeyTable } from "../../../components/KeyTable";
import { StatusRegion, firstParam } from "../../../components/StatusRegion";
import { resetPasswordAction, setUserEnabledAction } from "../../../lib/actions";
import { getUser } from "../../../lib/api";
import { getOrCreateCsrfToken } from "../../../lib/session";
import { formatCount, formatRelative, formatTokensCompact, formatUtc } from "../../../lib/format";

export const metadata: Metadata = { title: "Customer — Bosanda operator console" };

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId } = await params;
  const query = await searchParams;
  const csrfToken = await getOrCreateCsrfToken();
  const detail = await getUser(userId);

  // A bad id in the URL is a 404, not an empty page pretending the account exists.
  if (detail === null) notFound();

  const { user, keys } = detail;
  const liveKeys = keys.filter((key) => key.status === "active");
  const quotaAtRisk = liveKeys.reduce((sum, key) => sum + Math.max(0, key.quotaRemaining), 0);
  const disabled = user.status === "disabled";

  return (
    <>
      <PageHeader eyebrow="Customer" title={user.username}>
        <Link href="/users" className="btn btn-sm btn-ghost">
          ← All customers
        </Link>
      </PageHeader>

      <StatusRegion status={firstParam(query["status"])} error={firstParam(query["error"])} />

      {disabled && (
        <div className="banner banner-warning" role="status">
          <span className="banner-icon" aria-hidden="true">
            !
          </span>
          <div>
            <div className="banner-title">This account is disabled</div>
            <p className="banner-body">
              Sign-in is refused and every API key below is rejected, including keys that still show
              as active with quota remaining. Re-enabling restores them as they are — nothing needs
              reissuing.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-kpi">
        <Kpi label="Account status" value={disabled ? "Disabled" : "Active"} />
        <Kpi label="Active keys" value={formatCount(liveKeys.length)} />
        <Kpi
          label="Quota remaining"
          value={formatTokensCompact(quotaAtRisk)}
          title={`${formatCount(quotaAtRisk)} weighted tokens across active keys`}
        />
        <Kpi
          label="Last sign-in"
          value={user.lastLoginAt === null ? "Never" : formatRelative(user.lastLoginAt)}
          {...(user.lastLoginAt === null ? {} : { title: formatUtc(user.lastLoginAt) })}
        />
      </div>

      <Card title="Account">
        <dl className="dl">
          <dt>Username</dt>
          <dd>{user.username}</dd>

          <dt>Customer id</dt>
          <dd className="mono">{user.id}</dd>

          <dt>Role</dt>
          <dd>
            {user.role === "admin" ? (
              <Chip tone="info">admin</Chip>
            ) : (
              <Chip tone="neutral">user</Chip>
            )}
          </dd>

          <dt>Signed up</dt>
          <dd className="mono">{formatUtc(user.createdAt)}</dd>

          <dt>Last sign-in</dt>
          <dd className="mono">
            {user.lastLoginAt === null ? (
              <span className="field-hint">never</span>
            ) : (
              formatUtc(user.lastLoginAt)
            )}
          </dd>

          <dt>Contact</dt>
          <dd>
            {/*
              Not an omission from this page: §12 records a username and a password
              hash and nothing else, so there is no address to reach this customer
              at. It matters here because it decides how a password reset is
              delivered.
            */}
            <span className="field-hint">
              None on file. Accounts are username-only, so a reset password must be handed over out
              of band.
            </span>
          </dd>
        </dl>
      </Card>

      <Card
        title="Account actions"
        hint="Both are recorded in the audit log with the reason given."
      >
        <div className="btn-row">
          <ConfirmDialog
            triggerLabel={disabled ? "Enable account" : "Disable account"}
            triggerClassName={`btn btn-sm ${disabled ? "btn-primary" : "btn-danger"}`}
            title={disabled ? `Enable ${user.username}` : `Disable ${user.username}`}
            description={
              disabled
                ? "Restores sign-in and makes the account's existing API keys work again. Nothing is reissued."
                : "Refuses sign-in and rejects every API key this account holds. Reversible by enabling it again."
            }
            targetLabel={`${user.username} (${user.id})`}
            // Only when cutting off. Restoring service is the recovery direction
            // and does not need a warning banner.
            {...(disabled
              ? {}
              : {
                  blastRadius:
                    liveKeys.length === 0
                      ? "This account holds no active keys, so no live traffic stops. Sign-in is refused from now on."
                      : `${formatCount(liveKeys.length)} active ${
                          liveKeys.length === 1 ? "key stops" : "keys stop"
                        } working immediately, with ${formatTokensCompact(
                          quotaAtRisk,
                        )} weighted tokens of paid quota unusable while disabled. Quota is not lost — it returns on re-enable.`,
                })}
            confirmLabel={disabled ? "Enable account" : "Disable account"}
            confirmTone={disabled ? "primary" : "danger"}
            action={setUserEnabledAction}
            csrfToken={csrfToken}
            hiddenFields={{ userId: user.id, enabled: disabled ? "true" : "false" }}
            reasonPlaceholder={
              disabled ? "Why is access being restored?" : "Why is this account being disabled?"
            }
          />

          <ConfirmDialog
            triggerLabel="Reset password"
            triggerClassName="btn btn-sm btn-danger"
            title={`Reset password for ${user.username}`}
            description="Replaces the password hash immediately. The old password stops working and existing dashboard sessions are ended."
            targetLabel={`${user.username} (${user.id})`}
            blastRadius="The customer is locked out until you tell them the new password. There is no address on file to send it to, so have a channel ready before confirming. API keys are unaffected."
            confirmLabel="Reset password"
            confirmTone="danger"
            action={resetPasswordAction}
            csrfToken={csrfToken}
            hiddenFields={{ userId: user.id }}
            reasonPlaceholder="Why is the password being reset?"
          >
            <div className="field field-writeonly">
              <label className="field-label" htmlFor="newPassword">
                New password
              </label>
              <input
                id="newPassword"
                name="newPassword"
                className="input mono"
                type="password"
                required
                minLength={12}
                maxLength={200}
                // Off, not "new-password": this is not the operator's own
                // credential, and a password manager offering to save a
                // customer's password is a leak we can decline to invite.
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
              />
              <span className="field-hint">
                At least 12 characters. Hashed with Argon2id on arrival and never displayed again —
                copy it before confirming, because this page cannot show it back to you.
              </span>
            </div>
          </ConfirmDialog>
        </div>
      </Card>

      <Card
        title="API keys"
        hint={`${formatCount(keys.length)} on this account. Key values are never shown here.`}
      >
        <KeyTable
          keys={keys}
          csrfToken={csrfToken}
          showUser={false}
          emptyMessage="This customer has no API keys. Keys are issued by activating a paid order."
        />
      </Card>
    </>
  );
}
