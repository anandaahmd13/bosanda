-- 0001_initial_schema
--
-- The full v1 data model (PLAN.md §14). Immutable after release: to change
-- anything here, add a new migration.
--
-- Conventions:
--   * Primary keys are 26-char ULIDs (see @bosanda/shared ids.ts), stored as
--     CHAR(26) so the index stays fixed-width and append-mostly.
--   * All timestamps are timestamptz and written in UTC.
--   * Money is integer rupiah. Never floating point.
--   * Lifecycle invariants live in CHECK constraints and foreign keys, so a
--     buggy service cannot persist a state the domain forbids.

CREATE TABLE users (
  id            CHAR(26) PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('customer', 'admin')),
  status        TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL
);

-- Usernames are case-insensitively unique: "Budi" and "budi" must not be two
-- accounts, or account recovery becomes ambiguous.
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));

CREATE TABLE sessions (
  id           CHAR(26) PRIMARY KEY,
  user_id      CHAR(26) NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT sessions_activity_within_lifetime CHECK (
    last_used_at >= created_at AND last_used_at <= expires_at
  )
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
-- Sweeping expired sessions is a frequent background job; index the scan key.
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE packages (
  id                    CHAR(26) PRIMARY KEY,
  name                  TEXT NOT NULL,
  weighted_token_quota  BIGINT NOT NULL CHECK (weighted_token_quota > 0),
  price_idr             BIGINT NOT NULL CHECK (price_idr >= 0),
  duration_seconds      INTEGER NOT NULL CHECK (duration_seconds > 0),
  max_key_quota         BIGINT NOT NULL CHECK (max_key_quota > 0),
  allowed_models        JSONB NOT NULL DEFAULT '[]'::jsonb,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL,
  CONSTRAINT packages_quota_within_key_cap CHECK (weighted_token_quota <= max_key_quota),
  CONSTRAINT packages_allowed_models_is_array CHECK (jsonb_typeof(allowed_models) = 'array')
);

CREATE TABLE package_stock (
  package_id CHAR(26) PRIMARY KEY REFERENCES packages (id) ON DELETE CASCADE,
  available  INTEGER NOT NULL CHECK (available >= 0),
  reserved   INTEGER NOT NULL CHECK (reserved >= 0),
  -- Optimistic-concurrency counter: stock moves via compare-and-swap on this
  -- column (PLAN.md §14), so two buyers cannot both claim the last unit.
  version    BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE orders (
  id                            CHAR(26) PRIMARY KEY,
  user_id                       CHAR(26) NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  package_id                    CHAR(26) NOT NULL REFERENCES packages (id) ON DELETE RESTRICT,
  -- Price and quota as sold, frozen at checkout. Later edits to `packages`
  -- must never retroactively change what a customer already paid for.
  package_snapshot              JSONB NOT NULL,
  type                          TEXT NOT NULL CHECK (type IN ('new_key', 'top_up')),
  target_api_key_id             CHAR(26),
  amount_idr                    BIGINT NOT NULL CHECK (amount_idr >= 0),
  -- PLAN.md §13 "Order states". `review_required` is where refunds land:
  -- money is never unwound by deleting history, only by admin review plus a
  -- compensating ledger entry.
  status                        TEXT NOT NULL CHECK (
                                  status IN ('draft', 'pending_payment', 'paid', 'activated',
                                             'expired', 'cancelled', 'review_required')
                                ),
  stock_reservation_expires_at  TIMESTAMPTZ,
  provider                      TEXT,
  provider_transaction_id       TEXT,
  paid_at                       TIMESTAMPTZ,
  activated_at                  TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL,
  updated_at                    TIMESTAMPTZ NOT NULL,
  -- A top-up must name the key it credits; a new-key order must not.
  CONSTRAINT orders_target_matches_type CHECK (
    (type = 'top_up' AND target_api_key_id IS NOT NULL)
    OR (type = 'new_key' AND target_api_key_id IS NULL)
  ),
  CONSTRAINT orders_paid_before_activated CHECK (
    activated_at IS NULL OR (paid_at IS NOT NULL AND activated_at >= paid_at)
  ),
  CONSTRAINT orders_activated_implies_status CHECK (
    activated_at IS NULL OR status IN ('activated', 'expired')
  )
);

CREATE INDEX orders_user_id_created_at_idx ON orders (user_id, created_at DESC);
-- The reconciliation job scans stale pending orders (PLAN.md §13).
CREATE INDEX orders_pending_reservation_idx ON orders (stock_reservation_expires_at)
  WHERE status = 'pending_payment';
-- Provider transaction IDs are unique per provider when present.
CREATE UNIQUE INDEX orders_provider_transaction_key ON orders (provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

CREATE TABLE payment_events (
  id                 CHAR(26) PRIMARY KEY,
  provider           TEXT NOT NULL,
  -- Idempotency key from the provider. The UNIQUE constraint is what makes
  -- webhook replay safe (PLAN.md §13): a duplicate delivery collides here
  -- instead of crediting quota twice.
  provider_event_key TEXT NOT NULL,
  payload_digest     TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (
                       status IN ('received', 'processed', 'ignored', 'failed')
                     ),
  received_at        TIMESTAMPTZ NOT NULL,
  processed_at       TIMESTAMPTZ,
  error_code         TEXT,
  CONSTRAINT payment_events_provider_event_key UNIQUE (provider, provider_event_key)
);

CREATE INDEX payment_events_status_idx ON payment_events (status, received_at);

CREATE TABLE api_keys (
  id                     CHAR(26) PRIMARY KEY,
  user_id                CHAR(26) NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  label                  TEXT,
  -- Displayable head of the key, for masked rendering without decryption.
  prefix                 TEXT NOT NULL,
  -- Keyed HMAC of the full key: the only value authentication looks up, so a
  -- database leak does not yield usable keys.
  lookup_digest          TEXT NOT NULL UNIQUE,
  encrypted_key          TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL CHECK (encryption_key_version >= 1),
  status                 TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  quota_limit            BIGINT NOT NULL CHECK (quota_limit >= 0),
  quota_remaining        BIGINT NOT NULL CHECK (quota_remaining >= 0),
  expires_at             TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL,
  revoked_at             TIMESTAMPTZ,
  last_used_at           TIMESTAMPTZ,
  CONSTRAINT api_keys_remaining_within_limit CHECK (quota_remaining <= quota_limit),
  CONSTRAINT api_keys_revoked_status_agrees CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  )
);

CREATE INDEX api_keys_user_id_idx ON api_keys (user_id, created_at DESC);
-- Expiry sweep target (PLAN.md §11: 24h validity).
CREATE INDEX api_keys_active_expiry_idx ON api_keys (expires_at) WHERE status = 'active';

-- Append-only quota movements. The audit trail behind quota_remaining: every
-- debit and credit is reconstructible, which is what makes billing disputes
-- answerable (PLAN.md §10).
CREATE TABLE quota_ledger (
  id                    CHAR(26) PRIMARY KEY,
  api_key_id            CHAR(26) NOT NULL REFERENCES api_keys (id) ON DELETE RESTRICT,
  order_id              CHAR(26) REFERENCES orders (id) ON DELETE RESTRICT,
  request_id            TEXT,
  kind                  TEXT NOT NULL CHECK (
                          kind IN ('grant', 'top_up', 'debit', 'refund', 'adjustment', 'expiry')
                        ),
  raw_input_tokens      BIGINT NOT NULL DEFAULT 0 CHECK (raw_input_tokens >= 0),
  raw_output_tokens     BIGINT NOT NULL DEFAULT 0 CHECK (raw_output_tokens >= 0),
  multiplier            NUMERIC(10, 4),
  -- Signed: negative debits usage, positive credits it.
  weighted_tokens_delta BIGINT NOT NULL,
  balance_after         BIGINT NOT NULL CHECK (balance_after >= 0),
  estimated             BOOLEAN NOT NULL DEFAULT FALSE,
  meter_version         TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL,
  CONSTRAINT quota_ledger_debit_is_negative CHECK (
    (kind = 'debit' AND weighted_tokens_delta <= 0)
    OR (kind IN ('grant', 'top_up') AND weighted_tokens_delta > 0)
    OR kind IN ('refund', 'adjustment', 'expiry')
  ),
  CONSTRAINT quota_ledger_grant_has_order CHECK (
    kind NOT IN ('grant', 'top_up') OR order_id IS NOT NULL
  ),
  CONSTRAINT quota_ledger_multiplier_positive CHECK (multiplier IS NULL OR multiplier > 0)
);

CREATE INDEX quota_ledger_api_key_id_idx ON quota_ledger (api_key_id, created_at DESC);
-- One debit per request per key: retry of a settle must not double-charge.
CREATE UNIQUE INDEX quota_ledger_request_debit_key ON quota_ledger (api_key_id, request_id)
  WHERE kind = 'debit' AND request_id IS NOT NULL;

CREATE TABLE provider_accounts (
  id                     CHAR(26) PRIMARY KEY,
  provider_type          TEXT NOT NULL,
  label                  TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (
                           status IN ('active', 'cooldown', 'disabled', 'invalid')
                         ),
  region                 TEXT,
  persona                TEXT,
  encrypted_credentials  TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL CHECK (encryption_key_version >= 1),
  profile_arn            TEXT,
  -- Bumped on every refresh; the single-flight refresh compares against this
  -- to detect that another worker already rotated the credential (PLAN.md §6).
  credential_version     BIGINT NOT NULL DEFAULT 0,
  cooldown_until         TIMESTAMPTZ,
  last_validated_at      TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL
);

-- Provider selection scans for eligible accounts on every request (PLAN.md §7).
CREATE INDEX provider_accounts_selection_idx ON provider_accounts (provider_type, status, cooldown_until);

CREATE TABLE provider_health_events (
  id                  CHAR(26) PRIMARY KEY,
  provider_account_id CHAR(26) NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
  model_id            TEXT,
  event_type          TEXT NOT NULL,
  error_class         TEXT,
  cooldown_until      TIMESTAMPTZ,
  adapter_version     TEXT,
  created_at          TIMESTAMPTZ NOT NULL
);

CREATE INDEX provider_health_events_account_idx
  ON provider_health_events (provider_account_id, created_at DESC);

CREATE TABLE models (
  public_id            TEXT PRIMARY KEY,
  provider_type        TEXT NOT NULL,
  upstream_id          TEXT NOT NULL,
  label                TEXT NOT NULL,
  context_window       INTEGER NOT NULL CHECK (context_window > 0),
  multiplier           NUMERIC(10, 4) NOT NULL CHECK (multiplier > 0),
  -- Changing a multiplier starts a new version rather than mutating history,
  -- so already-metered rows stay explainable (PLAN.md §10).
  multiplier_version   TEXT NOT NULL,
  capabilities         JSONB NOT NULL DEFAULT '{}'::jsonb,
  regions              JSONB NOT NULL DEFAULT '[]'::jsonb,
  published            BOOLEAN NOT NULL DEFAULT FALSE,
  compatibility_status TEXT NOT NULL CHECK (
                         compatibility_status IN ('untested', 'passing', 'degraded', 'failing')
                       ),
  updated_at           TIMESTAMPTZ NOT NULL,
  CONSTRAINT models_regions_is_array CHECK (jsonb_typeof(regions) = 'array'),
  -- A model may only be published once its compatibility gate passes
  -- (PLAN.md §3): an untested model must never appear on /v1/models.
  CONSTRAINT models_published_requires_passing CHECK (
    published = FALSE OR compatibility_status IN ('passing', 'degraded')
  )
);

CREATE INDEX models_published_idx ON models (published, public_id);

-- One row per billable request. No prompt or response text (PLAN.md §16).
CREATE TABLE usage_events (
  id                  CHAR(26) PRIMARY KEY,
  request_id          TEXT NOT NULL UNIQUE,
  api_key_id          CHAR(26) NOT NULL REFERENCES api_keys (id) ON DELETE RESTRICT,
  provider_account_id CHAR(26) REFERENCES provider_accounts (id) ON DELETE SET NULL,
  model_public_id     TEXT NOT NULL,
  surface             TEXT NOT NULL CHECK (surface IN ('openai', 'anthropic')),
  status              TEXT NOT NULL CHECK (
                        status IN ('succeeded', 'failed', 'cancelled', 'partial')
                      ),
  input_tokens        BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_tokens       BIGINT NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  weighted_tokens     BIGINT NOT NULL DEFAULT 0 CHECK (weighted_tokens >= 0),
  -- TRUE when tokens came from our local counter rather than upstream usage.
  estimated           BOOLEAN NOT NULL DEFAULT FALSE,
  meter_version       TEXT NOT NULL,
  adapter_version     TEXT,
  retries             INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0),
  ttfb_ms             INTEGER CHECK (ttfb_ms >= 0),
  duration_ms         INTEGER CHECK (duration_ms >= 0),
  created_at          TIMESTAMPTZ NOT NULL
);

CREATE INDEX usage_events_api_key_created_idx ON usage_events (api_key_id, created_at DESC);
CREATE INDEX usage_events_created_at_idx ON usage_events (created_at);
CREATE INDEX usage_events_model_idx ON usage_events (model_public_id, created_at DESC);

CREATE TABLE audit_events (
  id          CHAR(26) PRIMARY KEY,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'admin', 'system')),
  actor_id    CHAR(26),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX audit_events_action_idx ON audit_events (action, created_at DESC);
CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id, created_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_type, actor_id, created_at DESC);

CREATE TABLE feature_flags (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by CHAR(26),
  updated_at TIMESTAMPTZ NOT NULL
);
