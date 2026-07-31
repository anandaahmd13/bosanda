/** All timestamps are UTC (PLAN.md §14). */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Key validity window: 24 hours from confirmed payment (PLAN.md §11). */
export const KEY_VALIDITY_MS = DAY_MS;

/** Injectable clock so time-dependent logic stays testable. */
export type Clock = { now(): Date };

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date | string | number): Clock {
  const instant = new Date(at);
  return { now: () => new Date(instant.getTime()) };
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function isExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

/** Seconds remaining until `expiresAt`, floored at 0. */
export function secondsUntil(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / SECOND_MS));
}

/**
 * Exponential backoff with full jitter, capped. Used for provider cooldown
 * escalation (PLAN.md §7) and worker retries.
 */
export function backoffMs(
  attempt: number,
  baseMs = 30 * SECOND_MS,
  maxMs = 15 * MINUTE_MS,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + random() * 0.5));
}
