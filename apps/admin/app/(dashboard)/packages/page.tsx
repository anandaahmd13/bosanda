/**
 * /packages — package sizes, prices, and stock (§11, §15).
 *
 * Stock is manually managed per size (§11, and §2 explicitly rules out deriving
 * sale capacity from the Kiro credit pool). So the numbers here are the only
 * thing standing between demand and overselling, and the page is built to make
 * the reserved/available split legible rather than collapsing it into one figure:
 *
 *  - `available` is what can still be sold.
 *  - `reserved` is held against orders awaiting payment. A reservation releases
 *    when the pending order expires or is cancelled, so a high reserved count is
 *    not necessarily lost stock.
 *  - `version` is the compare-and-swap counter (§16). Shown because a version
 *    that never moves while orders flow is a sign the stock path is stuck.
 *
 * Price edits do not touch paid orders: §11 says existing paid orders retain
 * their purchase snapshot, and the dialog states that explicitly so nobody
 * hesitates over whether a correction will rewrite history.
 */

import Link from "next/link";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { Card, EmptyState, Kpi, PageHeader, TableScroll } from "../../components/Card";
import { BooleanChip, Chip } from "../../components/Chip";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { StatusRegion, firstParam } from "../../components/StatusRegion";
import { addStockAction, updatePackageAction } from "../../lib/actions";
import { listPackages } from "../../lib/api";
import { csrfCookieName, generateCsrfToken } from "../../lib/session";
import { formatCount, formatRupiah, formatTokensCompact, formatUtc } from "../../lib/format";
import type { PackageDefinition } from "../../lib/schemas";

export const metadata: Metadata = { title: "Packages & stock — Bosanda operator console" };

/** §11: pricing is linear at Rp9.500 per 10M weighted tokens. */
const PRICE_PER_10M_IDR = 9_500;
const TOKENS_PER_UNIT = 10_000_000;

/** The reference price §11 defines for a given quota. */
function referencePriceIdr(weightedTokenQuota: number): number {
  return Math.round((weightedTokenQuota / TOKENS_PER_UNIT) * PRICE_PER_10M_IDR);
}

function PackageRow({ pkg, csrfToken }: { pkg: PackageDefinition; csrfToken: string }) {
  const reference = referencePriceIdr(pkg.weightedTokenQuota);
  const offGrid = pkg.priceIdr !== reference;

  return (
    <tr>
      <th scope="row">
        {pkg.name}
        <div className="field-hint mono">{pkg.id}</div>
      </th>
      <td className="num" title={`${formatCount(pkg.weightedTokenQuota)} weighted tokens`}>
        {formatTokensCompact(pkg.weightedTokenQuota)}
      </td>
      <td className="num">
        <span className="mono">{formatRupiah(pkg.priceIdr)}</span>
        {offGrid && (
          /*
            Not an error — §11 exists so prices CAN be changed without a deploy.
            It is flagged only so an operator can tell a deliberate promotion from
            a typo, which is the failure mode a price field invites.
          */
          <div className="field-hint">
            off the Rp9.500/10M grid (reference {formatRupiah(reference)})
          </div>
        )}
      </td>
      <td className="num">{Math.round(pkg.durationSeconds / 3600)}h</td>
      <td className="num">
        {pkg.stock.available}
        <div className="field-hint">
          {pkg.stock.reserved} reserved · v{pkg.stock.version}
        </div>
      </td>
      <td>
        <div className="btn-row">
          <BooleanChip value={pkg.active} trueLabel="On sale" falseLabel="Disabled" />
          {pkg.soldOut && <Chip tone="warning">Sold out</Chip>}
        </div>
      </td>
      <td className="mono" title={pkg.stock.updatedAt}>
        {formatUtc(pkg.stock.updatedAt)}
      </td>
      <td>
        <div className="btn-row">
          <ConfirmDialog
            triggerLabel="Adjust stock"
            triggerClassName="btn btn-sm btn-primary"
            title={`Adjust stock: ${pkg.name}`}
            description="Changes the available count by the amount entered. A negative amount removes stock; it cannot take available below zero, and it never touches reservations held by pending orders."
            targetLabel={pkg.id}
            confirmLabel="Apply adjustment"
            confirmTone="primary"
            action={addStockAction}
            csrfToken={csrfToken}
            hiddenFields={{ packageId: pkg.id }}
            reasonPlaceholder="Where is this capacity coming from, or why is it being removed?"
          >
            <div className="field">
              <label className="field-label" htmlFor={`delta-${pkg.id}`}>
                Change in units (whole numbers, may be negative)
              </label>
              <input
                id={`delta-${pkg.id}`}
                name="delta"
                className="input mono"
                type="number"
                step="1"
                required
                placeholder="10"
              />
              <span className="field-hint">
                Currently {pkg.stock.available} available and {pkg.stock.reserved} reserved. One
                new-key order consumes one unit.
              </span>
            </div>
          </ConfirmDialog>

          <ConfirmDialog
            triggerLabel="Price & sale"
            triggerClassName="btn btn-sm btn-ghost"
            title={`Edit ${pkg.name}`}
            description="Changes the listed price and whether the size is on sale. Orders already paid keep their purchase snapshot — no past order is repriced."
            targetLabel={pkg.id}
            confirmLabel="Save package"
            confirmTone="primary"
            action={updatePackageAction}
            csrfToken={csrfToken}
            hiddenFields={{ packageId: pkg.id }}
            reasonPlaceholder="Why is the price or availability changing?"
          >
            <div className="field">
              <label className="field-label" htmlFor={`price-${pkg.id}`}>
                Price in whole rupiah
              </label>
              <input
                id={`price-${pkg.id}`}
                name="priceIdr"
                className="input mono"
                type="number"
                // Integer rupiah only (§14). step=1 keeps the browser from
                // offering a decimal the server would reject anyway.
                step="1"
                min="0"
                required
                defaultValue={String(pkg.priceIdr)}
              />
              <span className="field-hint">
                Currently {formatRupiah(pkg.priceIdr)}. The §11 reference for this size is{" "}
                {formatRupiah(reference)}. No decimals — rupiah are stored as integers.
              </span>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`active-${pkg.id}`}>
                On sale
              </label>
              <select
                id={`active-${pkg.id}`}
                name="active"
                className="select"
                defaultValue={pkg.active ? "true" : "false"}
              >
                <option value="true">Yes — customers can buy this size</option>
                <option value="false">No — hide from the storefront</option>
              </select>
              <span className="field-hint">
                Disabling hides the size from checkout. Keys already sold at this size keep working.
              </span>
            </div>
          </ConfirmDialog>
        </div>
      </td>
    </tr>
  );
}

