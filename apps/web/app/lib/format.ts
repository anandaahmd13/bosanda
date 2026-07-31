/**
 * Presentation helpers.
 *
 * Money is integer rupiah everywhere (PLAN.md §14: "Money is integer rupiah,
 * never a float"). Formatting is done by hand rather than with
 * `Intl.NumberFormat` so the output is byte-identical on the server and the
 * client regardless of the ICU data available in the Node build — a locale
 * mismatch here would show up as a React hydration error.
 */

/** Group digits in threes with "." — Indonesian convention. 9500 -> "9.500". */
export function groupDigits(value: number): string {
  const negative = value < 0;
  const digits = Math.abs(Math.trunc(value)).toString();

  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    // Count position from the right so the first separator lands correctly.
    const fromRight = digits.length - i;
    const char = digits[i] ?? "";
    out += char;
    if (fromRight > 1 && fromRight % 3 === 1) out += ".";
  }

  return negative ? `-${out}` : out;
}

/** Integer rupiah -> "Rp9.500". */
export function formatIdr(priceIdr: number): string {
  return `Rp${groupDigits(priceIdr)}`;
}

/**
 * Weighted tokens -> compact label ("10M", "2,5M", "980K").
 *
 * Used for headings and chart axes only. Anywhere the exact remaining balance
 * matters, render `formatTokensExact` as well so the number is never ambiguous.
 */
export function formatTokensCompact(tokens: number): string {
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000) {
    const millions = tokens / 1_000_000;
    // One decimal, comma as the decimal separator (Indonesian convention).
    const rounded = Math.round(millions * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1).replace(".", ",")}M`;
  }
  if (abs >= 1_000) {
    const thousands = Math.round(tokens / 1_000);
    return `${thousands}K`;
  }
  return tokens.toString();
}

/** Weighted tokens -> "9.500.000" (exact, grouped). */
export function formatTokensExact(tokens: number): string {
  return groupDigits(tokens);
}

/** Clamp to the 0..1 range, guarding against NaN from a bad server value. */
export function fraction(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.min(1, Math.max(0, numerator / denominator));
}

/**
 * Split a millisecond duration into whole units for a countdown.
 * Negative input clamps to zero so an expired key reads "0h 0m 0s".
 */
export function splitDuration(ms: number): { hours: number; minutes: number; seconds: number } {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

/** "3h 12m 45s" — the accessible text form of the expiry countdown. */
export function formatDuration(ms: number): string {
  const { hours, minutes, seconds } = splitDuration(ms);
  return `${hours}h ${minutes}m ${seconds}s`;
}

/**
 * Timestamps are UTC end to end (§14). Render them as an explicit UTC string
 * rather than local time: an operator reading a screenshot and an admin reading
 * the audit log must see the same instant.
 */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}
