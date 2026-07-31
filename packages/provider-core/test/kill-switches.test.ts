/**
 * Kill-switch tests — PLAN.md §3 "Kill switch", §8 (error mapping), §19.
 *
 * Two things are asserted throughout: the right switch fires at the right level
 * with coarsest-first precedence, and the reason string never escapes to a
 * client (only `publicMessage` does).
 */

import { describe, expect, it } from "vitest";
import type { Env } from "@bosanda/config";
import {
  evaluateKillSwitches,
  isModelPubliclyVisible,
  killSwitchesFromEnv,
} from "@bosanda/provider-core";
import type { KillSwitches } from "@bosanda/provider-core";

const switches = (overrides: Partial<KillSwitches> = {}): KillSwitches => ({
  adapterEnabled: true,
  toolUseEnabled: true,
  disabledRegions: new Set<string>(),
  disabledModels: new Set<string>(),
  disabledAccounts: new Set<string>(),
  ...overrides,
});

const query = { model: "kiro-sonnet-4", region: "us-east-1", accountId: "acct-01" };

describe("individual switches (§3)", () => {
  it("allows the request when everything is on", () => {
    const decision = evaluateKillSwitches(switches(), query);
    expect(decision.allowed).toBe(true);
    expect(decision.stripTools).toBe(false);
    expect(decision.reason).toBeUndefined();
  });

  it("global switch blocks with adapter_disabled (503)", () => {
    const decision = evaluateKillSwitches(switches({ adapterEnabled: false }), query);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.error.code).toBe("adapter_disabled");
    expect(decision.error.status).toBe(503);
    expect(decision.reason).toContain("KIRO_DIRECT_ENABLED=false");
  });

  it("per-region switch blocks only the matching region", () => {
    const s = switches({ disabledRegions: new Set(["eu-west-1"]) });

    expect(evaluateKillSwitches(s, { ...query, region: "us-east-1" }).allowed).toBe(true);

    const blockedDecision = evaluateKillSwitches(s, { ...query, region: "eu-west-1" });
    expect(blockedDecision.allowed).toBe(false);
    expect(blockedDecision.reason).toContain('region "eu-west-1"');
  });

  it("omitting the region skips the region check", () => {
    const s = switches({ disabledRegions: new Set(["eu-west-1"]) });
    // Model-listing calls have no account, hence no region, and must not be
    // blocked by a region switch they cannot evaluate.
    expect(evaluateKillSwitches(s, { model: "kiro-sonnet-4" }).allowed).toBe(true);
  });

  it("per-model switch blocks only the matching model", () => {
    const s = switches({ disabledModels: new Set(["kiro-opus-4"]) });

    expect(evaluateKillSwitches(s, query).allowed).toBe(true);

    const blockedDecision = evaluateKillSwitches(s, { ...query, model: "kiro-opus-4" });
    expect(blockedDecision.allowed).toBe(false);
    expect(blockedDecision.reason).toContain('model "kiro-opus-4"');
  });

  it("per-account switch blocks only the matching account", () => {
    const s = switches({ disabledAccounts: new Set(["acct-07"]) });

    expect(evaluateKillSwitches(s, query).allowed).toBe(true);

    const blockedDecision = evaluateKillSwitches(s, { ...query, accountId: "acct-07" });
    expect(blockedDecision.allowed).toBe(false);
    expect(blockedDecision.reason).toContain('account "acct-07"');
  });

  it("omitting the account skips the account check", () => {
    const s = switches({ disabledAccounts: new Set(["acct-07"]) });
    expect(evaluateKillSwitches(s, { model: "kiro-sonnet-4" }).allowed).toBe(true);
  });
});

describe("precedence: coarsest reason wins (operator clarity)", () => {
  it("global beats region, model, and account", () => {
    const decision = evaluateKillSwitches(
      switches({
        adapterEnabled: false,
        disabledRegions: new Set(["us-east-1"]),
        disabledModels: new Set(["kiro-sonnet-4"]),
        disabledAccounts: new Set(["acct-01"]),
      }),
      query,
    );
    expect(decision.reason).toContain("global kill switch");
  });

  it("region beats model and account", () => {
    const decision = evaluateKillSwitches(
      switches({
        disabledRegions: new Set(["us-east-1"]),
        disabledModels: new Set(["kiro-sonnet-4"]),
        disabledAccounts: new Set(["acct-01"]),
      }),
      query,
    );
    expect(decision.reason).toContain('region "us-east-1"');
  });

  it("model beats account", () => {
    const decision = evaluateKillSwitches(
      switches({
        disabledModels: new Set(["kiro-sonnet-4"]),
        disabledAccounts: new Set(["acct-01"]),
      }),
      query,
    );
    expect(decision.reason).toContain('model "kiro-sonnet-4"');
  });

  it("every level produces the SAME sanitized public message (§3)", () => {
    const reasons = [
      switches({ adapterEnabled: false }),
      switches({ disabledRegions: new Set(["us-east-1"]) }),
      switches({ disabledModels: new Set(["kiro-sonnet-4"]) }),
      switches({ disabledAccounts: new Set(["acct-01"]) }),
    ].map((s) => {
      const decision = evaluateKillSwitches(s, query);
      if (decision.allowed) throw new Error("expected a block");
      return decision.error.publicMessage;
    });

    // A client cannot tell which switch fired.
    expect(new Set(reasons).size).toBe(1);
    // And the public message leaks no topology.
    for (const message of reasons) {
      expect(message).not.toContain("acct-01");
      expect(message).not.toContain("us-east-1");
      expect(message).not.toContain("KIRO_");
    }
  });

  it("operator reasons stay in internalDetail, not publicMessage", () => {
    const decision = evaluateKillSwitches(switches({ adapterEnabled: false }), query);
    if (decision.allowed) throw new Error("expected a block");
    expect(decision.error.internalDetail).toBe(decision.reason);
    expect(decision.error.publicMessage).not.toBe(decision.reason);
  });
});

