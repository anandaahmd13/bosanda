/**
 * Glass card + KPI tile (DESIGN.md §2.1, §2.2).
 *
 * The heading level is a required prop rather than hardcoded: a card can appear
 * under an <h1> on one page and under an <h2> on another, and a skipped level
 * breaks screen-reader document outline.
 */

export function Card({
  children,
  className = "",
  as: Element = "section",
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  as?: "section" | "div" | "article" | "li";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Element className={`card ${className}`.trim()} {...rest}>
      {children}
    </Element>
  );
}

export function KpiTile({
  label,
  value,
  detail,
  chip,
  tone = "info",
  headingLevel = 3,
}: {
  label: string;
  value: string;
  detail?: React.ReactNode;
  /** Short glyph or 1-2 letters for the gradient chip. */
  chip?: string;
  tone?: "info" | "primary";
  headingLevel?: 2 | 3 | 4;
}) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <Card className="card--tight">
      <div className="kpi">
        <div>
          {/* The label is the accessible name of the figure; keep it a real
              heading so the dashboard is navigable by heading. */}
          <Heading className="eyebrow" style={{ marginBottom: 6 }}>
            {label}
          </Heading>
          <span className="kpi__value">{value}</span>
          {detail !== undefined ? <div className="muted">{detail}</div> : null}
        </div>
        {chip !== undefined ? (
          // Decorative: the label already carries the meaning.
          <span
            className={`kpi__chip${tone === "primary" ? " kpi__chip--primary" : ""}`}
            aria-hidden="true"
          >
            {chip}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
