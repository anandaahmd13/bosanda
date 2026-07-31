/**
 * /models — model catalogue, multipliers, and publication (§9, §15).
 *
 * Two rules from §9 shape this page:
 *
 *  1. "A multiplier change never rewrites historical usage." The change is
 *     forward-only, so the dialog says so and the current version/effective
 *     timestamp are shown beside the value. An operator must be able to see that
 *     yesterday's invoices are not moving.
 *  2. "Model updates are staged and require admin approval before publication."
 *     Publishing is therefore an explicit, audited action, and a model whose
 *     compatibility status is not `passing` gets a blast-radius warning when
 *     published — §9's launch condition ties sales to the tool-use gate.
 *
 * The launch-condition banner is the headline: if no published model passes the
 * gate, sales must stay disabled, and that is not something an operator should
 * have to derive by reading a table.
 */

import Link from "next/link";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { Card, EmptyState, Kpi, PageHeader, TableScroll } from "../../components/Card";
import { BooleanChip, Chip, CompatibilityChip } from "../../components/Chip";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { StatusRegion, firstParam } from "../../components/StatusRegion";
import { setModelPublishedAction, updateMultiplierAction } from "../../lib/actions";
import { listModels } from "../../lib/api";
import { csrfCookieName, generateCsrfToken } from "../../lib/session";
import { formatCount, formatUtc } from "../../lib/format";
import type { Model } from "../../lib/schemas";

export const metadata: Metadata = { title: "Models — Bosanda operator console" };

