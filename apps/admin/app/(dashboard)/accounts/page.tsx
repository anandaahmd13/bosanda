/**
 * /accounts — the Kiro account pool (§15).
 *
 * Credential handling is the whole reason this page is careful:
 *
 *  - A credential is WRITE-ONLY. `ProviderAccount` is `.strict()` and carries no
 *    token fields, so there is nothing to render back even by accident. The only
 *    signal shown is `hasStoredCredential` plus `credentialVersion`.
 *  - Credential inputs are `type="password"`, `autoComplete="off"`,
 *    `spellCheck={false}`. A refresh token pasted into a field that a password
 *    manager or spellchecker can see is a credential leak by a slower route.
 *  - The create and rotate forms live in <ConfirmDialog>, so the value is posted
 *    once through a Server Action and never becomes part of a GET URL.
 *
 * `lastErrorClass` is a classification, never a raw upstream body (§16), so it is
 * rendered verbatim without any attempt to expand it into detail.
 */

import Link from "next/link";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { Card, EmptyState, Kpi, PageHeader, TableScroll } from "../../components/Card";
import { AccountStatusChip, BooleanChip } from "../../components/Chip";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { StatusRegion, firstParam } from "../../components/StatusRegion";
import {
  createAccountAction,
  rotateCredentialAction,
  setAccountEnabledAction,
  updateAccountAction,
  validateAccountAction,
} from "../../lib/actions";
import { listProviderAccounts } from "../../lib/api";
import { csrfCookieName, generateCsrfToken } from "../../lib/session";
import { formatCount, formatRelative, formatTokensCompact, formatUtc } from "../../lib/format";
import type { ProviderAccount } from "../../lib/schemas";

export const metadata: Metadata = { title: "Kiro pool — Bosanda operator console" };

/**
 * Shared credential input. Rendered inside a dialog form, so it posts exactly
 * once and is never reflected back into any response.
 */
function CredentialField({ id, label }: { id: string; label: string }) {
  return (
    <div className="field field-writeonly">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name="credential"
        className="input mono"
        type="password"
        required
        maxLength={8192}
        // Off, not "new-password": a browser or password manager offering to
        // remember a provider refresh token is a leak we can simply not invite.
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
      />
      <span className="field-hint">
        Write-only. Stored encrypted and never displayed again — not here, not in the audit log, not
        in any API response.
      </span>
    </div>
  );
}

function PersonaField({ id, defaultValue }: { id: string; defaultValue?: "cli" | "ide" }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Persona
      </label>
      <select
        id={id}
        name="persona"
        className="select"
        defaultValue={defaultValue ?? "cli"}
        required
      >
        <option value="cli">cli</option>
        <option value="ide">ide</option>
      </select>
      <span className="field-hint">
        Determines the client identity presented upstream. Must match how the credential was
        obtained.
      </span>
    </div>
  );
}

