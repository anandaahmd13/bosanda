import { describe, expect, it } from "vitest";
import { Registry, createRegistry } from "@bosanda/observability";

describe("Registry", () => {
  it("throws on an unregistered metric rather than silently creating a series", () => {
    const registry = new Registry();
    expect(() => registry.increment("typo_total")).toThrow(/unknown counter/);
    expect(() => registry.setGauge("typo", 1)).toThrow(/unknown gauge/);
    expect(() => registry.observe("typo_ms", 1)).toThrow(/unknown histogram/);
  });

  it("accumulates counters per label set", () => {
    const registry = new Registry();
    registry.counter("reqs_total", "requests");

    registry.increment("reqs_total", { surface: "openai", status: "200" });
    registry.increment("reqs_total", { surface: "openai", status: "200" }, 3);
    registry.increment("reqs_total", { surface: "anthropic", status: "200" });

    expect(registry.read("reqs_total", { surface: "openai", status: "200" })).toBe(4);
    expect(registry.read("reqs_total", { surface: "anthropic", status: "200" })).toBe(1);
  });

  it("treats label order as insignificant", () => {
    const registry = new Registry();
    registry.counter("c_total", "c");
    registry.increment("c_total", { a: "1", b: "2" });
    registry.increment("c_total", { b: "2", a: "1" });
    expect(registry.read("c_total", { a: "1", b: "2" })).toBe(2);
  });

  it("supports gauge set and relative add for active-request tracking", () => {
    const registry = new Registry();
    registry.gauge("active", "active requests");

    registry.addGauge("active", 1, { key: "k1" });
    registry.addGauge("active", 1, { key: "k1" });
    registry.addGauge("active", -1, { key: "k1" });
    expect(registry.read("active", { key: "k1" })).toBe(1);

    registry.setGauge("active", 0, { key: "k1" });
    expect(registry.read("active", { key: "k1" })).toBe(0);
  });

  it("buckets histogram observations cumulatively including +Inf", () => {
    const registry = new Registry();
    registry.histogram("lat_ms", "latency", [10, 100, 1000]);

    for (const value of [5, 50, 500, 5000]) registry.observe("lat_ms", value);

    expect(registry.readHistogram("lat_ms")).toEqual({ sum: 5555, count: 4 });

    const text = registry.render();
    expect(text).toContain('lat_ms_bucket{le="10"} 1');
    expect(text).toContain('lat_ms_bucket{le="100"} 2');
    expect(text).toContain('lat_ms_bucket{le="1000"} 3');
    expect(text).toContain('lat_ms_bucket{le="+Inf"} 4');
    expect(text).toContain("lat_ms_count 4");
  });

  it("renders valid Prometheus exposition text with HELP and TYPE", () => {
    const registry = new Registry();
    registry.counter("reqs_total", "total requests");
    registry.increment("reqs_total", { surface: "openai" });

    const text = registry.render();
    expect(text).toContain("# HELP reqs_total total requests");
    expect(text).toContain("# TYPE reqs_total counter");
    expect(text).toContain('reqs_total{surface="openai"} 1');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("escapes quotes, backslashes, and newlines in label values", () => {
    const registry = new Registry();
    registry.counter("c_total", "c");
    registry.increment("c_total", { detail: 'he said "hi"\\ok\nnext' });
    const text = registry.render();
    expect(text).toContain('detail="he said \\"hi\\"\\\\ok\\nnext"');
    // A raw newline inside a label would corrupt the exposition format.
    expect(text.split("\n").filter((l) => l.startsWith("c_total")).length).toBe(1);
  });

  it("omits the brace group when there are no labels", () => {
    const registry = new Registry();
    registry.counter("c_total", "c");
    registry.increment("c_total");
    expect(registry.render()).toContain("\nc_total 1");
  });

  it("clears all series on reset but keeps registrations", () => {
    const registry = new Registry();
    registry.counter("c_total", "c");
    registry.increment("c_total", { a: "1" });
    registry.reset();

    expect(registry.read("c_total", { a: "1" })).toBeUndefined();
    expect(() => registry.increment("c_total", { a: "1" })).not.toThrow();
  });
});

describe("createRegistry", () => {
  it("registers the metric set required by PLAN.md §17", () => {
    const registry = createRegistry();

    for (const [name, labels] of [
      ["bosanda_requests_total", { surface: "anthropic", model: "m", status: "200" }],
      ["bosanda_rpm_rejections_total", {}],
      ["bosanda_concurrency_rejections_total", {}],
      ["bosanda_upstream_attempts_total", {}],
      ["bosanda_upstream_retries_total", {}],
      ["bosanda_tool_use_turns_total", {}],
      ["bosanda_tokens_total", { kind: "weighted" }],
      ["bosanda_usage_estimated_total", { estimated: "true" }],
      ["bosanda_token_refresh_total", { outcome: "success" }],
      ["bosanda_eventstream_failures_total", { reason: "crc" }],
      ["bosanda_adapter_compat_errors_total", {}],
      ["bosanda_payment_events_total", { outcome: "activated" }],
      ["bosanda_stream_bytes_total", {}],
      ["bosanda_stream_events_total", {}],
    ] as const) {
      expect(() => registry.increment(name, labels as Record<string, string>), name).not.toThrow();
    }

    for (const name of [
      "bosanda_active_requests",
      "bosanda_queue_depth",
      "bosanda_provider_circuit_state",
      "bosanda_provider_cooldown_seconds",
      "bosanda_healthy_providers",
    ]) {
      expect(() => registry.setGauge(name, 1), name).not.toThrow();
    }

    for (const name of ["bosanda_ttfb_ms", "bosanda_duration_ms", "bosanda_queue_wait_ms"]) {
      expect(() => registry.observe(name, 42), name).not.toThrow();
    }

    expect(registry.render()).toContain("bosanda_requests_total");
  });
});
