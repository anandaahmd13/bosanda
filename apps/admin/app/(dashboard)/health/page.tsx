/**
 * /health — operational health (§15).
 *
 * Read-only by design. Nothing here mutates: the page an operator opens while
 * diagnosing an incident should not carry buttons that can make it worse. The
 * corresponding actions live on /flags and /accounts.
 *
 * The worst component state is promoted to a banner so the headline is readable
 * without scanning the table. Provider-pool and reconciliation figures get their
 * own cards because they are the two things that most often explain a customer
 * complaint: no eligible account means 503s, and reconciliation lag means a paid
 * order that has not activated yet (§13).
 */

import Link from "next/link";
import type { Metadata } from "next";
import { Card, Kpi, PageHeader, TableScroll } from "../../components/Card";
import { Chip, HealthStateChip } from "../../components/Chip";
import { getHealth } from "../../lib/api";
import { formatCount, formatRelative, formatUtc } from "../../lib/format";
import type { HealthComponent } from "../../lib/schemas";

export const metadata: Metadata = { title: "Health — Bosanda operator console" };

/** Worst-first, so "down" cannot be hidden below a screenful of "healthy". */
const STATE_RANK: Record<HealthComponent["state"], number> = { down: 0, degraded: 1, healthy: 2 };

/** Reconciliation lag past this is worth surfacing as a warning (§13 step 8). */
const RECONCILE_LAG_WARN_SECONDS = 900;

