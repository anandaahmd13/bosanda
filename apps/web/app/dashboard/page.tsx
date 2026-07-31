/**
 * Dashboard overview: quota remaining, expiry countdown, recent usage (§12).
 *
 * A server component. Every read forwards the HttpOnly session cookie to the
 * gateway (§12), so nothing token-shaped reaches the browser and no `useEffect`
 * fetch exists on this page.
 *
 * Reads run concurrently: three sequential awaits would make the page as slow as
 * their sum for no reason, since none depends on another.
 */

import Link from "next/link";
import { ApiError, getAccount, getQuota, getUsage } from "../lib/api";
import { requireSessionCookie } from "../lib/session";
import { formatTokensCompact, formatTokensExact, formatUtc, fraction } from "../lib/format";
import { Card, KpiTile } from "../components/Card";
import { ExpiryCountdown } from "../components/ExpiryCountdown";
import { UsageChart } from "../components/UsageChart";
import { StatusRegion } from "../components/StatusRegion";

export const metadata = { title: "Dashboard — Bosanda" };

/** Authenticated and per-user: never prerendered, never cached. */
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await requireSessionCookie("/dashboard");

  const [account, quota, usage] = await Promise.all([
    getAccount(session),
    getQuota(session),
    getUsage(session).catch((error: unknown) => {
      // The chart is supporting detail. A usage-endpoint outage should not take
      // the quota figures — the reason the user came here — off the page.
      if (error instanceof ApiError) return null;
      throw error;
    }),
  ]);

  const used = quota.total - quota.remaining;
  const remainingFraction = fraction(quota.remaining, quota.total);
  const meterTone =
    remainingFraction <= 0.1
      ? " meter__fill--low"
      : remainingFraction <= 0.25
        ? " meter__fill--warn"
        : "";

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <p className="eyebrow">Signed in as</p>
          <h1 style={{ margin: 0 }}>{account.username}</h1>
        </div>
        <Link href="/checkout" className="btn btn--primary">
          Buy quota
        </Link>
      </div>

      {quota.activeKeyCount === 0 ? (
        <StatusRegion
          tone="warning"
          message="You have no active key. Buy quota to get one — a key is valid for 24 hours from payment."
        />
      ) : null}

      <div className="grid cols-3">
        <KpiTile
          label="Quota remaining"
          value={formatTokensCompact(quota.remaining)}
          detail={`${formatTokensExact(quota.remaining)} of ${formatTokensExact(quota.total)} weighted tokens`}
          chip="Q"
          tone="primary"
          headingLevel={2}
        />
        <KpiTile
          label="Expires in"
          value=""
          detail={
            quota.expiresAt === null ? (
              <span className="muted">No active key.</span>
            ) : (
              <>
                <ExpiryCountdown expiresAt={quota.expiresAt} />
                <div className="muted">{formatUtc(quota.expiresAt)}</div>
              </>
            )
          }
          chip="⏱"
          headingLevel={2}
        />
        <KpiTile
          label="Active keys"
          value={quota.activeKeyCount.toString()}
          detail={<Link href="/dashboard/keys">Manage keys</Link>}
          chip="⚿"
          headingLevel={2}
        />
      </div>

      <Card>
        <h2 className="card__title">Quota used</h2>
        {/* The meter is decorative; the sentence under it carries the numbers. */}
        <div className="meter" aria-hidden="true">
          <div
            className={`meter__fill${meterTone}`}
            style={{ width: `${Math.round(remainingFraction * 100)}%` }}
          />
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          {`${formatTokensExact(used)} used, ${formatTokensExact(quota.remaining)} remaining.`}
        </p>
        {quota.hasEstimatedUsage ? (
          // §10: usage is authoritative only when upstream reported complete
          // usage. Saying so is required, not optional polish.
          <p className="muted">
            Some of this usage is estimated: the upstream provider did not report complete token
            counts for every request in this window.
          </p>
        ) : null}
      </Card>

      <Card>
        <h2 className="card__title">Recent usage</h2>
        {usage === null ? (
          <p className="muted">Usage history is temporarily unavailable.</p>
        ) : (
          <UsageChart usage={usage} />
        )}
      </Card>
    </div>
  );
}
