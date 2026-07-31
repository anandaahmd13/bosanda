# Bosanda — Final Implementation Plan

**Repository:** <https://github.com/anandaahmd13/bosanda>
**Status:** Architecture plan; implementation in progress, not cleared for deployment
**Target deployment:** Ubuntu VPS
**Public domains:**

- `https://bosanda.dev` — storefront and user dashboard
- `https://admin.bosanda.dev` — separate admin dashboard
- `https://api.bosanda.dev` — OpenAI- and Anthropic-compatible AI gateway

---

## 1. Product definition

Bosanda is a public, paid AI gateway. Version 1 exposes OpenAI-compatible and
Anthropic-compatible APIs over a pool of service-owned Kiro accounts.

The primary request path is:

```text
Claude Code / OpenAI client / Anthropic client
                    │
                    ▼
              api.bosanda.dev
        auth · quota · rate limit · routing
                    │
                    ▼
       least-loaded healthy Kiro account
                    │
                    ▼
           Kiro Direct HTTP Adapter
                    │
                    ▼
              Kiro upstream
```

### Version 1 goals

1. Support OpenAI SDK clients through `/v1/chat/completions`.
2. Support Anthropic SDK clients and Claude Code through `/v1/messages`.
3. Stream text, reasoning, tool calls, tool arguments, stop events, and usage.
4. Execute Claude Code tools on the **client device**, never on the Bosanda VPS.
5. Route requests over a pool of Kiro accounts using least-loaded selection.
6. Sell 24-hour weighted-token packages through Pakasir.
7. Provide public username/password registration, a user dashboard, and a separate
   admin dashboard.
8. Keep the provider layer extensible so official providers can be added later.

### Explicit non-goals for version 1

- Bosanda does not execute `Read`, `Edit`, `Bash`, MCP tools, or arbitrary customer
  commands on the server.
- No guest checkout.
- No email verification or automatic password recovery.
- No embeddings, image generation, audio, fine-tuning, or batch API.
- No horizontal multi-region deployment in the initial release.
- No automatic sale-capacity calculation from the Kiro credit pool; package stock is
  controlled manually by an admin.
- No runtime dependency on `kiro-cli`.

---

## 2. Critical upstream decision: Kiro Direct Adapter

### ADR-1 — Direct HTTP instead of spawning `kiro-cli`

Bosanda will communicate directly with the upstream services used by Kiro, following
the observed architecture in `aikazu/kelola-router` as a **behavioral reference**.
Bosanda will not spawn or supervise `kiro-cli` for normal production requests.

Conceptually:

```text
Bosanda → selected Kiro account → Kiro upstream
```

Technically:

```text
Bosanda
  → load encrypted provider credential
  → obtain/refresh short-lived access token
  → resolve account profile metadata
  → transform request into Kiro conversationState
  → HTTP POST to the selected Kiro upstream
  → decode AWS binary EventStream
  → emit OpenAI or Anthropic response
```

Observed upstream targets include:

```text
CLI persona: https://runtime.<region>.kiro.dev/
IDE persona: https://codewhisperer.<region>.amazonaws.com/generateAssistantResponse
Target:      AmazonCodeWhispererStreamingService.GenerateAssistantResponse
```

The CLI persona is preferred for version 1. IDE-persona support must remain behind a
separate feature flag and is not required for launch.

### Important support status

These upstream generation endpoints and their wire protocol are **not documented as a
public Kiro inference API**. The reference implementation states that parts of the
protocol were reconstructed from real Kiro CLI/IDE traffic.

Consequences:

- The integration can break without notice.
- Header, fingerprint, payload, profile, auth, or event formats may change.
- Successful technical integration does not establish contractual permission for
  public resale or account pooling.
- Production launch requires the project owner to review the Kiro terms and accept or
  resolve the resulting business/account risk.
- No code may claim that the direct adapter is an officially supported Kiro API.

### Reference-use policy

`kelola-router` is used to understand architecture, event formats, and edge cases.
Code must not be copied line-for-line unless its license and provenance are verified.
At the inspected reference commit, a README license badge was not sufficient proof of
reusable source licensing.

---

## 3. Compatibility gate and kill switch

The Direct Adapter is the highest-risk component. It must pass an isolated gate before
storefront/payment go-live.

### G0 — Credential and account lifecycle

Prove with test accounts:

1. A provider account can be imported without storing plaintext credentials.
2. Short-lived access tokens can be obtained and refreshed.
3. Refresh-token rotation is persisted atomically.
4. Concurrent refreshes are collapsed by a per-account single-flight lock.
5. Required profile metadata such as `profileArn` can be discovered and cached.
6. Invalid, revoked, or expired credentials are detected and sanitized before logging.
7. Different provider accounts never share tokens or account metadata.

Kiro `ksk_...` API keys are officially documented for Kiro CLI headless
authentication. Direct HTTP use of those keys is **not assumed**. The gate must record
which credential form the direct adapter actually supports and how it is obtained.

