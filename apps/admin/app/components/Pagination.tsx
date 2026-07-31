/**
 * Pagination + filter controls shared by the four list pages.
 *
 * Navigation is plain <a> links carrying query params, and the filter form is a
 * GET form. That is deliberate: these are reads, so they must NOT be POSTs —
 * §12 reserves POST for mutations, and a GET here means a page of orders can be
 * bookmarked, shared with another operator, and reloaded without re-submitting
 * anything.
 *
 * Server components only, no client JS: a list that needs hydration before it
 * can be paged is a worse list.
 */

import Link from "next/link";
import type { ReactNode } from "react";

/** Page size for every list page. Matches the api layer's own default. */
export const PAGE_SIZE = 50;

/** Reads a positive integer offset from a query param, clamping bad input to 0. */
export function readOffset(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  // Negative or non-numeric offsets would either throw or silently wrap
  // server-side, so they collapse to the first page here.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function href(base: string, params: Record<string, string>, offset: number): string {
  const search = new URLSearchParams(params);
  if (offset > 0) search.set("offset", String(offset));
  else search.delete("offset");
  const query = search.toString();
  return query.length === 0 ? base : `${base}?${query}`;
}

export function Pagination({
  base,
  params,
  offset,
  total,
  count,
}: {
  /** Path without query, e.g. "/orders". */
  base: string;
  /** Filter params to preserve across pages. `offset` is managed here. */
  params: Record<string, string>;
  offset: number;
  total: number;
  /** Rows actually on this page. */
  count: number;
}) {
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + count;
  const hasPrevious = offset > 0;
  const hasNext = last < total;

  const previousOffset = Math.max(0, offset - PAGE_SIZE);
  const nextOffset = offset + PAGE_SIZE;

  return (
    <nav className="btn-row" aria-label="Pagination" style={{ marginTop: 14 }}>
      {/*
        The range is announced politely: paging changes the whole table, and a
        screen-reader user needs to know where they landed. aria-live rather than
        role="status" because this is a persistent label, not an event.
      */}
      <span className="field-hint" aria-live="polite">
        {total === 0 ? "No results" : `Showing ${first}–${last} of ${total}`}
      </span>
      <span style={{ flex: 1 }} />
      {hasPrevious ? (
        <Link className="btn btn-sm btn-ghost" href={href(base, params, previousOffset)} rel="prev">
          ← Previous
        </Link>
      ) : (
        // A disabled span rather than a disabled link: an <a> without href is
        // not focusable, so there is nothing for a keyboard user to get stuck on.
        <span className="field-hint">← Previous</span>
      )}
      {hasNext ? (
        <Link className="btn btn-sm btn-ghost" href={href(base, params, nextOffset)} rel="next">
          Next →
        </Link>
      ) : (
        <span className="field-hint">Next →</span>
      )}
    </nav>
  );
}

/**
 * GET filter form. Resets offset on submit by simply not emitting one, so
 * changing a filter always lands on the first page of the new result set.
 */
export function FilterForm({
  action,
  children,
  label = "Filter results",
}: {
  action: string;
  children: ReactNode;
  label?: string;
}) {
  return (
    <form method="get" action={action} className="filter-row" aria-label={label}>
      {children}
      <button type="submit" className="btn btn-sm btn-primary">
        Apply
      </button>
      {/* Clearing is a link, not a reset button: reset only restores defaults in
          the form, it does not re-run the query. */}
      <Link href={action} className="btn btn-sm btn-ghost">
        Clear
      </Link>
    </form>
  );
}
