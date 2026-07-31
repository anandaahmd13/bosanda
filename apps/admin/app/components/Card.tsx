/**
 * Glass card + KPI tile (DESIGN.md §2.1, §2.2). The atomic surfaces.
 */

import type { ReactNode } from "react";

export function Card({
  title,
  hint,
  actions,
  children,
  as: Tag = "section",
  labelledBy,
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  as?: "section" | "div" | "article";
  /** Set when the caller owns the heading and wants the region labelled by it. */
  labelledBy?: string;
}) {
  // A <section> only becomes a landmark when it has an accessible name, so the
  // heading id is wired up rather than left implicit.
  const headingId =
    title === undefined ? undefined : `card-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const labelAttr = labelledBy ?? headingId;

  return (
    <Tag className="card" {...(labelAttr === undefined ? {} : { "aria-labelledby": labelAttr })}>
      {(title !== undefined || actions !== undefined) && (
        <div className="card-head">
          <div>
            {title !== undefined && (
              <h2 className="card-title" id={headingId}>
                {title}
              </h2>
            )}
            {hint !== undefined && <p className="card-hint">{hint}</p>}
          </div>
          {actions !== undefined && <div className="btn-row">{actions}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}

export function Kpi({
  label,
  value,
  delta,
  deltaDirection,
  chip,
  chipTone = "info",
  title,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaDirection?: "up" | "down";
  /** Single glyph for the gradient chip. Decorative. */
  chip?: string;
  chipTone?: "info" | "primary";
  /** Exact value for a compacted display, surfaced on hover and to AT. */
  title?: string;
}) {
  return (
    <section className="card" aria-label={label}>
      <div className="kpi">
        <div>
          <div className="eyebrow">{label}</div>
          <div className="kpi-value" {...(title === undefined ? {} : { title })}>
            {value}
          </div>
          {delta !== undefined && (
            <div className={`kpi-delta ${deltaDirection === "down" ? "down" : "up"}`}>{delta}</div>
          )}
        </div>
        {chip !== undefined && (
          <div className={`kpi-chip${chipTone === "primary" ? " primary" : ""}`} aria-hidden="true">
            {chip}
          </div>
        )}
      </div>
    </section>
  );
}

/** Page-level heading block. Rendered once per page, above the cards. */
export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="topbar-titles">
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
      </div>
      {children !== undefined && <div className="topbar-actions">{children}</div>}
    </header>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/**
 * Horizontally scrollable table wrapper.
 *
 * `tabIndex={0}` + `role="group"` make the scroll container keyboard-operable,
 * which WCAG 2.1.1 requires for any scrollable region.
 */
export function TableScroll({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="table-scroll" tabIndex={0} role="group" aria-label={label}>
      {children}
    </div>
  );
}