### G1 — Request protocol

Prove and freeze fixtures for:

- upstream URL and region behavior;
- required `X-Amz-Target`, content type, authorization, user-agent/fingerprint, and
  profile headers;
- model identifiers;
- `conversationState` request shape;
- system prompts and alternating user/assistant history;
- images, if ever enabled later;
- inference configuration;
- model-specific cost multipliers.

### G2 — Streaming and EventStream

Prove:

- response arrives progressively;
- arbitrary network chunk boundaries are handled;
- AWS EventStream prelude and message CRCs are validated;
- maximum frame and aggregate-buffer sizes are enforced;
- malformed frames fail closed;
- aborting the downstream client aborts the upstream fetch;
- idle and hard timeouts work;
- backpressure reaches the upstream response reader.

Expected event families include:

- `assistantResponseEvent` / `codeEvent`;
- `reasoningContentEvent`;
- `toolUseEvent`;
- `messageStopEvent`;
- `metricsEvent`;
- upstream exception/error events.

### G3 — Claude Code tool-use gate

Claude Code compatibility is mandatory. Prove the full loop:

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

Acceptance requires:

- stable tool call IDs;
- incremental JSON argument streaming;
- multiple tool calls;
- tool result correlation;
- text before/after tool calls;
- stop reason `tool_use` where required;
- no server-side tool execution;
- valid Claude Code behavior on a real repository.

**If this gate fails, the project is no-go.** Bosanda must not launch as a product that
claims Claude Code compatibility.

### G4 — Usage and credit reconciliation

Prove whether `metricsEvent` supplies input, output, cached, and/or reasoning token
usage. Record actual events and versioned fixtures.

Provider credit is consumed automatically by Kiro upstream. Bosanda cannot manually
subtract upstream Kiro credit. Bosanda maintains a separate customer quota ledger and
provides an admin reconciliation workflow against the provider's observed Kiro credit
balance.

### Kill switch

The admin system must support:

- global `KIRO_DIRECT_ENABLED=false`;
- per-region disable;
- per-model disable;
- per-provider-account disable;
- emergency disable of tool use;
- automatic circuit opening when compatibility errors exceed a threshold;
- hiding all Kiro models from `/v1/models` when the adapter is globally disabled.

No payment may activate a Kiro package while the global Kiro adapter is disabled.
Existing keys remain visible but API requests return a sanitized `503`.

### Compatibility versioning

Every successful request records:

- adapter version;
- upstream protocol fixture version;
- selected persona;
- public and upstream model IDs;
- multiplier version;
- provider account ID, never credential data.

Any deliberate change to headers, fingerprint, auth, payload, or event parsing requires
rerunning the compatibility suite before deployment.

---

## 4. System architecture

### Monorepo

```text
bosanda/
├── apps/
│   ├── web/                    # Next.js: storefront + user dashboard
│   ├── admin/                  # Next.js: admin.bosanda.dev
│   ├── gateway/                # Fastify: public AI API
│   └── worker/                 # payment reconciliation and maintenance jobs
├── packages/
│   ├── config/                 # typed environment configuration
│   ├── database/               # PostgreSQL schema, migrations, repositories
│   ├── auth/                   # website sessions, passwords, roles
│   ├── api-keys/               # customer key hashing/encryption
│   ├── protocol/               # canonical requests and events
│   ├── openai/                 # OpenAI decoder/encoder
│   ├── anthropic/              # Anthropic decoder/encoder
│   ├── provider-core/          # provider interface, scheduler, health
│   ├── provider-kiro/          # Direct HTTP adapter
│   ├── metering/               # token counting, multipliers, quota ledger
│   ├── payments/               # Pakasir interface and implementation
│   ├── observability/          # logs, metrics, tracing, redaction
│   └── shared/                 # common validation and utilities
├── docs/
│   ├── direct-adapter-gate.md
│   ├── operations.md
│   ├── security.md
│   └── incident-response.md
├── spikes/
│   └── kiro-direct/            # isolated compatibility experiments
└── PLAN.md
```

### Services

- **Web:** registration, login, package selection, payment status, API keys, quota and
  usage.
- **Admin:** packages, stock, orders, users, provider accounts, model publication,
  health, reconciliation, audit logs, and kill switches.
- **Gateway:** latency-sensitive API authentication, quota enforcement, routing,
  protocol translation, streaming, and usage settlement.
- **Worker:** Pakasir reconciliation, expired-key processing, provider health probes,
  usage aggregation, and cleanup.
- **PostgreSQL:** source of truth for users, keys, orders, quota, provider accounts,
  models, health, and audit data.

Website traffic must not share the same Node process as long-running AI streams.

---

## 5. Canonical protocol

OpenAI and Anthropic requests are decoded into one provider-neutral shape. Provider
adapters emit canonical events, which are encoded back into the client's protocol.

