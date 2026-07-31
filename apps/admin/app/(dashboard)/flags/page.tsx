/**
 * /flags — kill switches (§3, §15).
 *
 * The most consequential page in the console. Every switch here is expressed as
 * "traffic ALLOWED when enabled", matching `FeatureFlag.enabled`, so an operator
 * never has to reason about a double negative while deciding whether to pull
 * something.
 *
 * Each toggle goes through <ConfirmDialog> with the flag's own `blastRadius`
 * text, which §3 requires be stated in plain language before a switch moves. The
 * blast radius is server-supplied rather than composed here: the count of
 * affected accounts is operational state, not something a page should guess.
 *
 * KIRO_DIRECT_ENABLED is rendered read-only. It is an env-level flag set in
 * admin.env, not a runtime toggle, and it stays false until the M0 compatibility
 * gate is signed off — this page must not imply the gate can be cleared by
 * clicking something.
 */

import type { Metadata } from "next";
import { Card, EmptyState, PageHeader, TableScroll } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { StatusRegion, firstParam } from "../../components/StatusRegion";
import { setFlagAction } from "../../lib/actions";
import { listFlags } from "../../lib/api";
import { csrfCookieName, generateCsrfToken } from "../../lib/session";
import { cookies } from "next/headers";
import { formatUtc } from "../../lib/format";
import type { FeatureFlag, FlagScope } from "../../lib/schemas";

export const metadata: Metadata = { title: "Kill switches — Bosanda operator console" };

/** Rendering order: widest blast radius first, so the global switch is never buried. */
const SCOPE_ORDER: FlagScope[] = ["global", "tool_use", "region", "model", "account"];

const SCOPE_HEADINGS: Record<FlagScope, { title: string; hint: string }> = {
  global: {
    title: "Global",
    hint: "Stops or resumes all served traffic. Nothing else on this page matters while this is off.",
  },
  tool_use: {
    title: "Tool use",
    hint: "Agentic/tool-calling requests only. Plain completions are unaffected.",
  },
  region: {
    title: "Regions",
    hint: "Removes every account in a region from the pool. Traffic shifts to the remaining regions.",
  },
  model: {
    title: "Models",
    hint: "Hides a model from /v1/models and refuses requests naming it.",
  },
  account: {
    title: "Provider accounts",
    hint: "Takes a single Kiro account out of rotation without deleting it.",
  },
};

