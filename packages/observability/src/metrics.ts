/**
 * In-process metrics registry (PLAN.md §17).
 *
 * Version 1 keeps counters/gauges/histograms in memory and exposes them in
 * Prometheus text format on an internal endpoint. No external metrics daemon is
 * a deployment prerequisite; scraping is optional.
 *
 * Label values must be low-cardinality: never a request ID, API key, or user ID,
 * or the registry grows without bound.
 */

export type Labels = Record<string, string>;

const serializeLabels = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key] ?? ""}`)
    .join(",");

const formatLabels = (labels: Labels): string => {
  const entries = Object.keys(labels).sort();
  if (entries.length === 0) return "";
  const inner = entries
    .map(
      (key) =>
        `${key}="${String(labels[key] ?? "")
          .replace(/(["\\])/g, "\\$1")
          .replace(/\n/g, "\\n")}"`,
    )
    .join(",");
  return `{${inner}}`;
};

type Series<T> = Map<string, { labels: Labels; value: T }>;

/** Histogram buckets in ms, tuned for TTFB and full-turn duration. */
export const DEFAULT_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000,
] as const;

export class Registry {
  private readonly counters = new Map<string, { help: string; series: Series<number> }>();
  private readonly gauges = new Map<string, { help: string; series: Series<number> }>();
  private readonly histograms = new Map<
    string,
    {
      help: string;
      buckets: readonly number[];
      series: Series<{ counts: number[]; sum: number; count: number }>;
    }
  >();

  counter(name: string, help: string): void {
    if (!this.counters.has(name)) this.counters.set(name, { help, series: new Map() });
  }

  gauge(name: string, help: string): void {
    if (!this.gauges.has(name)) this.gauges.set(name, { help, series: new Map() });
  }

  histogram(name: string, help: string, buckets: readonly number[] = DEFAULT_BUCKETS_MS): void {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, { help, buckets, series: new Map() });
    }
  }

  increment(name: string, labels: Labels = {}, by = 1): void {
    const metric = this.counters.get(name);
    if (!metric) throw new Error(`unknown counter: ${name}`);
    const key = serializeLabels(labels);
    const existing = metric.series.get(key);
    if (existing) existing.value += by;
    else metric.series.set(key, { labels, value: by });
  }

  setGauge(name: string, value: number, labels: Labels = {}): void {
    const metric = this.gauges.get(name);
    if (!metric) throw new Error(`unknown gauge: ${name}`);
    metric.series.set(serializeLabels(labels), { labels, value });
  }

  addGauge(name: string, delta: number, labels: Labels = {}): void {
    const metric = this.gauges.get(name);
    if (!metric) throw new Error(`unknown gauge: ${name}`);
    const key = serializeLabels(labels);
    const existing = metric.series.get(key);
    if (existing) existing.value += delta;
    else metric.series.set(key, { labels, value: delta });
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const metric = this.histograms.get(name);
    if (!metric) throw new Error(`unknown histogram: ${name}`);
    const key = serializeLabels(labels);
    let entry = metric.series.get(key);
    if (!entry) {
      entry = {
        labels,
        value: { counts: new Array(metric.buckets.length + 1).fill(0), sum: 0, count: 0 },
      };
      metric.series.set(key, entry);
    }
    let index = metric.buckets.findIndex((bound) => value <= bound);
    if (index === -1) index = metric.buckets.length; // +Inf bucket
    entry.value.counts[index] = (entry.value.counts[index] ?? 0) + 1;
    entry.value.sum += value;
    entry.value.count += 1;
  }

  /** Reads one counter/gauge value; primarily for assertions in tests. */
  read(name: string, labels: Labels = {}): number | undefined {
    const key = serializeLabels(labels);
    return (
      this.counters.get(name)?.series.get(key)?.value ??
      this.gauges.get(name)?.series.get(key)?.value
    );
  }

  readHistogram(name: string, labels: Labels = {}): { sum: number; count: number } | undefined {
    const entry = this.histograms.get(name)?.series.get(serializeLabels(labels));
    return entry ? { sum: entry.value.sum, count: entry.value.count } : undefined;
  }

  /** Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];

    for (const [name, metric] of this.counters) {
      lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} counter`);
      for (const { labels, value } of metric.series.values()) {
        lines.push(`${name}${formatLabels(labels)} ${value}`);
      }
    }
    for (const [name, metric] of this.gauges) {
      lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} gauge`);
      for (const { labels, value } of metric.series.values()) {
        lines.push(`${name}${formatLabels(labels)} ${value}`);
      }
    }
    for (const [name, metric] of this.histograms) {
      lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} histogram`);
      for (const { labels, value } of metric.series.values()) {
        let cumulative = 0;
        for (const [index, bound] of metric.buckets.entries()) {
          cumulative += value.counts[index] ?? 0;
          lines.push(
            `${name}_bucket${formatLabels({ ...labels, le: String(bound) })} ${cumulative}`,
          );
        }
        cumulative += value.counts[metric.buckets.length] ?? 0;
        lines.push(`${name}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${cumulative}`);
        lines.push(`${name}_sum${formatLabels(labels)} ${value.sum}`);
        lines.push(`${name}_count${formatLabels(labels)} ${value.count}`);
      }
    }

    return `${lines.join("\n")}\n`;
  }

  reset(): void {
    for (const metric of this.counters.values()) metric.series.clear();
    for (const metric of this.gauges.values()) metric.series.clear();
    for (const metric of this.histograms.values()) metric.series.clear();
  }
}

/**
 * The metric set required by PLAN.md §17. Registering up front means a typo in a
 * call site throws instead of silently creating a new series.
 */