```ts
type CanonicalRequest = {
  requestId: string;
  surface: "openai" | "anthropic";
  model: string;
  system: string | null;
  messages: CanonicalMessage[];
  tools: CanonicalTool[];
  toolChoice: CanonicalToolChoice | null;
  stream: boolean;
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  stopSequences: string[];
  includeUsage: boolean;
};

type CanonicalContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

type CanonicalMessage = {
  role: "user" | "assistant";
  content: CanonicalContent[];
};

type CanonicalEvent =
  | { type: "message_start"; id: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_input_delta"; index: number; partialJson: string }
  | { type: "tool_stop"; index: number }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      estimated: boolean;
    }
  | {
      type: "finish";
      reason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
    };
```

No client-specific response serialization is allowed inside `provider-kiro`.

---

## 6. Kiro Direct Adapter

### Adapter responsibilities

`provider-kiro` owns:

1. Provider credential decryption.
2. Access-token caching and refresh.
3. Profile discovery and caching.
4. Public model to upstream model mapping.
5. OpenAI/Anthropic canonical history to Kiro `conversationState` conversion.
6. Tool definition, tool call, and tool result conversion.
7. Upstream HTTP request construction.
8. AWS EventStream decoding and validation.
9. Upstream event to canonical event conversion.
10. Usage extraction.
11. Sanitized provider error classification.

### Provider interface

```ts
interface ProviderAdapter {
  validateAccount(accountId: string): Promise<AccountHealth>;
  listModels(): Promise<ProviderModel[]>;

  stream(
    request: CanonicalRequest,
    accountId: string,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalEvent>;
}
```

### Authentication data

Provider secrets may include:

- refresh token;
- short-lived access token and expiry;
- auth method;
- region;
- profile ARN;
- OIDC client ID and client secret when required;
- persona and compatibility metadata.

All secrets are encrypted with authenticated encryption. Access tokens may be cached
in Redis later, but PostgreSQL is the version 1 source of truth. Refresh-token rotation
must use a database transaction and optimistic version check.

### Request transformation invariants

- Generate a new upstream conversation ID for each stateless API request unless a
  protocol-specific continuation requires the supplied history.
- Never reuse hidden conversation context between customer requests.
- Reconstruct the full visible history from the request.
- Merge or reject invalid consecutive roles deterministically.
- Preserve tool IDs and tool result relationships.
- Never inject filesystem, shell, MCP, or host-environment tools.
- Never include Bosanda secrets, paths, environment variables, or provider metadata in
  prompts.

### EventStream decoder requirements

- Incremental binary parser.
- Prelude CRC and message CRC validation.
- Hard maximum frame size.
- Hard maximum buffered incomplete-frame size.
- Schema validation per event type.
- Unknown events recorded by type/count only and ignored unless required for safe turn
  completion.
- Exception events map to classified provider errors.
- No raw upstream payload in production logs.

---

## 7. Account pool, routing, retry, and cooldown

### Provider selection

For each request, eligible accounts are:

- enabled;
- credential-valid;
- not manually disabled;
- not in cooldown;
- compatible with the requested model and region;
- not blocked by the global or model kill switch.

Sort eligible accounts by:

1. active request count ascending;
2. recent error score ascending;
3. last selected timestamp ascending;
4. stable account ID tie-breaker.

### Concurrency decisions

- Per customer API key: maximum **5 active requests**.
- Per customer API key: maximum **100 requests per minute**.
- Per Kiro provider account: **no configured hard concurrency limit**, as explicitly
  selected for version 1.

Even without a hard provider limit, Bosanda must track active requests so least-loaded
routing works. The absence of a provider cap is a known operational risk and requires
load testing, upstream-error monitoring, timeout protection, and circuit breaking.

### Retry policy

For one downstream request:

1. Build the list of currently healthy provider accounts.
2. Try each provider at most once, in least-loaded order.
3. Retry only while **no response event/byte has been sent to the client**.
4. A failed provider enters a 30-second cooldown.
5. Do not revisit an account within the same request.
6. Stop when one attempt begins producing output, every eligible account has been
   tried, the client aborts, or the request hard timeout expires.
7. After output begins, return/stream a protocol-appropriate error and never fail over
   to another account.

Retry before output still may consume upstream credit if the upstream accepted the
prompt but failed before returning data. Because client tools execute only after a tool
call is emitted, hidden retries must not create client-side filesystem/shell side
effects, but duplicate upstream credit consumption remains possible and must be
measured.

### Circuit breaker

Per account and per model:

- consecutive compatibility/auth failures open the circuit;
- rate-limit failures honor upstream retry metadata when available;
- default cooldown is 30 seconds;
- repeated failures escalate cooldown exponentially to a configured maximum;
- auth/revocation errors disable the account until admin action;
- half-open probes admit only a small number of test requests.

---

## 8. Public API contract

### OpenAI-compatible surface

