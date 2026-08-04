-- App Server-managed providers own credential storage outside PostgreSQL.
-- Keep the columns paired: Kiro rows carry both ciphertext and key version;
-- managed Codex rows carry neither.
ALTER TABLE provider_accounts
  ALTER COLUMN encrypted_credentials DROP NOT NULL,
  ALTER COLUMN encryption_key_version DROP NOT NULL;

ALTER TABLE provider_accounts
  ADD CONSTRAINT provider_accounts_credentials_pair CHECK (
    (encrypted_credentials IS NULL AND encryption_key_version IS NULL)
    OR (encrypted_credentials IS NOT NULL AND encryption_key_version IS NOT NULL)
  );