export default async function PackagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const jar = await cookies();
  const existing = jar.get(csrfCookieName)?.value;
  const csrfToken = existing !== undefined && existing.length > 0 ? existing : generateCsrfToken();

  const packages = await listPackages();

  const onSale = packages.filter((pkg) => pkg.active);
  const sellable = onSale.filter((pkg) => !pkg.soldOut && pkg.stock.available > 0);
  const soldOut = onSale.filter((pkg) => pkg.soldOut || pkg.stock.available === 0);
  const totalAvailable = packages.reduce((sum, pkg) => sum + pkg.stock.available, 0);
  const totalReserved = packages.reduce((sum, pkg) => sum + pkg.stock.reserved, 0);

  return (
    <div className="stack">
      <PageHeader eyebrow="Commerce" title="Packages & stock">
        <Link href="/orders" className="btn btn-sm btn-ghost">
          Orders
        </Link>
      </PageHeader>

      <StatusRegion status={firstParam(params["status"])} error={firstParam(params["error"])} />

      {sellable.length === 0 && (
        <div className="banner banner-danger banner-strong" role="alert">
          <span className="banner-icon" aria-hidden="true">
            !
          </span>
          <div>
            <div className="banner-title">Nothing can be sold right now</div>
            <p className="banner-body">
              {onSale.length === 0
                ? "No package size is enabled for sale."
                : "Every enabled size is out of stock. Checkout will refuse new orders until stock is added."}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-kpi">
        <Kpi
          label="Sizes on sale"
          value={`${onSale.length} / ${packages.length}`}
          chip="▤"
          delta={`${soldOut.length} of those sold out`}
          deltaDirection={soldOut.length > 0 ? "down" : "up"}
        />
        <Kpi
          label="Units available"
          value={formatCount(totalAvailable)}
          chip="⛁"
          deltaDirection={totalAvailable === 0 ? "down" : "up"}
          delta={totalAvailable === 0 ? "nothing left to sell" : "across all sizes"}
        />
        <Kpi
          label="Units reserved"
          value={formatCount(totalReserved)}
          chip="◷"
          chipTone="primary"
          delta="held for pending payments"
        />
        <Kpi
          label="Price per 10M"
          value={formatRupiah(PRICE_PER_10M_IDR)}
          chip="₨"
          delta="§11 reference grid"
        />
      </div>

      <Card
        title="Package sizes"
        hint="Stock is manual per size. Nothing is derived from upstream credit — that is a deliberate non-goal (§2)."
      >
        {packages.length === 0 ? (
          <EmptyState>No package sizes defined. Nothing is for sale.</EmptyState>
        ) : (
          <TableScroll label="Package sizes and stock">
            <table className="table">
              <caption className="visually-hidden">
                Each package size with its quota, price, validity, stock split, sale state, and
                actions.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Package</th>
                  <th scope="col" className="num">
                    Quota
                  </th>
                  <th scope="col" className="num">
                    Price
                  </th>
                  <th scope="col" className="num">
                    Validity
                  </th>
                  <th scope="col" className="num">
                    Available
                  </th>
                  <th scope="col">State</th>
                  <th scope="col">Stock updated (UTC)</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {packages.map((pkg) => (
                  <PackageRow key={pkg.id} pkg={pkg} csrfToken={csrfToken} />
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>

      <Card title="Reading the stock numbers">
        <dl className="dl">
          <dt>Available</dt>
          <dd>Units that can still be sold. Checkout refuses a size once this reaches zero.</dd>
          <dt>Reserved</dt>
          <dd>
            Held against orders awaiting payment. A reservation is released when the pending order
            expires or is cancelled, so reserved units are not necessarily lost.
          </dd>
          <dt>Version</dt>
          <dd>
            The compare-and-swap counter that makes concurrent stock changes safe. It should move
            whenever stock does; a static version alongside live orders is worth investigating.
          </dd>
          <dt>Sold out</dt>
          <dd>
            Server-computed. A size can read sold out while reserved units are still outstanding —
            those may come back.
          </dd>
        </dl>
        <hr className="hr" />
        <p className="card-hint">
          Webhook processing is idempotent and never decrements stock twice (§11), so a duplicate
          provider callback cannot show up here as a double sale. Pending and review-required order
          counts are on <Link href="/health">Health</Link>.
        </p>
      </Card>
    </div>
  );
}