| Endpoint               | Method | Version 1                         |
| ---------------------- | -----: | --------------------------------- |
| `/v1/models`           |    GET | Published, package-allowed models |
| `/v1/models/{id}`      |    GET | Single model metadata             |
| `/v1/chat/completions` |   POST | Stream and non-stream, tools      |

Authentication:

```http
Authorization: Bearer <bosanda-api-key>
```

Streaming uses OpenAI SSE and ends with:

```text
data: [DONE]
```

Tool events are emitted as incremental `tool_calls` function arguments. A stable
completion ID is used throughout one response.

### Anthropic-compatible surface

| Endpoint                    | Method | Version 1                                      |
| --------------------------- | -----: | ---------------------------------------------- |
| `/v1/messages`              |   POST | Stream and non-stream, Claude Code tools       |
| `/v1/messages/count_tokens` |   POST | Local count/estimate; never invokes generation |

Authentication accepts:

```http
x-api-key: <bosanda-api-key>
```

Bearer authentication may also be accepted for client compatibility.
`anthropic-version` is required and recorded.

Anthropic stream order:

```text
message_start
content_block_start
content_block_delta / input_json_delta
content_block_stop
message_delta
message_stop
```

No `[DONE]` marker is emitted on the Anthropic surface.

### Error mapping

| HTTP | Meaning                                                 |
| ---: | ------------------------------------------------------- |
|  400 | Invalid request or unsupported capability               |
|  401 | Missing/invalid/revoked Bosanda key                     |
|  403 | Model outside package scope                             |
|  404 | Endpoint/model not found                                |
|  409 | Key/order state conflict                                |
|  429 | RPM, concurrency, or queue limit reached                |
|  500 | Internal Bosanda error                                  |
|  502 | Kiro returned an invalid/incompatible upstream response |
|  503 | No healthy provider or Kiro adapter disabled            |
|  504 | Upstream idle/hard timeout                              |

Before streaming starts, return the correct HTTP error envelope. After headers/events
start, emit the closest protocol-specific stream error when possible and close the
connection.

---

## 9. Models and capabilities

### Model registry

Each model stores:

- public ID;
- upstream Kiro ID;
- label;
- context window;
- Kiro cost multiplier;
- multiplier version and effective timestamp;
- published flag;
- tool-use capability;
- reasoning capability;
- regions;
- adapter compatibility status.

Model updates are staged and require admin approval before publication. A multiplier
change never rewrites historical usage.

### Package access

Package definitions contain model scopes. Version 1 package presets default to all
published Kiro models that pass the tool-use compatibility gate. The schema supports
restricting specific models per package later.

### Claude Code launch condition

At least one published model must pass the complete Claude Code tool-use acceptance
suite. If no model passes, sales stay disabled.

---

## 10. Customer quota and metering

### Commercial unit

The storefront labels packages in tokens, but the internal billable unit is
**weighted token**:

```text
raw_tokens      = input_tokens + output_tokens
weighted_tokens = raw_tokens × kiro_model_multiplier
```

Examples:

```text
1M raw tokens on a 1.3× model = 1.3M weighted tokens
1M raw tokens on a 2.2× model = 2.2M weighted tokens
```

The UI must explain that package tokens are weighted by model cost and are an estimate
when Kiro does not return authoritative usage.

### Usage source priority

1. Upstream `metricsEvent` usage, if complete.
2. Protocol tokenizer/counting implementation for the selected model.
3. Explicitly versioned fallback estimator.

Every ledger row records whether usage is authoritative or estimated and the meter
version used.

### Quota behavior

- A request can start only when the key is active and has positive remaining quota.
- An active stream is allowed to finish even if it crosses the remaining quota.
- Bosanda does not cut text or a tool call in the middle.
- Actual weighted usage is settled atomically after completion or partial completion.
- Bounded negative overage is possible with up to five concurrent streams.
- Once remaining quota is zero or negative, subsequent requests are rejected.
- Partial/error turns are charged for usage actually reported or estimated.

All quota changes use an append-only ledger plus a transactionally maintained balance.
No application code may update a balance without a corresponding ledger entry.

### Kiro credit reconciliation

Kiro upstream consumes provider credit automatically. The admin dashboard shows:

- weighted usage attributed to each provider account;
- observed/reported provider credit balance when available;
- manually entered reconciliation snapshots when no API exists;
- unexplained differences;
- provider exhaustion or error history.

Bosanda does not claim its weighted-token ledger exactly equals Kiro billing.

---

## 11. Packages, pricing, stock, and key lifecycle

### Package sizes and price

Buyers can select any 10M increment from 10M to 100M:

| Weighted-token quota |    Price |
| -------------------: | -------: |
|                  10M |  Rp9.500 |
|                  20M | Rp19.000 |
|                  30M | Rp28.500 |
|                  40M | Rp38.000 |
|                  50M | Rp47.500 |
|                  60M | Rp57.000 |
|                  70M | Rp66.500 |
|                  80M | Rp76.000 |
|                  90M | Rp85.500 |
|                 100M | Rp95.000 |

