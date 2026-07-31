/**
 * /audit — the audit log (§12, §15).
 *
 * Append-only and read-only. There is no delete, no edit, and no export button:
 * the value of this page is that what it shows cannot have been tidied up from
 * inside the console. Every mutation elsewhere in this app writes a row here with
 * the reason its operator typed, which is why the reason field is required in
 * `ConfirmDialog` rather than optional.
 *
 * Filters are GET so a filtered view can be pasted into an incident thread.
 *
 * Target ids are rendered as links only where a page exists to receive them —
 * guessing a route from a target type would produce dead links in the one place
 * an operator is trying to establish what happened.
 */

import Link from "next/link";
import type { Metadata } from "next";
import { Card, EmptyState, Kpi, PageHeader, TableScroll } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { FilterForm, PAGE_SIZE, Pagination, readOffset } from "../../components/Pagination";
import { firstParam } from "../../components/StatusRegion";
import { listAudit } from "../../lib/api";
import { formatCount, formatRelative, formatUtc, humanizeToken } from "../../lib/format";
import type { AuditEvent } from "../../lib/schemas";

export const metadata: Metadata = { title: "Audit log — Bosanda operator console" };

/** Target types this console has a page for. Others render as plain text. */
const TARGET_ROUTES: Record<string, (id: string) => string> = {
  user: (id) => `/users/${encodeURIComponent(id)}`,
  order: (id) => `/orders/${encodeURIComponent(id)}`,
};

const TARGET_TYPE_OPTIONS = [
  "all",
  "user",
  "api_key",
  "order",
  "package",
  "model",
  "provider_account",
  "flag",
] as const;

function readText(value: string | string[] | undefined, max = 120): string {
  const raw = firstParam(value);
  return raw === undefined ? "" : raw.trim().slice(0, max);
}

function readTargetType(value: string | string[] | undefined): string {
  const raw = readText(value, 40);
  return (TARGET_TYPE_OPTIONS as readonly string[]).includes(raw) ? raw : "all";
}

function ActorChip({ actorType }: { actorType: AuditEvent["actorType"] }) {
  if (actorType === "admin") return <Chip tone="info">operator</Chip>;
  // System rows are the reconciliation sweep and the activation worker. Marked
  // distinctly because "nobody did this by hand" is the useful fact about them.
  if (actorType === "system") return <Chip tone="neutral">system</Chip>;
  return <Chip tone="neutral">customer</Chip>;
}

function TargetCell({ event }: { event: AuditEvent }) {
  const route = TARGET_ROUTES[event.targetType];
  return (
    <>
      <div className="field-hint">{humanizeToken(event.targetType)}</div>
      {route === undefined ? (
        <span className="mono">{event.targetId}</span>
      ) : (
        <Link className="mono" href={route(event.targetId)}>
          {event.targetId}
        </Link>
      )}
    </>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const actor = readText(params["actor"]);
  const action = readText(params["action"]);
  const targetType = readTargetType(params["target_type"]);
  const offset = readOffset(params["offset"]);

  const { events, total } = await listAudit({
    ...(actor === "" ? {} : { actor }),
    ...(action === "" ? {} : { action }),
    ...(targetType === "all" ? {} : { targetType }),
    page: { limit: PAGE_SIZE, offset },
  });

  const byOperator = events.filter((event) => event.actorType === "admin").length;
  const bySystem = events.filter((event) => event.actorType === "system").length;
  // A mutation without a reason means something wrote here without going through
  // a ConfirmDialog. Usually a system row, which is expected; an operator row
  // without one is worth chasing.
  const unexplained = events.filter(
    (event) => event.actorType === "admin" && (event.reason === null || event.reason === ""),
  ).length;

  const carried: Record<string, string> = {
    ...(actor === "" ? {} : { actor }),
    ...(action === "" ? {} : { action }),
    ...(targetType === "all" ? {} : { target_type: targetType }),
  };

  return (
    <>
      <PageHeader eyebrow="Compliance" title="Audit log" />

      <div className="grid grid-kpi">
        <Kpi label="Events matching" value={formatCount(total)} />
        <Kpi label="By operator (this page)" value={formatCount(byOperator)} />
        <Kpi label="By system (this page)" value={formatCount(bySystem)} />
        <Kpi label="Operator rows with no reason" value={formatCount(unexplained)} />
      </div>

      <Card title="Filter" hint="Actor and action match as substrings. All timestamps are UTC.">
        <FilterForm action="/audit" label="Filter audit events">
          <div className="field">
            <label className="field-label" htmlFor="actor">
              Actor
            </label>
            <input
              id="actor"
              name="actor"
              className="input"
              type="search"
              defaultValue={actor}
              placeholder="operator name"
              autoComplete="off"
              maxLength={120}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="action">
              Action
            </label>
            <input
              id="action"
              name="action"
              className="input mono"
              type="search"
              defaultValue={action}
              placeholder="key.revoke"
              autoComplete="off"
              spellCheck={false}
              maxLength={120}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="target_type">
              Target type
            </label>
            <select
              id="target_type"
              name="target_type"
              className="select"
              defaultValue={targetType}
            >
              {TARGET_TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All targets" : humanizeToken(option)}
                </option>
              ))}
            </select>
          </div>
        </FilterForm>
      </Card>

      <Card title="Events" hint="Append-only. Rows cannot be edited or removed from this console.">
        {events.length === 0 ? (
          <EmptyState>
            {Object.keys(carried).length === 0
              ? "No audit events recorded yet."
              : "No event matches those filters. Clear them to see the full log."}
          </EmptyState>
        ) : (
          <TableScroll label="Audit events">
            <table className="table">
              <caption className="visually-hidden">
                Audit events with their timestamp, actor, action, target, and the reason the
                operator gave.
              </caption>
              <thead>
                <tr>
                  <th scope="col">When (UTC)</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Target</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <th scope="row" className="mono">
                      {formatUtc(event.createdAt)}
                      <div className="field-hint">{formatRelative(event.createdAt)}</div>
                    </th>
                    <td>
                      <ActorChip actorType={event.actorType} />
                      <div className="field-hint">{event.actorLabel}</div>
                    </td>
                    <td>
                      {/* Verbatim: the action token is what a later query will be
                          written against, so it is not prettified away. */}
                      <span className="mono">{event.action}</span>
                    </td>
                    <td>
                      <TargetCell event={event} />
                    </td>
                    <td>
                      {event.reason === null || event.reason === "" ? (
                        <span className="field-hint">
                          {event.actorType === "system" ? "automated" : "none recorded"}
                        </span>
                      ) : (
                        event.reason
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <Pagination
          base="/audit"
          params={carried}
          offset={offset}
          total={total}
          count={events.length}
        />
      </Card>
    </>
  );
}
