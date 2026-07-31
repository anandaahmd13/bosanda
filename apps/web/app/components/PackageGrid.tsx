/**
 * Package grid (PLAN.md §11, §22; DESIGN.md §4.1).
 *
 * Ten sizes, 10M..100M weighted tokens in 10M steps, Rp9.500 per 10M.
 *
 * Availability comes from the server, per size (§11: stock is manually managed
 * per package size). Three distinct states, each stated in text and not by color
 * alone:
 *   - in stock            -> "Buy" link
 *   - sold out            -> disabled, "Sold out"
 *   - disabled by admin   -> disabled, "Unavailable"
 *
 * The price rendered here is the catalog price for display. The order total is
 * always resolved server-side from the package record (§13: never trust price
 * from browser-supplied data).
 */

import Link from "next/link";
import { formatIdr, formatTokensCompact, formatTokensExact } from "../lib/format";
import { PACKAGE_SIZES } from "../lib/packages";
import type { StockEntry } from "../lib/schemas";
import { Chip } from "./Chip";

type Availability = "available" | "sold_out" | "disabled" | "unknown";

function availabilityOf(entry: StockEntry | undefined): Availability {
  if (entry === undefined) return "unknown";
  if (!entry.enabled) return "disabled";
  return entry.available > 0 ? "available" : "sold_out";
}

export function PackageGrid({
  stock,
  salesEnabled,
}: {
  stock: readonly StockEntry[];
  salesEnabled: boolean;
}) {
  // Index once rather than scanning per row.
  const byId = new Map(stock.map((entry) => [entry.packageId, entry]));

  return (
    <ul className="grid cols-3" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {PACKAGE_SIZES.map((size) => {
        const entry = byId.get(size.id);
        const availability = salesEnabled ? availabilityOf(entry) : "disabled";
        const buyable = availability === "available";
        // Prefer the server's price when present: it is authoritative and may
        // differ from the catalog if an admin changed it (§11).
        const priceIdr = entry?.priceIdr ?? size.priceIdr;
        const headingId = `pkg-${size.id}`;

        return (
          <li key={size.id} className="card" aria-labelledby={headingId}>
            <div className="row-between" style={{ marginBottom: 10 }}>
              <h3 id={headingId} style={{ margin: 0 }}>
                {formatTokensCompact(size.tokens)}
                <span className="visually-hidden"> weighted tokens</span>
              </h3>
              <AvailabilityChip availability={availability} count={entry?.available} />
            </div>

            <p className="price" style={{ margin: "0 0 2px" }}>
              {formatIdr(priceIdr)}
            </p>
            <p className="muted" style={{ margin: "0 0 14px" }}>
              {formatTokensExact(size.tokens)} weighted tokens · valid 24 hours from activation
            </p>

            {buyable ? (
              <Link
                href={`/checkout?package=${encodeURIComponent(size.id)}`}
                className="btn btn--primary"
              >
                Buy {formatTokensCompact(size.tokens)}
                <span className="visually-hidden"> weighted tokens for {formatIdr(priceIdr)}</span>
              </Link>
            ) : (
              /* A disabled <a> is not a thing, so render a real disabled button
                 rather than a link that looks dead. */
              <button type="button" className="btn btn--ghost" disabled>
                {availability === "sold_out" ? "Sold out" : "Unavailable"}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AvailabilityChip({
  availability,
  count,
}: {
  availability: Availability;
  count: number | undefined;
}) {
  switch (availability) {
    case "available":
      return (
        <Chip tone="success">
          {count !== undefined && count <= 3 ? `Only ${count} left` : "In stock"}
        </Chip>
      );
    case "sold_out":
      return <Chip tone="danger">Sold out</Chip>;
    case "disabled":
      return <Chip tone="neutral">Unavailable</Chip>;
    default:
      return <Chip tone="neutral">Stock unknown</Chip>;
  }
}