Pricing is linear at Rp9.500 per 10M. Package records remain admin-managed so prices
can be changed without deployment. Existing paid orders retain their purchase snapshot.

### Stock

- Stock is manually managed **per package size**.
- A successful new-key order consumes one stock unit for that size.
- Stock is reserved while payment is pending for a configured period.
- Expired/cancelled pending orders release the reservation.
- Webhook processing is idempotent and never decrements stock twice.
- Top-up stock policy is explicit in the package configuration and defaults to consuming
  one stock unit for the purchased size.

### Validity

- Each key is valid for exactly **24 hours from confirmed payment**.
- Maximum quota for one key is **100M weighted tokens**.
- A website account may own multiple active API keys.

### New key versus top-up

At checkout, an authenticated user may choose:

1. Create a new API key; or
2. Top up an existing **active and non-exhausted** key.

Top-up rules:

- remaining quota plus purchased quota must not exceed 100M;
- expiry resets to 24 hours from the successful top-up payment;
- if a key is expired or already exhausted, it cannot be topped up;
- the user must create a new key instead;
- quota and expiry changes are atomic with order activation.

---

## 12. User, session, and API-key security

### Website accounts

- Public registration.
- Username and password are required.
- No guest checkout.
- Email is not required in version 1.
- Passwords use Argon2id with reviewed parameters.
- Login uses secure, HTTP-only, same-site cookies.
- CSRF protection is required for mutations.
- Session rotation occurs after login and password reset.
- Login, registration, and recovery endpoints are rate-limited.

### Manual account recovery

Users contact admin through the published support channel. Admin may set a new password
from the admin dashboard. The system must:

- require admin authentication;
- revoke all existing sessions;
- record actor, target, timestamp, and reason in the audit log;
- never reveal the old password;
- warn that identity verification is an operational admin responsibility.

### Customer API keys

Because users may reveal a key with an eye toggle after login, each key stores both:

1. a keyed hash for fast request authentication; and
2. authenticated-encryption ciphertext for dashboard recovery.

Recommended construction:

```text
lookup_digest = HMAC-SHA-256(API_KEY_LOOKUP_SECRET, plaintext_key)
ciphertext    = XChaCha20-Poly1305(API_KEY_ENCRYPTION_KEY, plaintext_key)
```

Rules:

- never store plaintext;
- never log a key, authorization header, ciphertext, or full prefix;
- display masked by default;
- eye toggle decrypts only after a valid website session;
- key reveal is audited;
- keys can be revoked and rotated;
- encryption keys are versioned to allow rotation;
- encryption secrets live outside PostgreSQL.

The selected UX does not require password re-entry for the eye toggle. This is a known
security tradeoff.

---

## 13. Pakasir payment flow

### Checkout

1. Authenticated user selects 10M–100M.
2. User chooses new key or an eligible active key to top up.
3. Bosanda creates an order and reserves package stock.
4. Bosanda creates the Pakasir transaction.
5. User completes payment.
6. Pakasir webhook reaches Bosanda.
7. Bosanda authenticates and validates the webhook.
8. In one idempotent transaction, Bosanda marks payment paid, consumes stock, creates
   or tops up the key, appends quota ledger entries, and records audit data.
9. The dashboard displays the activated key and expiry.

### Webhook requirements

- Validate the authentication/signature mechanism documented by Pakasir.
- Never trust price, package, username, or quota from browser-supplied webhook data.
- Match the provider transaction to the server-created order.
- Validate amount and currency against the immutable order snapshot.
- Use a unique provider-event or transaction key for idempotency.
- Accept duplicate and out-of-order callbacks safely.
- Return success only after durable processing.

### Reconciliation

A worker polls/checks Pakasir status for pending or ambiguous orders. Reconciliation can
activate a genuinely paid order when a webhook is delayed, but uses the same idempotent
activation transaction.

Order states:

```text
draft → pending_payment → paid → activated
                       ↘ expired
                       ↘ cancelled
                       ↘ review_required
```

Refund handling initially requires admin review; revocation or quota adjustment is
recorded as a ledger entry, never by deleting history.

---

## 14. PostgreSQL data model

Main tables:

```text
users
  id, username, password_hash, role, status, created_at, updated_at

sessions
  id, user_id, token_hash, expires_at, revoked_at, created_at

packages
  id, name, weighted_token_quota, price_idr, duration_seconds,
  max_key_quota, allowed_models, active, created_at, updated_at

package_stock
  package_id, available, reserved, version, updated_at

orders
  id, user_id, package_id, package_snapshot, type, target_api_key_id,
  amount_idr, status, stock_reservation_expires_at,
  provider, provider_transaction_id, paid_at, activated_at,
  created_at, updated_at

payment_events
  id, provider, provider_event_key, payload_digest, status,
  received_at, processed_at, error_code

api_keys
  id, user_id, label, prefix, lookup_digest, encrypted_key,
  encryption_key_version, status, quota_limit, quota_remaining,
  expires_at, created_at, revoked_at, last_used_at

quota_ledger
  id, api_key_id, order_id, request_id, kind,
  raw_input_tokens, raw_output_tokens, multiplier,
  weighted_tokens_delta, balance_after, estimated,
  meter_version, created_at

provider_accounts
  id, provider_type, label, status, region, persona,
  encrypted_credentials, encryption_key_version,
  profile_arn, credential_version, cooldown_until,
  last_validated_at, created_at, updated_at

provider_health_events
  id, provider_account_id, model_id, event_type, error_class,
  cooldown_until, adapter_version, created_at

models
  public_id, provider_type, upstream_id, label, context_window,
  multiplier, multiplier_version, capabilities, regions,
  published, compatibility_status, updated_at

usage_events
  id, request_id, api_key_id, provider_account_id, model_public_id,
  surface, status, input_tokens, output_tokens, cached_tokens,
  weighted_tokens, estimated, meter_version, adapter_version,
  retries, ttfb_ms, duration_ms, created_at

audit_events
  id, actor_type, actor_id, action, target_type, target_id,
  metadata, created_at

feature_flags
  key, value, updated_by, updated_at
```

Database requirements:

- PostgreSQL migrations are ordered and immutable after release.
- Foreign keys and check constraints enforce lifecycle invariants.
- Transactions use row locking or compare-and-swap for stock, quota, token refresh,
  and order activation.
- All timestamps are UTC.
- Usage and audit retention policies are documented.
- Prompt, response text, tool arguments, tool results, and source code are not stored by
  default.

---

## 15. Admin dashboard

`admin.bosanda.dev` provides:

### Commerce

- Create/edit/disable package sizes and prices.
- Set stock independently for 10M through 100M.
- View and reconcile Pakasir orders.
- Review refunds and disputed orders.

### Users and keys

- Search users and orders.
- Disable accounts.
- Set a new password after support verification.
- Revoke keys.
- Inspect quota ledger without exposing prompts.

### Kiro provider pool

- Add/import encrypted account credentials.
- Validate and refresh an account.
- Enable/disable an account.
- View active request count, recent failures, cooldown, region, and profile.
- Record/reconcile observed Kiro credit.
- Rotate credentials.
- Run a compatibility probe.

### Models and adapter

- Publish/unpublish models.
- Update and version multipliers.
- View compatibility-suite results.
- Activate global, region, model, account, and tool-use kill switches.

### Admin bootstrap

The first admin is created with a one-time CLI command on the VPS. There is no web
route for creating the initial admin. The bootstrap command refuses to run if an admin
already exists unless an explicit, audited recovery procedure is used.

---

## 16. Security requirements

### Secrets

- Provider refresh/access tokens and OIDC secrets use authenticated encryption.
- Customer API keys use both keyed hashes and authenticated encryption.
- Passwords use Argon2id.
- Application encryption, HMAC, session, and payment secrets are separate.
- Secrets are not inherited by arbitrary subprocesses; version 1 should not need a Kiro
  subprocess.
- Production secrets are supplied by the VPS secret manager or root-readable
  environment files, never committed.

### Network

- Gateway egress is allowlisted to required Kiro and Pakasir hosts where practical.
- No implicit fallback from a configured proxy to direct egress.
- TLS certificate validation is mandatory.
- Admin dashboard may be protected by an additional IP allowlist or VPN.
- Internal PostgreSQL is not publicly reachable.

### Request and parser safety

- JSON body size limits.
- Tool count, name, description, and schema size limits.
- Message, history, and output size limits.
- EventStream frame/buffer limits and CRC validation.
- Strict upstream schema validation.
- Header allowlists and redaction.
- Timeouts for headers, idle chunks, and total turns.
- Abort propagation on client disconnect.
- Bounded per-key and global queues.

### Privacy

- Do not retain prompt/response bodies by default.
- Logs use request IDs and metadata only.
- Tool inputs/results are never logged.
- User-facing policy discloses that requests are routed to Kiro upstream.

---

## 17. Observability

Metrics:

- requests by surface/model/status;
- active requests per API key and provider account;
- RPM rejections;
- queue depth and wait time;
- upstream attempts and retries;
- TTFB and duration;
- bytes/events streamed;
- tool-use turns;
- input/output/weighted tokens;
- estimated versus authoritative usage;
- refresh success/failure;
- provider cooldown and circuit state;
- EventStream parse/CRC/schema failures;
- adapter compatibility errors;
- Pakasir webhook and reconciliation outcomes.

Structured logs must redact:

- Bosanda API keys;
- Kiro credentials and tokens;
- cookies and authorization headers;
- Pakasir secrets;
- tool input/result content;
- prompt/response text;
- local paths and raw upstream payloads.

