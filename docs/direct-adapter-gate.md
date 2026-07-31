# Kiro Direct Adapter — compatibility gate (M0)

**Status: NOT YET EXECUTED. No sub-gate has passed. The project is not cleared to launch.**

This document is the evidence record for PLAN.md §3. It is currently a template: every
result below reads `NOT-YET-EXECUTED`, because the gate requires real Kiro provider
credentials and live upstream traffic, and neither exists in the environment where this
repository was built.

Nothing in this repository may claim, imply, or default to this gate having passed.
`KIRO_DIRECT_ENABLED` defaults to `false` in `packages/config/src/env.ts` and must stay
that way until the table at the bottom of this file is filled in with real observations
and signed off.

## Why this file is empty rather than optimistic

The adapter is the highest-risk component in the system (PLAN.md §2, §3). The failure
mode being guarded against is not "the code has a bug" — it is "we built a paid product
on an upstream integration that does not actually work the way we assumed." A gate
document pre-filled with expected results would defeat its own purpose, because the
person reading it later cannot tell an assumption from an observation.

So the rule for filling this in is: **paste what you saw, not what you expected.** A
recorded failure is a useful artifact. A recorded pass that was inferred rather than
observed is worse than nothing.

`packages/provider-kiro` and the `spikes/kiro-direct` evidence harness now exist and
have extensive offline coverage. They have **not** been exercised with real Kiro credentials
or live upstream traffic, so none of that coverage constitutes a passed M0 gate.

## What "executed" requires

1. At least two real Kiro provider accounts (two, so G0.7 — token isolation — is
   actually testable rather than assumed).
2. Live upstream traffic from a machine that can reach the Kiro endpoint.
3. A real repository and a real Claude Code session for G3.
4. Captured fixtures committed under `spikes/kiro-direct/fixtures/`, with the upstream
   protocol fixture version recorded alongside each.

Credentials must never be committed. Fixtures must be scrubbed of tokens, ARNs that
identify a real account, and any prompt or response content that is not synthetic
(PLAN.md §16).

## G0 — Credential and account lifecycle

| #   | Requirement                                                        | Result           | Evidence |
| --- | ------------------------------------------------------------------ | ---------------- | -------- |
| 0.1 | Account imported without storing plaintext credentials             | NOT-YET-EXECUTED |          |
| 0.2 | Short-lived access token obtained and refreshed                    | NOT-YET-EXECUTED |          |
| 0.3 | Refresh-token rotation persisted atomically                        | NOT-YET-EXECUTED |          |
| 0.4 | Concurrent refreshes collapsed by per-account single-flight        | NOT-YET-EXECUTED |          |
| 0.5 | `profileArn` and other required metadata discovered and cached     | NOT-YET-EXECUTED |          |
| 0.6 | Invalid/revoked/expired credentials detected and sanitized in logs | NOT-YET-EXECUTED |          |
| 0.7 | Two different accounts never share tokens or metadata              | NOT-YET-EXECUTED |          |

**Credential form actually supported by direct HTTP — MUST be recorded here:**

> NOT-YET-DETERMINED.
>
> PLAN.md §3 is explicit that Kiro `ksk_...` API keys are documented for Kiro CLI
> headless authentication and that direct HTTP use of those keys **is not assumed**.
> Whoever executes this gate must write down which credential form the direct adapter
> actually accepted, and exactly how it was obtained. If `ksk_...` keys turn out not to
> work over direct HTTP, that is a G0 failure and it changes the architecture — record
> it plainly here rather than working around it quietly.

## G1 — Request protocol

Fixtures must be captured and frozen for each row.

| #   | Item                                                        | Result           | Fixture |
| --- | ----------------------------------------------------------- | ---------------- | ------- |
| 1.1 | Upstream URL and region behaviour                           | NOT-YET-EXECUTED |         |
| 1.2 | `X-Amz-Target`, content type, authorization, UA/fingerprint | NOT-YET-EXECUTED |         |
| 1.3 | Profile headers                                             | NOT-YET-EXECUTED |         |
| 1.4 | Model identifiers (public → upstream mapping)               | NOT-YET-EXECUTED |         |
| 1.5 | `conversationState` request shape                           | NOT-YET-EXECUTED |         |
| 1.6 | System prompt handling, alternating user/assistant history  | NOT-YET-EXECUTED |         |
| 1.7 | Inference configuration                                     | NOT-YET-EXECUTED |         |
| 1.8 | Model-specific cost multipliers                             | NOT-YET-EXECUTED |         |

Images are out of scope for v1 (PLAN.md §1 non-goals) and are not gated here.

## G2 — Streaming and EventStream

