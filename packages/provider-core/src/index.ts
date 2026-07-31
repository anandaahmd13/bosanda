/**
 * @bosanda/provider-core barrel.
 *
 * types.ts is the frozen adapter contract (PLAN.md §6); everything else in this
 * package is the routing layer built on top of it (§7 routing/retry/cooldown,
 * §3 kill switches, §17 metrics).
 */

export type {
  ProviderType,
  Persona,
  AccountStatus,
  AccountHealth,
  ProviderModel,
  ProviderAdapter,
  ProviderCredentials,
  KillSwitches,
} from "./types.js";

export { AdapterRegistry, createAdapterRegistry } from "./registry.js";

export { Scheduler } from "./scheduler.js";
export type {
  SchedulableAccount,
  SelectionContext,
  SchedulerOptions,
  Lease,
  Rejection,
  RejectionReason,
} from "./scheduler.js";

export { CooldownRegistry } from "./cooldown.js";
export type { CooldownOptions, CooldownState } from "./cooldown.js";

export { CircuitBreakerRegistry, circuitStateValue } from "./circuit-breaker.js";
export type { CircuitState, CircuitBreakerOptions, CircuitSnapshot } from "./circuit-breaker.js";

export { streamWithFailover, collectWithFailover } from "./retry.js";
export type { Sink, Attempt, FailoverOptions, AttemptInfo } from "./retry.js";

export {
  evaluateKillSwitches,
  killSwitchesFromEnv,
  isModelPubliclyVisible,
} from "./kill-switches.js";
export type { KillSwitchDecision, KillSwitchQuery } from "./kill-switches.js";

export { HealthTracker } from "./health.js";
export type { HealthTrackerOptions, AccountHealthSnapshot } from "./health.js";