Alerts:

- no healthy Kiro providers;
- compatibility error spike;
- auth refresh failure spike;
- Kiro credit exhaustion;
- quota-ledger mismatch;
- payment activation failure;
- repeated webhook authentication failures;
- PostgreSQL health or storage pressure.

---

## 18. Deployment

Initial production topology:

```text
Internet
  → Nginx / TLS
      ├── bosanda.dev        → Next.js web
      ├── admin.bosanda.dev  → Next.js admin
      └── api.bosanda.dev    → Fastify gateway
                                  │
                                  ├── worker
                                  └── PostgreSQL
```

Nginx gateway location must preserve streaming:

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_cache off;
gzip off;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
```

The gateway also sends `X-Accel-Buffering: no` for SSE.

Systemd requirements:

- dedicated non-root users;
- separate service units for web, admin, gateway, and worker;
- restart policies with backoff;
- read-only filesystem where practical;
- explicit writable directories;
- resource and file-descriptor limits;
- hardened environment and no ambient AWS/Kiro credentials.

PostgreSQL backups are encrypted and restoration is tested. Provider/customer secret
ciphertext may be backed up, but encryption keys are stored separately.

---

## 19. Test plan

### Direct adapter

- Credential import, decrypt, refresh, rotation, revocation, and refresh races.
- Profile discovery and cache invalidation.
- Golden request fixtures for each model/persona.
- Progressive AWS EventStream parsing across every chunk boundary.
- CRC mismatch, oversized frame, truncated stream, unknown event, and malformed JSON.
- Text, reasoning, usage, stop, refusal, and upstream exception events.
- Abort, idle timeout, hard timeout, and slow consumer backpressure.
- Upstream protocol compatibility probe.

### Claude Code

- Tool definitions forwarded correctly.
- Incremental tool input JSON.
- Multiple tool calls.
- Tool result and tool error round-trips.
- Text before and after tools.
- Claude Code performs Read/Edit/Bash locally in a disposable test repository.
- Bosanda VPS never executes those tools.
- Real Claude Code session through `api.bosanda.dev`.

### Pool and retry

- Least-loaded ordering.
- No disabled/cooldown account selected.
- Every healthy account attempted at most once.
- 30-second default cooldown.
- Retry only before first output.
- No retry after first SSE event.
- Client abort stops retries and upstream fetch.
- Concurrent refresh single-flight.
- Circuit open/half-open/closed behavior.
- Load test with no provider concurrency cap.

### Protocol compatibility

- Official OpenAI SDK stream/non-stream.
- Official Anthropic SDK stream/non-stream.
- Claude Code.
- Correct OpenAI role and tool-call chunks.
- Correct Anthropic content-block order and no `[DONE]`.
- `/v1/messages/count_tokens` never calls Kiro generation.
- Errors before and after stream start.

### Commerce and quota

- Registration/login/session/logout.
- Password reset by admin revokes old sessions.
- Key encrypt/decrypt/hash/reveal/rotate/revoke.
- 100 RPM and five-active-request enforcement.
- Weighted-token calculation by multiplier version.
- Stream allowed to finish across zero balance; next request rejected.
- Concurrent settlement cannot lose ledger entries.
- New key, active-key top-up, 100M cap, expired/exhausted top-up rejection.
- 24-hour expiry begins at confirmed payment/top-up.
- Stock reserve, consume, release, and duplicate webhook handling.
- Pakasir webhook authentication and amount validation.
- Reconciliation activates an order exactly once.

### Security

- No secrets/prompts/tool results in logs.
- CSRF and session fixation tests.
- Argon2id password verification.
- Authorization tests for user/admin boundaries.
- SQL injection and malformed JSON tests.
- Encrypted provider/customer secret database inspection.
- Admin bootstrap cannot create a second initial admin silently.

---

## 20. Milestones

### M0 — Kiro Direct feasibility gate

Deliverables:

- `spikes/kiro-direct/` test harness;
- sanitized request/response/event fixtures;
- credential and refresh-flow report;
- model and multiplier snapshot;
- EventStream decoder prototype;
- Claude Code tool-use proof;
- `docs/direct-adapter-gate.md` with PASS/FAIL evidence.

Exit condition: direct streaming, usage, cancellation, and complete Claude Code tool loop
all pass. Otherwise the project is no-go.

### M1 — Monorepo and data foundation

Deliverables:

- TypeScript monorepo;
- Next.js web/admin skeletons;
- Fastify gateway;
- worker service;
- PostgreSQL migrations;
- typed config and secret handling;
- user/session/admin bootstrap;
- package, order, stock, key, ledger, provider, model, and audit repositories.

### M2 — Kiro provider and gateway

Deliverables:

- encrypted provider-account management;
- token refresh single-flight;
- profile discovery;
- direct HTTP client;
- validated EventStream decoder;
- canonical protocol;
- OpenAI and Anthropic encoders/decoders;
- tool-use support;
- pool scheduler, retry, cooldown, circuit breaker, and kill switches;
- usage and weighted-quota settlement.

### M3 — Storefront, dashboard, and Pakasir

Deliverables:

- registration/login;
- package selection 10M–100M;
- new-key/top-up checkout;
- Pakasir webhook and reconciliation;
- key reveal toggle;
- quota/expiry/usage dashboard;
- admin package/stock/order/user/provider/model controls.

### M4 — Production hardening

Deliverables:

- Nginx/TLS/systemd;
- PostgreSQL backup/restore;
- metrics, alerts, and redacted logs;
- load and failure testing;
- operations and incident-response docs;
- official SDK and Claude Code acceptance through production domains.

### M5 — Controlled launch

1. Keep public registration/payment disabled.
2. Run internal test keys.
3. Enable a limited package stock.
4. Monitor provider health, upstream credit, retry, and quota mismatch.
5. Expand stock only after stable operation.

---

## 21. Go/no-go criteria

Bosanda may enable paid Kiro packages only when:

1. Direct credential refresh works reliably and securely.
2. Upstream protocol fixtures pass against the current service.
3. AWS EventStream parsing is progressive, bounded, and CRC-validated.
4. Complete Claude Code client-side tool use passes.
5. No conversation context leaks between requests or users.
6. Customer and provider secrets are encrypted and absent from logs.
7. Retry never occurs after first client output.
8. Quota, payment, stock, and activation transactions are idempotent.
9. At least one model and enough provider accounts are healthy.
10. Global/model/account kill switches have been tested.
11. OpenAI SDK, Anthropic SDK, and Claude Code pass through production Nginx.
12. The project owner has reviewed and accepted/resolved the unsupported-protocol and
    public-resale risks.

Hard no-go conditions:

- Kiro tool use cannot be mapped correctly to Claude Code.
- Credential isolation or refresh rotation is unreliable.
- Upstream protocol requires leaking host/customer secrets.
- EventStream cannot be parsed safely and progressively.
- The direct adapter cannot be disabled quickly when compatibility breaks.

---

## 22. Final architecture decisions

| Area                  | Final decision                                                  |
| --------------------- | --------------------------------------------------------------- |
| Provider v1           | Pool of service-owned Kiro accounts                             |
| Upstream transport    | Kiro Direct Adapter over HTTP                                   |
| `kiro-cli`            | Not a production runtime dependency                             |
| Upstream status       | Observed/internal protocol, not documented public inference API |
| Claude Code           | Mandatory; no-go if complete tool-use loop fails                |
| Tool execution        | Client-side only                                                |
| Pool selection        | Least-loaded healthy account                                    |
| Provider concurrency  | No hard per-account cap; tracked and load-tested                |
| Retry                 | Every healthy provider once, only before first output           |
| Cooldown              | Default 30 seconds, with circuit-breaker escalation             |
| Customer rate limit   | 100 RPM per API key                                             |
| Customer concurrency  | 5 active requests per API key                                   |
| Meter                 | `(input + output) × Kiro model multiplier`                      |
| Active stream at zero | Finish stream; reject subsequent requests                       |
| Package size          | 10M–100M in 10M increments                                      |
| Price                 | Rp9.500 per 10M; 100M = Rp95.000                                |
| Validity              | 24 hours from confirmed payment/top-up                          |
| Key cap               | Maximum 100M per key; multiple keys per user allowed            |
| Top-up                | Active, non-exhausted keys only; reset expiry to 24 hours       |
| Registration          | Public username/password, no guest checkout                     |
| Recovery              | User chats admin; admin sets new password and revokes sessions  |
| Key reveal            | Encrypted at rest, eye toggle after login, no password re-entry |
| Payment               | Pakasir webhook plus reconciliation                             |
| Stock                 | Manual per package size                                         |
| Database              | PostgreSQL                                                      |
| Stack                 | Next.js web/admin + Fastify gateway + worker                    |
| Deployment            | Ubuntu VPS, Nginx, systemd                                      |
| Admin bootstrap       | One-time CLI command                                            |
| Domains               | `bosanda.dev`, `admin.bosanda.dev`, `api.bosanda.dev`           |
| Future providers      | Supported through provider adapter abstraction                  |

---

## 23. References

- Kiro model documentation: <https://kiro.dev/docs/models/>
- Kiro CLI authentication documentation: <https://kiro.dev/docs/cli/authentication/>
- Kiro ACP documentation: <https://kiro.dev/docs/cli/acp/>
- Behavioral architecture reference: <https://github.com/aikazu/kelola-router>
- Pakasir: implementation must follow the current official Pakasir API/webhook
  documentation available during M3.

The Kiro CLI and ACP references document supported Kiro automation concepts, but do
not make the Direct Adapter an official public API integration.