export function createRegistry(): Registry {
  const registry = new Registry();

  registry.counter("bosanda_requests_total", "Requests by surface, model, and status");
  registry.counter("bosanda_rpm_rejections_total", "Requests rejected by rate limiting");
  registry.counter("bosanda_concurrency_rejections_total", "Requests rejected by concurrency cap");
  registry.counter("bosanda_upstream_attempts_total", "Upstream attempts including retries");
  registry.counter("bosanda_upstream_retries_total", "Retries onto another provider account");
  registry.counter("bosanda_tool_use_turns_total", "Turns that emitted at least one tool call");
  registry.counter("bosanda_tokens_total", "Tokens by kind (input/output/cached/weighted)");
  registry.counter("bosanda_usage_estimated_total", "Usage rows by authoritative vs estimated");
  registry.counter("bosanda_token_refresh_total", "Provider token refresh outcomes");
  registry.counter("bosanda_eventstream_failures_total", "EventStream parse/CRC/schema failures");
  registry.counter("bosanda_adapter_compat_errors_total", "Adapter compatibility errors");
  registry.counter("bosanda_payment_events_total", "Pakasir webhook and reconciliation outcomes");
  registry.counter("bosanda_stream_bytes_total", "Bytes streamed to clients");
  registry.counter("bosanda_stream_events_total", "Canonical events streamed to clients");

  registry.gauge("bosanda_active_requests", "Active requests by api key or provider account");
  registry.gauge("bosanda_queue_depth", "Queued requests awaiting a provider slot");
  registry.gauge("bosanda_provider_circuit_state", "0 closed, 1 half-open, 2 open");
  registry.gauge("bosanda_provider_cooldown_seconds", "Remaining cooldown per provider account");
  registry.gauge("bosanda_healthy_providers", "Count of currently eligible provider accounts");

  registry.histogram("bosanda_ttfb_ms", "Time to first byte streamed to the client");
  registry.histogram("bosanda_duration_ms", "Total turn duration");
  registry.histogram("bosanda_queue_wait_ms", "Time spent waiting for a provider slot");

  return registry;
}
