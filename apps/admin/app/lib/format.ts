/**
 * Display formatting. Pure functions, safe in server and client components.
 *
 * Money is integer rupiah and is never converted to a float here (§14).
 * Timestamps are UTC and are rendered with an explicit "UTC" suffix so an
 * operator never has to guess the zone during an incident.
 */

/** `1234567` → `"Rp1.234.567"`. Indonesian convention: `.` groups thousands. */
export function formatRupiah(amountIdr: number): string {
  const negative = amountIdr < 0;
  const digits = Math.abs(Math.trunc(amountIdr)).toString();
  let grouped = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ".";
    grouped += digits.charAt(i);
  }
  return `${negative ? "-" : ""}Rp${grouped}`;
}

/** Plain thousands separator for counts. `48213` → `"48.213"`. */
export function formatCount(value: number): string {
  const negative = value < 0;
  const digits = Math.abs(Math.trunc(value)).toString();
  let grouped = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ".";
    grouped += digits.charAt(i);
  }
  return `${negative ? "-" : ""}${grouped}`;
}

/**
 * Compact weighted-token display. Packages are sold in 10M units, so an exact
 * digit string is noise in a KPI tile — the full value goes in a `title`.
 */
export function formatTokensCompact(tokens: number): string {
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return formatCount(tokens);
}

/** `"2026-07-31T10:00:00.000Z"` → `"2026-07-31 10:00 UTC"`. */
export function formatUtc(isoInstant: string | null): string {
  if (isoInstant === null) return "—";
  const parsed = Date.parse(isoInstant);
  if (Number.isNaN(parsed)) return "—";
  const date = new Date(parsed);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** Relative age for "last seen" columns. Always past or "in Xm" for futures. */
export function formatRelative(isoInstant: string | null, nowMs?: number): string {
  if (isoInstant === null) return "—";
  const parsed = Date.parse(isoInstant);
  if (Number.isNaN(parsed)) return "—";
  const deltaMs = (nowMs ?? Date.now()) - parsed;
  const future = deltaMs < 0;
  const seconds = Math.floor(Math.abs(deltaMs) / 1000);

  const render = (value: number, unit: string): string =>
    future ? `in ${value}${unit}` : `${value}${unit} ago`;

  if (seconds < 60) return future ? "in <1m" : "just now";
  if (seconds < 3_600) return render(Math.floor(seconds / 60), "m");
  if (seconds < 86_400) return render(Math.floor(seconds / 3_600), "h");
  return render(Math.floor(seconds / 86_400), "d");
}

/** `0.0125` → `"1,25%"`. Two decimals: an error rate of 0.4% must not read 0%. */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(2).replace(".", ",")}%`;
}

export function formatMs(ms: number): string {
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

/** Human label for a snake_case status/error class, for display only. */
export function humanizeToken(value: string): string {
  const spaced = value.replace(/[._]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
