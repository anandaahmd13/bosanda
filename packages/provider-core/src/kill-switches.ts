/**
 * Kill-switch evaluation (PLAN.md §3 "Kill switch").
 *
 * §3 requires five independent switches: global, per-region, per-model,
 * per-provider-account, and an emergency tool-use disable. This module is the
 * single place they are interpreted, so the gateway, the model listing, and the
 * scheduler cannot disagree about whether something is disabled.
 *
 * Two rules shape the design:
 *
 *  1. Precedence is fixed and coarsest-first (global -> region -> model ->
 *     account). When several switches would block a request, the operator needs
 *     to know the BROADEST reason: "the adapter is globally off" is actionable,
 *     "account 7 is disabled" is misleading noise if the global switch is also
 *     off. Reporting the narrowest reason would send an operator chasing one
 *     account during a full outage.
 *
 *  2. Tool use is NOT a block. §3 calls it an "emergency disable of tool use",
 *     and the point is to keep text generation working when tool mapping breaks.
 *     So it is reported separately as `stripTools`, and the caller removes tools
 *     from the request rather than failing it.
 *
 * Reason strings are operator-only (§12/§16/§17). They name accounts, regions,
 * and models, which are internal topology; they must be logged, never returned
 * to a client. Only `BosandaError.publicMessage` crosses that boundary.
 */

import { BosandaError } from "@bosanda/protocol";
import type { Env } from "@bosanda/config";
import type { KillSwitches } from "./types.js";

/** What a kill-switch decision looks like to the caller. */
export type KillSwitchDecision =
  | {
      allowed: true;
      /**
       * True when tool use is disabled: the caller must strip `tools` and
       * `toolChoice` from the CanonicalRequest before handing it to an adapter.
       * The request still runs as a plain completion.
       */
      stripTools: boolean;
      /** Operator-facing note, present only when tools were stripped. */
      reason?: string;
    }
  | {
      allowed: false;
      stripTools: boolean;
      /** Operator-facing reason. NEVER send this to a client. */
      reason: string;
      /** The classified error the caller should surface. */
      error: BosandaError;
    };

export type KillSwitchQuery = {
  /** Public model ID, as exposed by /v1/models. */
  model: string;
  /** Region of the candidate account, when evaluating a specific account. */
  region?: string;
  accountId?: string;
};

/**
 * Builds the KillSwitches view from validated configuration.
 *
 * §3 also requires per-account disable, but accounts live in PostgreSQL rather
 * than the environment, so `disabledAccounts` is supplied by the caller from
 * `provider_accounts.status` / feature flags. Config owns only what is truly
 * static per deploy.
 */
export function killSwitchesFromEnv(
  env: Env,
  disabledAccounts: Iterable<string> = [],
): KillSwitches {
  return {
    adapterEnabled: env.KIRO_DIRECT_ENABLED,
    toolUseEnabled: env.KIRO_TOOL_USE_ENABLED,
    disabledRegions: new Set(env.KIRO_DISABLED_REGIONS),
    disabledModels: new Set(env.KIRO_DISABLED_MODELS),
    disabledAccounts: new Set(disabledAccounts),
  };
}

/**
 * Evaluates every switch in precedence order.
 *
 * Error-code choices, per §8:
 *  - global off        -> `adapter_disabled` (503). §3: "Existing keys remain
 *                         visible but API requests return a sanitized 503."
 *  - region/model off  -> `adapter_disabled` (503) as well. This is a temporary
 *                         operator action, not a statement that the model never
 *                         existed, so 503 (retry later) is more honest than 404.
 *  - account off       -> `adapter_disabled` (503).
 *
 * All four map to the same public message ("This model is temporarily
 * unavailable."), which is exactly the sanitization §3 asks for: the client
 * learns nothing about which internal switch fired.
 */
export function evaluateKillSwitches(
  switches: KillSwitches,
  query: KillSwitchQuery,
): KillSwitchDecision {
  // Tool-use state is computed first because it applies to every outcome, but it
  // never blocks on its own.
  const stripTools = !switches.toolUseEnabled;
  const toolsReason = stripTools
    ? "tool use disabled by KIRO_TOOL_USE_ENABLED=false; tools stripped from request"
    : undefined;

  const blocked = (reason: string): KillSwitchDecision => ({
    allowed: false,
    stripTools,
    reason,
    error: new BosandaError("adapter_disabled", { internalDetail: reason }),
  });

  // 1. Global (broadest).
  if (!switches.adapterEnabled) {
    return blocked("global kill switch: KIRO_DIRECT_ENABLED=false");
  }

  // 2. Region.
  if (query.region !== undefined && switches.disabledRegions.has(query.region)) {
    return blocked(`region "${query.region}" disabled by KIRO_DISABLED_REGIONS`);
  }

  // 3. Model.
  if (switches.disabledModels.has(query.model)) {
    return blocked(`model "${query.model}" disabled by KIRO_DISABLED_MODELS`);
  }

  // 4. Account (narrowest).
  if (query.accountId !== undefined && switches.disabledAccounts.has(query.accountId)) {
    return blocked(`provider account "${query.accountId}" disabled by operator`);
  }

  return toolsReason === undefined
    ? { allowed: true, stripTools }
    : { allowed: true, stripTools, reason: toolsReason };
}

/**
 * Whether a model may appear in /v1/models.
 *
 * §3: "hiding all Kiro models from /v1/models when the adapter is globally
 * disabled". Per-account disables are irrelevant here — a model stays listed
 * while at least one account could serve it, and account eligibility is the
 * scheduler's business.
 */
export function isModelPubliclyVisible(switches: KillSwitches, model: string): boolean {
  if (!switches.adapterEnabled) return false;
  return !switches.disabledModels.has(model);
}