function ModelRow({ model, csrfToken }: { model: Model; csrfToken: string }) {
  return (
    <tr>
      <th scope="row">
        {model.label}
        <div className="field-hint mono">{model.publicId}</div>
      </th>
      <td className="mono" title="Upstream Kiro identifier">
        {model.upstreamId}
      </td>
      <td className="num">{formatCount(model.contextWindow)}</td>
      <td className="num">
        <span className="mono">{model.multiplier}×</span>
        <div className="field-hint">
          v{model.multiplierVersion} from {formatUtc(model.multiplierEffectiveAt)}
        </div>
      </td>
      <td>
        <div className="btn-row">
          <BooleanChip value={model.supportsTools} trueLabel="Tools" falseLabel="No tools" />
          <BooleanChip
            value={model.supportsReasoning}
            trueLabel="Reasoning"
            falseLabel="No reasoning"
          />
        </div>
      </td>
      <td>
        {model.regions.length === 0 ? (
          <span className="field-hint">none</span>
        ) : (
          <span className="mono">{model.regions.join(", ")}</span>
        )}
      </td>
      <td>
        <CompatibilityChip status={model.compatibilityStatus} />
      </td>
      <td>
        <BooleanChip
          value={model.published}
          trueLabel="Published"
          falseLabel="Staged"
          falseTone="warning"
        />
      </td>
      <td>
        <div className="btn-row">
          <ConfirmDialog
            triggerLabel="Multiplier"
            triggerClassName="btn btn-sm btn-ghost"
            title={`Change multiplier: ${model.label}`}
            description="Applies to future requests only. Usage already metered keeps the multiplier version it was charged under — no historical row is rewritten."
            targetLabel={model.publicId}
            confirmLabel="Set multiplier"
            confirmTone="primary"
            action={updateMultiplierAction}
            csrfToken={csrfToken}
            hiddenFields={{ publicId: model.publicId }}
            reasonPlaceholder="Why is the cost weighting changing?"
          >
            <div className="field">
              <label className="field-label" htmlFor={`mult-${model.publicId}`}>
                Weighted-token multiplier
              </label>
              <input
                id={`mult-${model.publicId}`}
                name="multiplier"
                className="input mono"
                type="number"
                // Matches the action's own bounds (positive, max 100) so the
                // browser refuses obvious mistakes before a round trip. The
                // server check is still the one that counts.
                step="0.01"
                min="0.01"
                max="100"
                required
                defaultValue={String(model.multiplier)}
              />
              <span className="field-hint">
                Currently {model.multiplier}× (version {model.multiplierVersion}). Raising this
                makes each raw token consume more of a customer&apos;s package.
              </span>
            </div>
          </ConfirmDialog>

          <ConfirmDialog
            triggerLabel={model.published ? "Unpublish" : "Publish"}
            triggerClassName={`btn btn-sm ${model.published ? "btn-danger" : "btn-primary"}`}
            title={model.published ? `Unpublish ${model.label}` : `Publish ${model.label}`}
            description={
              model.published
                ? "Removes the model from /v1/models and refuses new requests naming it. Existing keys keep their quota."
                : "Makes the model selectable by customers and visible in /v1/models."
            }
            targetLabel={model.publicId}
            {...(model.published
              ? {
                  blastRadius:
                    "Customers with this model hardcoded in a client will start getting errors immediately. Check traffic on the overview page before pulling a busy model.",
                }
              : model.compatibilityStatus !== "passing"
                ? {
                    blastRadius: `Compatibility status is "${model.compatibilityStatus}", not "passing". §9 ties the Claude Code launch condition to the tool-use acceptance suite — publishing an unproven model can put broken tool-calling in front of paying customers.`,
                  }
                : {})}
            confirmLabel={model.published ? "Unpublish model" : "Publish model"}
            confirmTone={model.published ? "danger" : "primary"}
            action={setModelPublishedAction}
            csrfToken={csrfToken}
            hiddenFields={{
              publicId: model.publicId,
              published: model.published ? "false" : "true",
            }}
            reasonPlaceholder={
              model.published
                ? "Why is this being withdrawn?"
                : "What evidence supports publishing?"
            }
          />
        </div>
      </td>
    </tr>
  );
}

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const jar = await cookies();
  const existing = jar.get(csrfCookieName)?.value;
  const csrfToken = existing !== undefined && existing.length > 0 ? existing : generateCsrfToken();

  const models = await listModels();

  const published = models.filter((model) => model.published);
  const staged = models.filter((model) => !model.published);
  const passing = models.filter((model) => model.compatibilityStatus === "passing");

  // §9 launch condition: at least one PUBLISHED model must pass the tool-use
  // acceptance suite, otherwise sales stay disabled. Both halves are required —
  // a passing-but-staged model does not satisfy it.
  const launchReady = published.some(
    (model) => model.compatibilityStatus === "passing" && model.supportsTools,
  );

  const publishedNotPassing = published.filter((model) => model.compatibilityStatus !== "passing");

  return (
    <div className="stack">
      <PageHeader eyebrow="Provider" title="Models">
        <Link href="/flags" className="btn btn-sm btn-ghost">
          Kill switches
        </Link>
      </PageHeader>

      <StatusRegion status={firstParam(params["status"])} error={firstParam(params["error"])} />

      <section
        className={`banner ${launchReady ? "banner-success" : "banner-danger banner-strong"}`}
        role="status"
        aria-labelledby="launch-condition"
      >
        <span className="banner-icon" aria-hidden="true">
          {launchReady ? "✓" : "⏻"}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="banner-title" id="launch-condition">
            {launchReady
              ? "Launch condition met — a published model passes the tool-use gate"
              : "Launch condition NOT met — sales must stay disabled"}
          </div>
          <p className="banner-body">
            §9 requires at least one published model to pass the complete Claude Code tool-use
            acceptance suite. {launchReady ? "" : "No published model currently does. "}
            Compatibility status is set by that suite, not by this page — it cannot be marked
            passing from here.
          </p>
          <div className="btn-row" style={{ marginTop: 10 }}>
            <Chip tone={published.length > 0 ? "info" : "neutral"}>
              {published.length} published
            </Chip>
            <Chip tone={staged.length > 0 ? "warning" : "neutral"}>{staged.length} staged</Chip>
            <Chip tone={passing.length > 0 ? "success" : "danger"}>
              {passing.length} passing the gate
            </Chip>
          </div>
        </div>
      </section>

      {publishedNotPassing.length > 0 && (
        <div className="banner banner-warning" role="status">
          <span className="banner-icon" aria-hidden="true">
            ⚑
          </span>
          <div>
            <div className="banner-title">
              {publishedNotPassing.length} published model
              {publishedNotPassing.length === 1 ? " has" : "s have"} not passed the gate
            </div>
            <p className="banner-body">
              Customers can select{" "}
              <span className="mono">
                {publishedNotPassing.map((model) => model.publicId).join(", ")}
              </span>{" "}
              even though compatibility is unproven.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-kpi">
        <Kpi label="Models" value={formatCount(models.length)} chip="✦" />
        <Kpi
          label="Published"
          value={formatCount(published.length)}
          chip="◉"
          delta={`${staged.length} awaiting approval`}
        />
        <Kpi
          label="Passing gate"
          value={formatCount(passing.length)}
          chip="✓"
          chipTone="primary"
          deltaDirection={passing.length === 0 ? "down" : "up"}
          delta={passing.length === 0 ? "no model proven" : "tool-use suite"}
        />
        <Kpi
          label="Tool-capable"
          value={formatCount(models.filter((model) => model.supportsTools).length)}
          chip="⚒"
        />
      </div>

      <Card
        title="Catalogue"
        hint="A multiplier change applies going forward only. Publication is an audited approval step."
      >
        {models.length === 0 ? (
          <EmptyState>
            No models in the catalogue. Nothing can be sold or served until at least one is
            registered and passes the tool-use gate.
          </EmptyState>
        ) : (
          <TableScroll label="Model catalogue">
            <table className="table">
              <caption className="visually-hidden">
                Every model with its upstream id, context window, multiplier and version,
                capabilities, regions, compatibility status, publication state, and actions.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Upstream id</th>
                  <th scope="col" className="num">
                    Context
                  </th>
                  <th scope="col" className="num">
                    Multiplier
                  </th>
                  <th scope="col">Capabilities</th>
                  <th scope="col">Regions</th>
                  <th scope="col">Compatibility</th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <ModelRow key={model.publicId} model={model} csrfToken={csrfToken} />
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>

      <Card title="How weighting reaches a customer">
        <dl className="dl">
          <dt>Weighted token</dt>
          <dd>
            <span className="mono">(input + output) × multiplier</span>. Packages are sold in
            weighted tokens, so a 2× model consumes a package twice as fast as a 1× one.
          </dd>
          <dt>Version</dt>
          <dd>
            Each change increments the version and records an effective timestamp. Usage rows keep
            the version they were charged under, which is what makes an old invoice reproducible.
          </dd>
          <dt>Compatibility status</dt>
          <dd>
            Owned by the acceptance suite. <span className="mono">unknown</span> means it has not
            been run, not that it would pass.
          </dd>
        </dl>
      </Card>
    </div>
  );
}