function AccountRow({ account, csrfToken }: { account: ProviderAccount; csrfToken: string }) {
  const disabled = account.status === "disabled";
  const coolingDown = account.cooldownUntil !== null;

  return (
    <tr>
      <th scope="row">
        {account.label}
        <div className="field-hint mono">{account.id}</div>
      </th>
      <td>
        <AccountStatusChip status={account.status} />
        {coolingDown && (
          <div className="field-hint">
            until <span className="mono">{formatUtc(account.cooldownUntil)}</span>
          </div>
        )}
      </td>
      <td className="mono">{account.region}</td>
      <td className="mono">{account.persona}</td>
      <td className="num">{formatCount(account.activeRequests)}</td>
      <td className="num" title={`error score ${account.errorScore}`}>
        {account.errorScore}
        {account.lastErrorClass !== null && (
          <div className="field-hint mono">{account.lastErrorClass}</div>
        )}
        {account.lastErrorCount24h > 0 && (
          <div className="field-hint">{formatCount(account.lastErrorCount24h)} errors / 24h</div>
        )}
      </td>
      <td className="num" title={`${formatCount(account.weightedTokens24h)} weighted tokens`}>
        {formatTokensCompact(account.weightedTokens24h)}
      </td>
      <td>
        <BooleanChip
          value={account.hasStoredCredential}
          trueLabel={`Stored (v${account.credentialVersion})`}
          falseLabel="MISSING"
          falseTone="danger"
        />
        <div className="field-hint">validated {formatRelative(account.lastValidatedAt)}</div>
      </td>
      <td>
        <div className="btn-row">
          {/*
            Validate is the one action with no reason field of consequence — it is
            a read-only probe upstream. It still goes through the same audited
            action wrapper, because it does cause an outbound request.
          */}
          <ConfirmDialog
            triggerLabel="Validate"
            triggerClassName="btn btn-sm btn-ghost"
            title={`Validate ${account.label}`}
            description="Sends one probe request upstream using this account's stored credential. Nothing is changed."
            targetLabel={account.id}
            confirmLabel="Run probe"
            confirmTone="primary"
            action={validateAccountAction}
            csrfToken={csrfToken}
            hiddenFields={{ accountId: account.id }}
            reasonPlaceholder="Why is this being checked now?"
          />

          <ConfirmDialog
            triggerLabel="Rotate credential"
            triggerClassName="btn btn-sm btn-ghost"
            title={`Rotate credential: ${account.label}`}
            description="Replaces the stored credential. The previous value is not recoverable, and in-flight requests using it may fail until the new one is picked up."
            targetLabel={account.id}
            confirmLabel="Store new credential"
            confirmTone="danger"
            action={rotateCredentialAction}
            csrfToken={csrfToken}
            hiddenFields={{ accountId: account.id }}
            reasonPlaceholder="Why is the credential being rotated?"
          >
            <CredentialField id={`rotate-${account.id}`} label="New credential" />
          </ConfirmDialog>

          <ConfirmDialog
            triggerLabel="Edit"
            triggerClassName="btn btn-sm btn-ghost"
            title={`Edit ${account.label}`}
            description="Changes routing metadata only. The stored credential is untouched."
            targetLabel={account.id}
            confirmLabel="Save changes"
            confirmTone="primary"
            action={updateAccountAction}
            csrfToken={csrfToken}
            hiddenFields={{ accountId: account.id }}
            reasonPlaceholder="What is changing and why?"
          >
            <div className="field">
              <label className="field-label" htmlFor={`label-${account.id}`}>
                Label
              </label>
              <input
                id={`label-${account.id}`}
                name="label"
                className="input"
                defaultValue={account.label}
                required
                maxLength={64}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`region-${account.id}`}>
                Region
              </label>
              <input
                id={`region-${account.id}`}
                name="region"
                className="input mono"
                defaultValue={account.region}
                required
                maxLength={32}
                spellCheck={false}
              />
            </div>
            <PersonaField id={`persona-${account.id}`} defaultValue={account.persona} />
          </ConfirmDialog>

          <ConfirmDialog
            triggerLabel={disabled ? "Enable" : "Disable"}
            triggerClassName={`btn btn-sm ${disabled ? "btn-primary" : "btn-danger"}`}
            title={disabled ? `Enable ${account.label}` : `Disable ${account.label}`}
            description={
              disabled
                ? "Returns this account to rotation immediately."
                : "Takes this account out of rotation. Nothing is deleted and the credential is kept."
            }
            targetLabel={account.id}
            {...(disabled
              ? {}
              : {
                  blastRadius: `Capacity drops by one account in ${account.region}. If this leaves no eligible account, every customer request returns a sanitized 503.`,
                })}
            confirmLabel={disabled ? "Enable account" : "Disable account"}
            confirmTone={disabled ? "primary" : "danger"}
            action={setAccountEnabledAction}
            csrfToken={csrfToken}
            hiddenFields={{ accountId: account.id, enabled: disabled ? "true" : "false" }}
          />
        </div>
      </td>
    </tr>
  );
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const jar = await cookies();
  const existing = jar.get(csrfCookieName)?.value;
  const csrfToken = existing !== undefined && existing.length > 0 ? existing : generateCsrfToken();

  const accounts = await listProviderAccounts();

  const eligible = accounts.filter((account) => account.status === "active");
  const invalid = accounts.filter((account) => account.status === "credential_invalid");
  const missingCredential = accounts.filter((account) => !account.hasStoredCredential);
  const totalActiveRequests = accounts.reduce((sum, account) => sum + account.activeRequests, 0);

  return (
    <div className="stack">
      <PageHeader eyebrow="Provider" title="Kiro pool">
        <Link href="/health" className="btn btn-sm btn-ghost">
          Health
        </Link>
        <ConfirmDialog
          triggerLabel="Add account"
          triggerClassName="btn btn-sm btn-primary"
          title="Add a Kiro account"
          description="Registers a new account and stores its credential. The account joins rotation once it validates."
          targetLabel="new provider account"
          confirmLabel="Create account"
          confirmTone="primary"
          action={createAccountAction}
          csrfToken={csrfToken}
          reasonPlaceholder="Where did this account come from?"
        >
          <div className="field">
            <label className="field-label" htmlFor="new-label">
              Label
            </label>
            <input
              id="new-label"
              name="label"
              className="input"
              required
              maxLength={64}
              placeholder="pool-07"
            />
            <span className="field-hint">
              Operator-facing name. Shown in this table and audit rows.
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="new-region">
              Region
            </label>
            <input
              id="new-region"
              name="region"
              className="input mono"
              required
              maxLength={32}
              spellCheck={false}
              placeholder="us-east-1"
            />
          </div>
          <PersonaField id="new-persona" />
          <CredentialField id="new-credential" label="Credential" />
        </ConfirmDialog>
      </PageHeader>

      <StatusRegion status={firstParam(params["status"])} error={firstParam(params["error"])} />

      {eligible.length === 0 && accounts.length > 0 && (
        <div className="banner banner-danger banner-strong" role="alert">
          <span className="banner-icon" aria-hidden="true">
            !
          </span>
          <div>
            <div className="banner-title">No account is eligible to serve traffic</div>
            <p className="banner-body">
              Every request is failing. Fix a credential or re-enable an account below.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-kpi">
        <Kpi
          label="Eligible"
          value={`${eligible.length} / ${accounts.length}`}
          chip="⛁"
          deltaDirection={eligible.length === 0 ? "down" : "up"}
          delta={
            eligible.length === accounts.length
              ? "whole pool available"
              : `${accounts.length - eligible.length} unavailable`
          }
        />
        <Kpi label="Active requests" value={formatCount(totalActiveRequests)} chip="~" />
        <Kpi
          label="Credential invalid"
          value={formatCount(invalid.length)}
          chip="⚿"
          chipTone="primary"
          deltaDirection={invalid.length > 0 ? "down" : "up"}
          delta={invalid.length > 0 ? "rotate to recover" : "none"}
        />
        <Kpi
          label="Weighted tokens (24h)"
          value={formatTokensCompact(
            accounts.reduce((sum, account) => sum + account.weightedTokens24h, 0),
          )}
          chip="◇"
        />
      </div>

      {missingCredential.length > 0 && (
        <div className="banner banner-warning" role="status">
          <span className="banner-icon" aria-hidden="true">
            ⚑
          </span>
          <div>
            <div className="banner-title">
              {missingCredential.length} account
              {missingCredential.length === 1 ? " has" : "s have"} no stored credential
            </div>
            <p className="banner-body">
              These cannot serve traffic until a credential is stored via Rotate credential.
            </p>
          </div>
        </div>
      )}

      <Card
        title="Accounts"
        hint="Credentials are write-only: this table can show that one is stored and which version, never its value."
      >
        {accounts.length === 0 ? (
          <EmptyState>
            No provider accounts yet. Add one to give the pool something to route to.
          </EmptyState>
        ) : (
          <TableScroll label="Kiro provider accounts">
            <table className="table">
              <caption className="visually-hidden">
                Every Kiro account in the pool with its routing state, error signal, and per-account
                actions.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Status</th>
                  <th scope="col">Region</th>
                  <th scope="col">Persona</th>
                  <th scope="col" className="num">
                    In flight
                  </th>
                  <th scope="col" className="num">
                    Error score
                  </th>
                  <th scope="col" className="num">
                    Tokens 24h
                  </th>
                  <th scope="col">Credential</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <AccountRow key={account.id} account={account} csrfToken={csrfToken} />
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>

      <Card title="What the error signal means">
        <dl className="dl">
          <dt>Error score</dt>
          <dd>
            A decaying counter. Crossing the threshold puts the account into cooling down and takes
            it out of rotation until the cool-down expires.
          </dd>
          <dt>Last error class</dt>
          <dd>
            A classification only — never an upstream response body. Raw upstream errors are not
            stored or surfaced (§16).
          </dd>
          <dt>Credential invalid</dt>
          <dd>
            Upstream rejected the stored credential. Rotating is the fix; validating again without
            rotating will keep failing.
          </dd>
        </dl>
        <hr className="hr" />
        <p className="card-hint">
          Per-account kill switches also live on <Link href="/flags">Kill switches</Link>. Disabling
          here and pulling the account switch there have the same routing effect; the switch page is
          the right place during an incident because it lists blast radius alongside every scope.
        </p>
      </Card>
    </div>
  );
}
