/**
 * Worker-owned metric registration.
 *
 * WHY HERE AND NOT IN `@bosanda/observability`. `createRegistry()` pre-registers the
 * metrics the GATEWAY emits. The worker emits four more, and `Registry.increment` throws
 * on an unregistered name — deliberately, so a typo is a loud failure rather than a metric
 * that silently never appears. Registering them from the app that owns them keeps the
 * frozen package unchanged and puts the names next to the code that emits them.
 *
 * `counter()`, `gauge()`, and `histogram()` are idempotent (`if (!has(name))`), so calling
 * this twice on one registry is safe and a test can call it without coordinating with
 * whatever else already ran.
 */

import type { Registry } from "@bosanda/observability";

/**
 * Bucket bounds in milliseconds for a whole job pass.
 *
 * The registry's default buckets top out at 300s, which is right for a single request and
 * wrong for a batch pass: a retention sweep over a large table can legitimately run for
 * minutes, and every one of those would land in `+Inf` and tell an operator nothing.
 * These extend to 30 minutes so a pass that is getting slower is visible before it starts
 * overlapping its own interval.
 */
export const PASS_BUCKETS_MS = [
  10, 50, 100, 500, 1_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000,
] as const;

export function registerWorkerMetrics(registry: Registry): void {
  registry.counter("bosanda_worker_passes_total", "Worker job passes by job and outcome");
  registry.counter("bosanda_worker_items_failed_total", "Items a worker pass could not process");
  registry.counter("bosanda_worker_actions_total", "Reconciliation actions taken by kind");
  registry.histogram("bosanda_worker_pass_ms", "Worker job pass duration", PASS_BUCKETS_MS);
}