function FlagRows({ flags, csrfToken }: { flags: FeatureFlag[]; csrfToken: string }) {
  return (
    <TableScroll label="Kill switches">
      <table className="table">
        <caption className="visually-hidden">
          Kill switches with their current state, who changed them last, and the action to toggle
          them.
        </caption>
        <thead>
          <tr>
            <th scope="col">Switch</th>
            <th scope="col">State</th>
            <th scope="col">Last changed (UTC)</th>
            <th scope="col">By</th>
            <th scope="col">
              <span className="visually-hidden">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {flags.map((flag) => (
            <tr key={flag.key}>
              <th scope="row">
                {flag.label}
                <div className="field-hint mono">{flag.key}</div>
              </th>
              <td>
                {/*
                  Wording is about traffic, not about the switch: "serving" reads
                  the same way whether the operator arrived here to stop traffic
                  or to restore it.
                */}
                <Chip tone={flag.enabled ? "success" : "danger"}>
                  {flag.enabled ? "Serving" : "STOPPED"}
                </Chip>
              </td>
              <td className="mono">{formatUtc(flag.updatedAt)}</td>
              <td>{flag.updatedBy ?? <span className="field-hint">never changed</span>}</td>
              <td>
                <ConfirmDialog
                  triggerLabel={flag.enabled ? "Stop traffic" : "Resume traffic"}
                  triggerClassName={`btn btn-sm ${flag.enabled ? "btn-danger" : "btn-primary"}`}
                  title={flag.enabled ? `Stop traffic: ${flag.label}` : `Resume: ${flag.label}`}
                  description={
                    flag.enabled
                      ? "This takes effect immediately for every customer. Read the blast radius before confirming."
                      : "This restores traffic immediately. Confirm the underlying problem is actually resolved."
                  }
                  targetLabel={flag.key}
                  // Only shown when stopping. Restoring traffic is the recovery
                  // direction and does not need a danger banner.
                  {...(flag.enabled ? { blastRadius: flag.blastRadius } : {})}
                  confirmLabel={flag.enabled ? "Stop traffic now" : "Resume traffic"}
                  confirmTone={flag.enabled ? "danger" : "primary"}
                  action={setFlagAction}
                  csrfToken={csrfToken}
                  hiddenFields={{ key: flag.key, enabled: flag.enabled ? "false" : "true" }}
                  reasonPlaceholder={
                    flag.enabled
                      ? "What is happening that requires stopping traffic?"
                      : "What was fixed?"
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export default async function FlagsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const jar = await cookies();
  const existing = jar.get(csrfCookieName)?.value;
  const csrfToken = existing !== undefined && existing.length > 0 ? existing : generateCsrfToken();

  const { flags, kiroDirectEnabled } = await listFlags();

  const engaged = flags.filter((flag) => !flag.enabled);
  const global = flags.find((flag) => flag.scope === "global");

  return (
    <div className="stack">
      <PageHeader eyebrow="Operations" title="Kill switches" />

      <StatusRegion status={firstParam(params["status"])} error={firstParam(params["error"])} />

      {/*
        Standing summary of what is currently pulled. An operator arriving mid
        incident needs this before they need the table.
      */}
      <section
        className={`banner ${
          global !== undefined && !global.enabled
            ? "banner-danger banner-strong"
            : engaged.length > 0
              ? "banner-warning"
              : "banner-success"
        }`}
        role="status"
        aria-labelledby="flags-summary"
      >
        <span className="banner-icon" aria-hidden="true">
          {engaged.length === 0 ? "✓" : "⚑"}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="banner-title" id="flags-summary">
            {engaged.length === 0
              ? "No kill switch is engaged"
              : `${engaged.length} switch${engaged.length === 1 ? "" : "es"} engaged`}
          </div>
          <p className="banner-body">
            {engaged.length === 0
              ? "Every switch is allowing traffic."
              : "Traffic is restricted. Each engaged switch is listed below with its state."}
          </p>
          {engaged.length > 0 && (
            <div className="btn-row" style={{ marginTop: 10 }}>
              {engaged.map((flag) => (
                <Chip key={flag.key} tone="danger" title={flag.blastRadius}>
                  {flag.label} stopped
                </Chip>
              ))}
            </div>
          )}
        </div>
      </section>

      {SCOPE_ORDER.map((scope) => {
        const scoped = flags.filter((flag) => flag.scope === scope);
        const heading = SCOPE_HEADINGS[scope];
        return (
          <Card key={scope} title={heading.title} hint={heading.hint}>
            {scoped.length === 0 ? (
              <EmptyState>No switches in this scope.</EmptyState>
            ) : (
              <FlagRows flags={scoped} csrfToken={csrfToken} />
            )}
          </Card>
        );
      })}

      <Card
        title="KIRO_DIRECT_ENABLED"
        hint="Environment flag, not a runtime switch. Changed in admin.env and applied by a restart."
      >
        <div className="btn-row">
          <Chip tone={kiroDirectEnabled ? "success" : "warning"}>
            KIRO_DIRECT_ENABLED={String(kiroDirectEnabled)}
          </Chip>
        </div>
        <hr className="hr" />
        <p className="card-hint">
          This gates the direct Kiro adapter. It defaults to <span className="mono">false</span> and
          must stay there until the M0 compatibility gate has actually been executed against a real
          upstream and signed off in <span className="mono">docs/direct-adapter-gate.md</span>. It
          is deliberately not togglable from this page: flipping it is a deploy-time decision that
          requires the gate evidence, not a click.
        </p>
      </Card>
    </div>
  );
}