export default async function HealthPage() {
  const { components, providerPool, reconciliation } = await getHealth();

  const sorted = [...components].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
  const down = components.filter((component) => component.state === "down");
  const degraded = components.filter((component) => component.state === "degraded");

  const eligible = providerPool.healthy;
  const poolTotal =
    providerPool.healthy +
    providerPool.coolingDown +
    providerPool.credentialInvalid +
    providerPool.disabled;

  const lagSeconds = reconciliation.lagSeconds;
  const lagStale = lagSeconds !== null && lagSeconds > RECONCILE_LAG_WARN_SECONDS;

  return (
    <div className="stack">
      <PageHeader eyebrow="Operations" title="Health">
        <Link href="/flags" className="btn btn-sm btn-ghost">
          Kill switches
        </Link>
        <Link href="/accounts" className="btn btn-sm btn-info">
          Kiro pool
        </Link>
      </PageHeader>

      <section
        className={`banner ${
          down.length > 0
            ? "banner-danger banner-strong"
            : degraded.length > 0
              ? "banner-warning"
              : "banner-success"
        }`}
        role="status"
        aria-labelledby="health-summary"
      >
        <span className="banner-icon" aria-hidden="true">
          {down.length > 0 ? "!" : degraded.length > 0 ? "⚑" : "✓"}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="banner-title" id="health-summary">
            {down.length > 0
              ? `${down.length} component${down.length === 1 ? "" : "s"} down`
              : degraded.length > 0
                ? `${degraded.length} component${degraded.length === 1 ? "" : "s"} degraded`
                : "All components healthy"}
          </div>
          <p className="banner-body">
            {down.length > 0
              ? "Customer traffic is likely affected. The table below names each component and what the check saw."
              : degraded.length > 0
                ? "Traffic is being served, but at least one component is not fully healthy."
                : "Every check reported healthy at the times shown below."}
          </p>
        </div>
      </section>

      <div className="grid grid-kpi">
        <Kpi
          label="Eligible accounts"
          value={`${eligible} / ${poolTotal}`}
          chip="⛁"
          deltaDirection={eligible === 0 ? "down" : eligible < poolTotal ? "down" : "up"}
          delta={
            eligible === 0 ? "no account can serve traffic" : `${poolTotal - eligible} not eligible`
          }
        />
        <Kpi
          label="Pending orders"
          value={formatCount(reconciliation.pendingOrders)}
          chip="⇄"
          delta="awaiting a verified webhook"
        />
        <Kpi
          label="Orders in review"
          value={formatCount(reconciliation.reviewRequiredOrders)}
          chip="⚑"
          chipTone="primary"
          deltaDirection={reconciliation.reviewRequiredOrders > 0 ? "down" : "up"}
          delta={
            reconciliation.reviewRequiredOrders > 0 ? "needs an operator decision" : "none waiting"
          }
        />
        <Kpi
          label="Reconciliation lag"
          value={lagSeconds === null ? "unknown" : `${Math.round(lagSeconds / 60)} min`}
          chip="◷"
          deltaDirection={lagStale || lagSeconds === null ? "down" : "up"}
          delta={
            lagSeconds === null
              ? "no completed run recorded"
              : lagStale
                ? "older than 15 minutes"
                : "within expected window"
          }
        />
      </div>

      <Card title="Components" hint="Worst state first. Each row is the result of one check.">
        <TableScroll label="Component health">
          <table className="table">
            <caption className="visually-hidden">
              Each monitored component, its state, what the check reported, and when it last ran.
            </caption>
            <thead>
              <tr>
                <th scope="col">Component</th>
                <th scope="col">State</th>
                <th scope="col">Detail</th>
                <th scope="col">Checked (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((component) => (
                <tr key={component.name}>
                  <th scope="row">{component.name}</th>
                  <td>
                    <HealthStateChip state={component.state} />
                  </td>
                  <td>{component.detail}</td>
                  <td className="mono" title={component.checkedAt}>
                    {formatUtc(component.checkedAt)}
                    <div className="field-hint">{formatRelative(component.checkedAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Card>

      <div className="grid grid-2">
        <Card
          title="Provider pool"
          hint="Only healthy accounts are eligible for routing. The rest are counted so an operator can see why capacity dropped."
        >
          <dl className="dl">
            <dt>Healthy</dt>
            <dd>{formatCount(providerPool.healthy)}</dd>
            <dt>Cooling down</dt>
            <dd>{formatCount(providerPool.coolingDown)}</dd>
            <dt>Credential invalid</dt>
            <dd>{formatCount(providerPool.credentialInvalid)}</dd>
            <dt>Disabled by operator</dt>
            <dd>{formatCount(providerPool.disabled)}</dd>
          </dl>
          {eligible === 0 && (
            /*
              role="alert": arriving at a zero-eligible pool is an interruption,
              not background state. Every request is failing at this point.
            */
            <div className="banner banner-danger banner-strong" role="alert">
              <span className="banner-icon" aria-hidden="true">
                !
              </span>
              <div>
                <div className="banner-title">No eligible account</div>
                <p className="banner-body">
                  Every request is returning a sanitized 503. Check credentials and cool-down state
                  on the Kiro pool page.
                </p>
              </div>
            </div>
          )}
        </Card>

        <Card
          title="Payment reconciliation"
          hint="The sweep that catches orders whose webhook never arrived (§13 step 8)."
        >
          <dl className="dl">
            <dt>Last completed run</dt>
            <dd className="mono">
              {formatUtc(reconciliation.lastRunAt)}
              <div className="field-hint">{formatRelative(reconciliation.lastRunAt)}</div>
            </dd>
            <dt>Lag</dt>
            <dd>
              {lagSeconds === null ? (
                <Chip tone="warning">unknown</Chip>
              ) : (
                <Chip tone={lagStale ? "warning" : "success"}>{formatCount(lagSeconds)}s</Chip>
              )}
            </dd>
            <dt>Pending payment</dt>
            <dd>{formatCount(reconciliation.pendingOrders)}</dd>
            <dt>Review required</dt>
            <dd>{formatCount(reconciliation.reviewRequiredOrders)}</dd>
          </dl>
          <hr className="hr" />
          <p className="card-hint">
            A pending order is not a problem on its own — a customer may simply not have paid yet.
            Lag is what matters: while the sweep is behind, a paid order can sit unactivated.{" "}
            <Link href="/orders">Review orders</Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