| #   | Requirement                                       | Result           | Evidence |
| --- | ------------------------------------------------- | ---------------- | -------- |
| 2.1 | Response arrives progressively                    | NOT-YET-EXECUTED |          |
| 2.2 | Arbitrary network chunk boundaries handled        | NOT-YET-EXECUTED |          |
| 2.3 | EventStream prelude and message CRCs validated    | NOT-YET-EXECUTED |          |
| 2.4 | Max frame and aggregate-buffer sizes enforced     | NOT-YET-EXECUTED |          |
| 2.5 | Malformed frames fail closed                      | NOT-YET-EXECUTED |          |
| 2.6 | Downstream client abort aborts the upstream fetch | NOT-YET-EXECUTED |          |
| 2.7 | Idle timeout works                                | NOT-YET-EXECUTED |          |
| 2.8 | Hard timeout works                                | NOT-YET-EXECUTED |          |
| 2.9 | Backpressure reaches the upstream response reader | NOT-YET-EXECUTED |          |

Event families observed (record the real set, not the expected one):

| Family                   | Observed?        | Notes |
| ------------------------ | ---------------- | ----- |
| `assistantResponseEvent` | NOT-YET-EXECUTED |       |
| `codeEvent`              | NOT-YET-EXECUTED |       |
| `reasoningContentEvent`  | NOT-YET-EXECUTED |       |
| `toolUseEvent`           | NOT-YET-EXECUTED |       |
| `messageStopEvent`       | NOT-YET-EXECUTED |       |
| `metricsEvent`           | NOT-YET-EXECUTED |       |
| exception/error events   | NOT-YET-EXECUTED |       |

## G3 — Claude Code tool-use gate

**If this gate fails, the project is no-go** (PLAN.md §3, verbatim). Bosanda must not
launch claiming Claude Code compatibility on a failed G3. This is not a
ship-it-and-fix-it item: it is the reason the product would exist.

The full loop that must be proven:

```text
Claude Code sends tool definitions
  → Bosanda maps them to Kiro toolSpecification
  → Kiro emits toolUseEvent
  → Bosanda emits Anthropic tool_use
  → Claude Code executes the tool locally
  → Claude Code sends tool_result
  → Bosanda maps the result back to Kiro
  → Kiro continues the turn
```

| #   | Acceptance criterion                             | Result           | Evidence |
| --- | ------------------------------------------------ | ---------------- | -------- |
| 3.1 | Stable tool call IDs                             | NOT-YET-EXECUTED |          |
| 3.2 | Incremental JSON argument streaming              | NOT-YET-EXECUTED |          |
| 3.3 | Multiple tool calls in one turn                  | NOT-YET-EXECUTED |          |
| 3.4 | Tool result correlation                          | NOT-YET-EXECUTED |          |
| 3.5 | Text before and after tool calls                 | NOT-YET-EXECUTED |          |
| 3.6 | Stop reason `tool_use` where required            | NOT-YET-EXECUTED |          |
| 3.7 | No server-side tool execution                    | NOT-YET-EXECUTED |          |
| 3.8 | Valid Claude Code behaviour on a real repository | NOT-YET-EXECUTED |          |

3.7 deserves a note: it is not only a correctness property but a security one. The
adapter must never inject filesystem, shell, or MCP tools of its own, and must never
place Bosanda secrets, paths, or environment variables into a prompt (PLAN.md §16).
Verify by inspection as well as by observation.

### A wrong reading of 3.7 that would have failed this gate

Worth recording, because the mistake is easy to make twice and it silently targets the
one criterion §3 calls a no-go.

An earlier revision of `packages/provider-kiro/src/transform.ts` enforced "no
server-side tool execution" with a NAME BLOCKLIST applied to
**client-declared** tools: a request declaring a tool matching `bash`, `shell`,
`exec`, `env`, `read_file`, `fs_*`, `mcp_*` and similar was refused with
`unsupported_capability`.

