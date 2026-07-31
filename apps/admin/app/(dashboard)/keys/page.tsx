/**
 * /keys — API key search (§15).
 *
 * SEARCH IS BY PREFIX OR LOOKUP DIGEST ONLY. There is deliberately no field for a
 * whole key: a plaintext key must never reach this process (§12), and offering a
 * box for one would invite a customer to paste their live credential into a
 * support channel on the way here. `searchKeys` has no parameter for it either,
 * so this is enforced below the page, not just omitted from it.
 *
 * The digest field exists for the case where a customer sends a key by mistake:
 * whoever handles that computes the lookup digest elsewhere and searches with
 * that, rather than the key itself. In fixture mode a digest search matches
 * nothing, which is the honest result and not a bug.
 *
 * Nothing on this page reveals a key value. `ApiKeySummary` is `.strict()` with no
 * plaintext, ciphertext, or digest field, so there is nothing to show even if a
 * future edit tried.
 */

import type { Metadata } from "next";
import { Card, Kpi, PageHeader } from "../../components/Card";
import { FilterForm, PAGE_SIZE, Pagination, readOffset } from "../../components/Pagination";
import { KeyTable } from "../../components/KeyTable";
import { StatusRegion, firstParam } from "../../components/StatusRegion";
import { searchKeys } from "../../lib/api";
import { getOrCreateCsrfToken } from "../../lib/session";
import { formatCount, formatTokensCompact } from "../../lib/format";

export const metadata: Metadata = { title: "API keys — Bosanda operator console" };

/**
 * A prefix is short by construction. Truncating hard here also means a whole key
 * pasted into this box cannot be forwarded upstream intact.
 */
function readPrefix(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined ? "" : raw.trim().slice(0, 24);
}

/** Hex digest, fixed width. Anything else is not a digest and is dropped. */
function readDigest(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return "";
  const trimmed = raw.trim();
  return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : "";
}

export default async function KeysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const prefix = readPrefix(params["prefix"]);
  const digest = readDigest(params["digest"]);
  const offset = readOffset(params["offset"]);
  const csrfToken = await getOrCreateCsrfToken();

  const { keys, total } = await searchKeys({
    ...(prefix === "" ? {} : { prefix }),
    ...(digest === "" ? {} : { lookupDigest: digest }),
    page: { limit: PAGE_SIZE, offset },
  });

  // Something was supplied in the digest box but rejected by the format check.
  // Worth saying, rather than silently running an unfiltered search that looks
  // like a match on everything.
  const digestRejected = digest === "" && (firstParam(params["digest"]) ?? "").trim() !== "";

  const active = keys.filter((key) => key.status === "active");
  const exhausted = keys.filter((key) => key.quotaRemaining <= 0 && key.status !== "revoked");
  const quotaOnPage = active.reduce((sum, key) => sum + Math.max(0, key.quotaRemaining), 0);

  const carried: Record<string, string> = {
    ...(prefix === "" ? {} : { prefix }),
    ...(digest === "" ? {} : { digest }),
  };

  return (
    <>
      <PageHeader eyebrow="Credentials" title="API keys" />

      <StatusRegion status={firstParam(params["status"])} error={firstParam(params["error"])} />

      <div className="banner banner-info">
        <span className="banner-icon" aria-hidden="true">
          i
        </span>
        <div>
          <div className="banner-title">Never ask a customer for their key</div>
          <p className="banner-body">
            The prefix shown in their dashboard is enough to find a key here. A full key cannot be
            searched — the gateway stores a hash, not the value — and it should not be sent over
            support channels at all. If one arrives anyway, treat it as compromised and revoke it.
          </p>
        </div>
      </div>

      <div className="grid grid-kpi">
        <Kpi label="Keys matching" value={formatCount(total)} />
        <Kpi label="Active (this page)" value={formatCount(active.length)} />
        <Kpi
          label="Quota held (this page)"
          value={formatTokensCompact(quotaOnPage)}
          title={`${formatCount(quotaOnPage)} weighted tokens across active keys on this page`}
        />
        <Kpi label="Out of quota (this page)" value={formatCount(exhausted.length)} />
      </div>

      <Card title="Search" hint="Both fields are optional. Leave them empty to list recent keys.">
        <FilterForm action="/keys" label="Search API keys">
          <div className="field">
            <label className="field-label" htmlFor="prefix">
              Key prefix
            </label>
            <input
              id="prefix"
              name="prefix"
              className="input mono"
              type="search"
              defaultValue={prefix}
              placeholder="bsk_live_ab12"
              autoComplete="off"
              spellCheck={false}
              maxLength={24}
            />
            <span className="field-hint">
              The visible fragment from the customer&rsquo;s dashboard. Matched as a substring.
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="digest">
              Lookup digest
            </label>
            <input
              id="digest"
              name="digest"
              className="input mono"
              type="search"
              defaultValue={digest}
              placeholder="64 hex characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              pattern="[0-9a-fA-F]{64}"
            />
            <span className="field-hint">For a key computed elsewhere. Not the key itself.</span>
          </div>
        </FilterForm>

        {digestRejected && (
          <p className="field-hint" role="status">
            The digest was ignored: a lookup digest is exactly 64 hex characters. If you pasted a
            key, delete it from wherever you copied it and revoke the key instead.
          </p>
        )}
      </Card>

      <Card
        title="Results"
        hint={
          digest === ""
            ? `${formatCount(total)} keys. Revoking is immediate and cannot be undone.`
            : `${formatCount(total)} keys matching that digest.`
        }
      >
        <KeyTable
          keys={keys}
          csrfToken={csrfToken}
          emptyMessage={
            prefix === "" && digest === ""
              ? "No API keys yet. Keys are issued by activating a paid order."
              : "No key matches that search. Check the prefix against the customer's dashboard."
          }
        />

        <Pagination
          base="/keys"
          params={carried}
          offset={offset}
          total={total}
          count={keys.length}
        />
      </Card>
    </>
  );
}
