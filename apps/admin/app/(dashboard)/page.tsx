/**
 * / — operator overview (§15).
 *
 * Request volume, error rate, latency p50/p95/p99, weighted tokens served,
 * active streams, revenue, and a prominent kill-switch status banner.
 */

import Link from "next/link";
import type { Metadata } from "next";
import { Card, Kpi, PageHeader, TableScroll } from "../components/Card";
import { TrafficChart } from "../components/TrafficChart";
import { Chip } from "../components/Chip";
import { getOverview } from "../lib/api";
import {
  formatCount,
  formatMs,
  formatPercent,
  formatRupiah,
  formatTokensCompact,
  formatUtc,
} from "../lib/format";

export const metadata: Metadata = { title: "Overview — Bosanda operator console" };

export default async function OverviewPage() {
  const { metrics, series, killSwitchSummary } = await getOverview();

  const anyKillSwitchEngaged =
    !killSwitchSummary.adapterEnabled ||
    !killSwitchSummary.toolUseEnabled ||
    killSwitchSummary.disabledRegionCount > 0 ||
    killSwitchSummary.disabledModelCount > 0 ||
    killSwitchSummary.disabledAccountCount > 0;

  // The global adapter switch is the loudest state on the page: while it is off
  // no traffic is served at all and no payment may activate a package (§3).
  const bannerTone = !killSwitchSummary.adapterEnabled
    ? "banner-danger banner-strong"
    : anyKillSwitchEngaged
      ? "banner-warning"
      : "banner-success";

  return (
    <div className="stack">
      <PageHeader eyebrow="Operations" title="Overview">
        <Link href="/flags" className="btn btn-sm btn-ghost">
          Kill switches
        </Link>
        <Link href="/health" className="btn btn-sm btn-info">
          Health
        </Link>
      </PageHeader>

      {/*
        Kill-switch banner. role="status" rather than "alert": the page has just
        loaded, so this is state to read, not an interruption.
      */}
      <section className={`banner ${bannerTone}`} role="status" aria-labelledby="ks-title">
        <span className="banner-icon" aria-hidden="true">
          {killSwitchSummary.adapterEnabled ? (anyKillSwitchEngaged ? "⚑" : "✓") : "⏻"}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="banner-title" id="ks-title">
            {killSwitchSummary.adapterEnabled
              ? anyKillSwitchEngaged
                ? "Serving traffic with kill switches engaged"
                : "All kill switches clear — serving normally"
              : "GLOBAL KILL SWITCH ENGAGED — no traffic is being served"}
          </div>
          <p className="banner-body">
            {killSwitchSummary.adapterEnabled
              ? "The global adapter is on. Scoped switches below restrict part of the fleet."
              : "Every API request is returning a sanitized 503 and Kiro models are hidden from /v1/models. No payment can activate a package while this is off."}
          </p>
          <div className="btn-row" style={{ marginTop: 10 }}>
            <Chip tone={killSwitchSummary.adapterEnabled ? "success" : "danger"}>
              Global adapter {killSwitchSummary.adapterEnabled ? "on" : "OFF"}
            </Chip>
            <Chip tone={killSwitchSummary.toolUseEnabled ? "success" : "danger"}>
              Tool use {killSwitchSummary.toolUseEnabled ? "on" : "OFF"}
            </Chip>
            {/*
              KIRO_DIRECT_ENABLED is an env-level flag, not a runtime toggle. It
              defaults to false until the M0 compatibility gate is signed off
              (docs/IMPLEMENTATION-STATUS.md "Known blocker").
            */}
            <Chip tone={killSwitchSummary.kiroDirectEnabled ? "success" : "warning"}>
              KIRO_DIRECT_ENABLED={String(killSwitchSummary.kiroDirectEnabled)}
            </Chip>
            <Chip tone={killSwitchSummary.disabledRegionCount > 0 ? "warning" : "neutral"}>
              {killSwitchSummary.disabledRegionCount} regions off
            </Chip>
            <Chip tone={killSwitchSummary.disabledModelCount > 0 ? "warning" : "neutral"}>
              {killSwitchSummary.disabledModelCount} models off
            </Chip>
            <Chip tone={killSwitchSummary.disabledAccountCount > 0 ? "warning" : "neutral"}>
              {killSwitchSummary.disabledAccountCount} accounts off
            </Chip>
          </div>
        </div>
      </section>

      <div className="grid grid-kpi">
        <Kpi
          label="Requests (24h)"
          value={formatCount(metrics.requestCount)}
          chip="⇅"
          delta={`${formatCount(metrics.activeStreams)} streaming now`}
        />
        <Kpi
          label="Error rate (24h)"
          value={formatPercent(metrics.errorRate)}
          chip="!"
          chipTone="primary"
          delta={`${formatCount(metrics.errorCount)} failed`}
          deltaDirection={metrics.errorRate > 0.02 ? "down" : "up"}
          title={`${formatCount(metrics.errorCount)} of ${formatCount(metrics.requestCount)}`}
        />
        <Kpi
          label="Weighted tokens (24h)"
          value={formatTokensCompact(metrics.weightedTokensServed)}
          chip="◇"
          title={`${formatCount(metrics.weightedTokensServed)} weighted tokens`}
        />
        <Kpi
          label="Revenue (24h)"
          value={formatRupiah(metrics.revenueIdr)}
          chip="₨"
          chipTone="primary"
        />
        <Kpi
          label="Healthy accounts"
          value={`${metrics.healthyAccounts} / ${metrics.totalAccounts}`}
          chip="⛁"
          deltaDirection={metrics.healthyAccounts < metrics.totalAccounts ? "down" : "up"}
          delta={
            metrics.healthyAccounts === 0
              ? "no healthy provider"
              : `${metrics.totalAccounts - metrics.healthyAccounts} unavailable`
          }
        />
        <Kpi label="Active streams" value={formatCount(metrics.activeStreams)} chip="~" />
      </div>

      <div className="grid grid-2">
        <Card title="Latency" hint="Time to full completion across all surfaces, last 24h.">
          <dl className="dl">
            <dt>p50</dt>
            <dd className="mono">{formatMs(metrics.latencyMs.p50)}</dd>
            <dt>p95</dt>
            <dd className="mono">{formatMs(metrics.latencyMs.p95)}</dd>
            <dt>p99</dt>
            <dd className="mono">{formatMs(metrics.latencyMs.p99)}</dd>
          </dl>
          <hr className="hr" />
          <p className="card-hint">
            Streaming turns are long by nature; p99 tracks the slowest complete turns, not
            time-to-first-byte.
          </p>
        </Card>

        <Card title="Window" hint="All figures on this page cover the same period.">
          <dl className="dl">
            <dt>Window</dt>
            <dd>{Math.round(metrics.windowSeconds / 3600)} hours</dd>
            <dt>First bucket</dt>
            <dd className="mono">{formatUtc(series[0]?.at ?? null)}</dd>
            <dt>Last bucket</dt>
            <dd className="mono">{formatUtc(series[series.length - 1]?.at ?? null)}</dd>
          </dl>
        </Card>
      </div>

      <Card title="Request volume" hint="Hourly buckets, last 24 hours.">
        <TrafficChart series={series} />

        {/*
          The chart is aria-hidden, so this table is the accessible equivalent
          rather than a duplicate. Collapsed by default to keep the page compact
          while remaining fully keyboard reachable.
        */}
        <details style={{ marginTop: 14 }}>
          <summary className="field-label" style={{ cursor: "pointer" }}>
            View chart data as a table
          </summary>
          <TableScroll label="Hourly request volume">
            <table className="table">
              <caption>Requests, errors, and weighted tokens per hour (UTC).</caption>
              <thead>
                <tr>
                  <th scope="col">Hour (UTC)</th>
                  <th scope="col" className="num">
                    Requests
                  </th>
                  <th scope="col" className="num">
                    Errors
                  </th>
                  <th scope="col" className="num">
                    Weighted tokens
                  </th>
                </tr>
              </thead>
              <tbody>
                {series.map((point) => (
                  <tr key={point.at}>
                    <th scope="row" className="mono">
                      {formatUtc(point.at)}
                    </th>
                    <td className="num">{formatCount(point.requests)}</td>
                    <td className="num">{formatCount(point.errors)}</td>
                    <td className="num">{formatCount(point.weightedTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </details>
      </Card>
    </div>
  );
}