Claude Code's primary tool is named exactly `Bash`. So every real Claude Code session
with tools enabled would have been rejected outright, and 3.8 ("valid Claude Code
behaviour on a real repository") could never have passed. The check also blocked
`shell`, `exec`, `run_command`, and `env`, which other clients declare.

The reading was wrong in both directions:

- **It blocked what it should allow.** PLAN.md §6 says "Never _inject_ filesystem,
  shell, MCP, or host-environment tools" — a constraint on what BOSANDA adds to a
  request, not on what a customer declares. A client declaring `Bash` is describing a
  capability of its OWN machine. Tools execute client-side only; a declaration cannot
  make the server run anything.
- **It protected nothing.** A blocklist of names cannot catch the case that matters —
  Bosanda adding a tool called something innocuous.

The invariant is now enforced structurally by `assertNoInjectedTools`, which compares
the outbound tool set against the set the client declared and raises `internal_error`
(not `unsupported_capability`: nothing about the client's request is unsupported) for
anything extra. `isHostCapabilityToolName` remains as a classifier used to enrich that
error message, and it no longer gates traffic.

Two consequences for whoever executes this gate:

1. When testing 3.7, confirm both directions. That a host-capability name is refused is
   NOT evidence of compliance — check that a client-declared `Bash` reaches upstream
   intact AND that a tool the client never declared is refused.
2. The offline harness (`pnpm --filter kiro-direct gate:offline`) now asserts both, but
   offline evidence covers inspection only. 3.7 and 3.8 still require a real session.

## G4 — Usage and credit reconciliation

| #   | Question                                            | Result           | Evidence |
| --- | --------------------------------------------------- | ---------------- | -------- |
| 4.1 | Does `metricsEvent` supply input tokens?            | NOT-YET-EXECUTED |          |
| 4.2 | Does it supply output tokens?                       | NOT-YET-EXECUTED |          |
| 4.3 | Does it supply cached tokens?                       | NOT-YET-EXECUTED |          |
| 4.4 | Does it supply reasoning tokens?                    | NOT-YET-EXECUTED |          |
| 4.5 | Versioned fixtures of real `metricsEvent`s captured | NOT-YET-EXECUTED |          |

Whatever the answers, `@bosanda/metering` already treats partial upstream usage as
**not** authoritative and falls back to the local counter with `estimated = true`
recorded on the ledger row (PLAN.md §10). So a G4 partial result is survivable — but it
must be recorded, because it determines how much of the customer-facing quota figure is
an estimate, and §10 requires the UI to say so.

Bosanda does not claim its weighted-token ledger equals Kiro billing. Reconciliation is
an admin workflow against an observed provider balance, not an automated subtraction.

## Kill switch verification

The kill switches are built and unit-tested in `@bosanda/provider-core`
(`evaluateKillSwitches`, `killSwitchesFromEnv`, `isModelPubliclyVisible`) and surfaced
in the admin console at `/flags`. What is **not** verified is their behaviour against a
live adapter, which is what this section is for.

| #   | Requirement                                                        | Result           |
| --- | ------------------------------------------------------------------ | ---------------- |
| 5.1 | Global `KIRO_DIRECT_ENABLED=false` stops all Kiro traffic          | NOT-YET-EXECUTED |
| 5.2 | Per-region disable                                                 | NOT-YET-EXECUTED |
| 5.3 | Per-model disable                                                  | NOT-YET-EXECUTED |
| 5.4 | Per-provider-account disable                                       | NOT-YET-EXECUTED |
| 5.5 | Emergency disable of tool use                                      | NOT-YET-EXECUTED |
| 5.6 | Circuit opens automatically past the compatibility-error threshold | NOT-YET-EXECUTED |
| 5.7 | Kiro models hidden from `/v1/models` when globally disabled        | NOT-YET-EXECUTED |
| 5.8 | No payment activates a Kiro package while globally disabled        | NOT-YET-EXECUTED |
| 5.9 | Existing keys stay visible; API requests return a sanitized `503`  | NOT-YET-EXECUTED |

## Compatibility versioning

Every successful request must record: adapter version, upstream protocol fixture
version, selected persona, public and upstream model IDs, multiplier version, and
provider account ID — **never** credential data (PLAN.md §3).

Record here, after a live adapter request, which of those fields are actually populated
and where they land (`usage_events.adapter_version`,
`models.multiplier_version`, and so on):

> NOT-YET-EXECUTED.

Any deliberate change to headers, fingerprint, auth, payload, or event parsing requires
rerunning this suite **before** deployment. Bump the fixture version and add a row to
the change log below.

## Sign-off

The gate is passed only when every row above reads a real result, G3 has no failures,
and the two signatures below are present. Until then the storefront must not sell a Kiro
package.

| Field                            | Value            |
| -------------------------------- | ---------------- |
| Adapter version tested           | NOT-YET-EXECUTED |
| Upstream fixture version         | NOT-YET-EXECUTED |
| Date executed (UTC)              | NOT-YET-EXECUTED |
| Executed by                      | NOT-YET-EXECUTED |
| Accounts used (ids, never creds) | NOT-YET-EXECUTED |
| G0 verdict                       | NOT-YET-EXECUTED |
| G1 verdict                       | NOT-YET-EXECUTED |
| G2 verdict                       | NOT-YET-EXECUTED |
| G3 verdict (no-go if failed)     | NOT-YET-EXECUTED |
| G4 verdict                       | NOT-YET-EXECUTED |
| Cleared for launch by            | NOT-YET-EXECUTED |

## Change log

| Date       | Fixture version                   | What changed                                                                                                                                                                                                                                     | Suite rerun?                                                                                          |
| ---------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 2026-07-31 | `kiro-conversation-state-1-draft` | `transform.ts` no longer refuses client-declared host-capability tool names (it rejected Claude Code's `Bash`, which would have failed 3.7/3.8). Replaced with the structural `assertNoInjectedTools` check. See "A wrong reading of 3.7" above. | Offline only: repository baseline 1,480 tests / 55 files pass. No live traffic; no M0 row is cleared. |