describe("tool-use disable is reported, never a block (§3)", () => {
  it("allows the request and asks the caller to strip tools", () => {
    const decision = evaluateKillSwitches(switches({ toolUseEnabled: false }), query);
    expect(decision.allowed).toBe(true);
    expect(decision.stripTools).toBe(true);
    expect(decision.reason).toContain("tool use disabled");
  });

  it("a caller acting on stripTools produces a tool-free request", () => {
    const decision = evaluateKillSwitches(switches({ toolUseEnabled: false }), query);
    const incoming = {
      tools: [{ name: "bash" }],
      toolChoice: { type: "auto" as const },
    };
    const outgoing = decision.stripTools ? { tools: [], toolChoice: null } : incoming;

    expect(outgoing.tools).toEqual([]);
    expect(outgoing.toolChoice).toBeNull();
  });

  it("stripTools is still reported alongside a block, so the caller sees both", () => {
    const decision = evaluateKillSwitches(
      switches({ adapterEnabled: false, toolUseEnabled: false }),
      query,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.stripTools).toBe(true);
  });

  it("tool use enabled leaves requests untouched", () => {
    const decision = evaluateKillSwitches(switches({ toolUseEnabled: true }), query);
    expect(decision.stripTools).toBe(false);
  });
});

describe("killSwitchesFromEnv", () => {
  const env = (overrides: Partial<Env> = {}): Env =>
    ({
      KIRO_DIRECT_ENABLED: true,
      KIRO_TOOL_USE_ENABLED: true,
      KIRO_DISABLED_REGIONS: [],
      KIRO_DISABLED_MODELS: [],
      ...overrides,
    }) as Env;

  it("maps the four config-owned switches", () => {
    const s = killSwitchesFromEnv(
      env({
        KIRO_DIRECT_ENABLED: false,
        KIRO_TOOL_USE_ENABLED: false,
        KIRO_DISABLED_REGIONS: ["eu-west-1", "ap-southeast-1"],
        KIRO_DISABLED_MODELS: ["kiro-opus-4"],
      }),
    );

    expect(s.adapterEnabled).toBe(false);
    expect(s.toolUseEnabled).toBe(false);
    expect([...s.disabledRegions]).toEqual(["eu-west-1", "ap-southeast-1"]);
    expect([...s.disabledModels]).toEqual(["kiro-opus-4"]);
  });

  it("takes disabled accounts from the caller (they live in PostgreSQL, not env)", () => {
    const s = killSwitchesFromEnv(env(), ["acct-03", "acct-09"]);
    expect([...s.disabledAccounts]).toEqual(["acct-03", "acct-09"]);
  });

  it("defaults to no disabled accounts", () => {
    expect(killSwitchesFromEnv(env()).disabledAccounts.size).toBe(0);
  });
});

describe("isModelPubliclyVisible (§3: hide models when globally disabled)", () => {
  it("hides everything when the adapter is globally off", () => {
    expect(isModelPubliclyVisible(switches({ adapterEnabled: false }), "kiro-sonnet-4")).toBe(
      false,
    );
  });

  it("hides only the disabled model otherwise", () => {
    const s = switches({ disabledModels: new Set(["kiro-opus-4"]) });
    expect(isModelPubliclyVisible(s, "kiro-opus-4")).toBe(false);
    expect(isModelPubliclyVisible(s, "kiro-sonnet-4")).toBe(true);
  });

  it("ignores account and region disables — listing is pool-wide", () => {
    const s = switches({
      disabledAccounts: new Set(["acct-01"]),
      disabledRegions: new Set(["us-east-1"]),
    });
    expect(isModelPubliclyVisible(s, "kiro-sonnet-4")).toBe(true);
  });
});
