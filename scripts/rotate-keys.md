# Encryption key rotation

Versioned envelope-key rotation for the four 32-byte application secrets
(PLAN.md §16 "Secrets", §12 "encryption keys are versioned to allow rotation").

The mechanism is already in the code: every row carries an
`encryption_key_version`, and `keyringFromEnv()` in
`packages/config/src/secrets.ts` decrypts by version while encrypting only with
`ENCRYPTION_KEY_VERSION`.

**Read this before rotating anything.** Getting the order wrong makes data
permanently unreadable. The rule that prevents that:

> Add the new key first. Re-encrypt second. Retire the old key **last**, and only
> after proving nothing references it.

## What the current code does and does not support

`keyringFromEnv()` as written holds **one generation per purpose** and throws
`ConfigError` for any version that is not the current one:

```
keyForVersion(purpose, version) {
  if (version !== currentVersion) throw new ConfigError([...])
}
```

So the versioned _schema_ is in place, but multi-generation key loading is
**NOT YET IMPLEMENTED**. Step 1 below is a code change, not a config change, and
it is a prerequisite for every rotation except `SESSION_SECRET`.

Owner of that change: whoever owns `packages/config`. It is outside the scope of
the deployment artifacts in this directory.

## Rotation difficulty by secret

| Secret                    | Rotatable today          | Blast radius                                                   |
| ------------------------- | ------------------------ | -------------------------------------------------------------- |
| `SESSION_SECRET`          | Yes, immediately         | Everyone is logged out. No data loss.                          |
| `PROVIDER_ENCRYPTION_KEY` | After step 1             | Re-encrypt `provider_accounts`. Small table.                   |
| `API_KEY_ENCRYPTION_KEY`  | After step 1             | Re-encrypt `api_keys.encrypted_key`. Reveal breaks until done. |
| `API_KEY_LOOKUP_SECRET`   | **Special — see below**  | Invalidates every live customer key.                           |
| `PAKASIR_WEBHOOK_SECRET`  | Coordinated with Pakasir | Webhooks rejected until both sides match.                      |

### SESSION_SECRET is the easy one

Sessions are disposable. There is nothing to re-encrypt.

```sh
# 1. Generate and swap the value in every env file that has it.
openssl rand -base64 32
# 2. Restart. Every existing cookie becomes invalid; users log in again.
systemctl restart bosanda-web bosanda-admin bosanda-gateway
```

This is also a legitimate **containment action** during a session-hijack
incident — see `docs/incident-response.md`.

### API_KEY_LOOKUP_SECRET is NOT a normal rotation

The lookup digest is `HMAC-SHA-256(API_KEY_LOOKUP_SECRET, plaintext_key)`, and
Bosanda never stores the plaintext key. Recomputing a digest under a new secret
therefore requires the plaintext — which is only recoverable by decrypting
`encrypted_key` with `API_KEY_ENCRYPTION_KEY`.

So it _is_ possible, but only as a joint operation: decrypt each key with the
API-key encryption key, recompute the digest under the new lookup secret, and
write both in one transaction. If `API_KEY_ENCRYPTION_KEY` has been lost, this
rotation is impossible and **every live key must be revoked and reissued**.

Because keys live only 24 hours (§11), the cheap option is usually better:
announce a maintenance window, revoke all keys, and let customers create new
ones. Weigh that against the customer impact before choosing the clever path.

## Procedure

### Step 0 — Decide, and write it down

Record in the audit log (§12) _why_ you are rotating: scheduled hygiene, a
suspected leak, or an operator departure. The reason determines urgency, and
urgency determines whether you accept a customer-visible window.

If this is a **suspected compromise**, stop and go to
`docs/incident-response.md` → "Credential compromise" first. Containment comes
before hygiene.

### Step 1 — Teach the keyring to hold two generations (code change)

Extend the env schema and `keyringFromEnv()` so a previous generation can be
supplied alongside the current one, e.g.:

```
PROVIDER_ENCRYPTION_KEY            # generation N   (encrypts new writes)
PROVIDER_ENCRYPTION_KEY_PREVIOUS   # generation N-1 (decrypt only)
ENCRYPTION_KEY_VERSION=2
```

`keyForVersion(purpose, version)` must return the previous generation's bytes
when `version === currentVersion - 1`, and keep throwing for anything older.
Keep the distinctness check — the new key must differ from all others, including
the one it replaces.

Deploy this **before** changing any value. At this point nothing has rotated;
the system simply became capable of it.

### Step 2 — Add the new key, keep the old one

Generate the new value, move the old value into the `_PREVIOUS` variable, and
bump the version:

```sh
openssl rand -base64 32   # the new generation N value
```

Edit `/etc/bosanda/*.env` (root-owned, 0640 — see `deploy/env/.env.example`),
then restart. New writes are sealed at version N; existing rows at N-1 still
decrypt.

Verify before continuing:

```sh
./scripts/healthcheck.sh
journalctl -u bosanda-gateway -n 100 --no-pager | grep -i configerror   # expect nothing
```

Confirm a _read_ of old data still works — reveal a key in the admin UI, and
confirm a provider account still validates. If either fails, the previous
generation is not wired correctly. Roll back the env change and fix step 1.

### Step 3 — Re-encrypt in versioned batches

Re-encrypt in bounded batches rather than one transaction over the whole table:
a single long transaction holds locks, and a failure halfway leaves you unsure
what committed. Batching means each chunk is independently durable and the job is
resumable.

```
-- Find remaining work. This is the query that drives the loop and, later,
-- the retirement decision.
SELECT encryption_key_version, count(*)
FROM   provider_accounts
GROUP  BY 1 ORDER BY 1;

SELECT encryption_key_version, count(*)
FROM   api_keys
GROUP  BY 1 ORDER BY 1;
```

For each batch, inside one transaction per batch:

1. `SELECT ... WHERE encryption_key_version = <old> LIMIT 100 FOR UPDATE`
   — the row lock matters: a token refresh (§6) may be rewriting the same
   provider row concurrently, and `credential_version` optimistic checks must
   not be bypassed.
2. Decrypt with the old version's key.
3. Re-encrypt with the current key.
4. `UPDATE ... SET encrypted_* = $new, encryption_key_version = <new>`.
5. Commit. Log the batch count only — **never** the plaintext, the ciphertext, or
   a key (§16, §17).

**NOT YET IMPLEMENTED:** there is no re-encryption CLI in the repository. It
belongs in `packages/database` or a `cli/` entrypoint owned by that package, not
in `scripts/`, because it needs the keyring and the repositories. Sketch:

```
pnpm exec tsx packages/database/src/cli/reencrypt.ts \
  --table provider_accounts --from-version 1 --to-version 2 --batch 100
```

Run it repeatedly until the version histogram shows zero rows at the old
version. Make it idempotent and resumable so an interrupted run is safe to
re-run — that is the whole point of batching.

`provider_accounts` is small (tens of rows). `api_keys` is bounded by the
24-hour validity window, so it is small too — and note that simply **waiting 24
hours** retires most of that table for you, which is often easier than
re-encrypting it.

### Step 4 — Prove nothing references the old version

Do not skip this. Retiring a key that is still referenced makes those rows
permanently unreadable.

```
-- Both must return zero rows before you touch the old key.
SELECT count(*) FROM provider_accounts WHERE encryption_key_version < <new>;
SELECT count(*) FROM api_keys          WHERE encryption_key_version < <new>;
```

Also confirm there is no ciphertext hiding in a place the histogram misses:
check any backup you intend to restore from. A dump taken before the rotation
still needs the old key, which is why the next step says _archive_, not
_delete_.

### Step 5 — Retire the old key

Only once step 4 returns zero:

1. Remove `*_PREVIOUS` from every `/etc/bosanda/*.env`.
2. Restart the services.
3. Run `./scripts/healthcheck.sh`.
4. **Archive** the retired key offline — do not destroy it. Any backup predating
   the rotation still requires it, so destroying it silently makes those backups
   unrestorable. Keep it until every backup that needs it has aged out of
   retention (`BOSANDA_BACKUP_RETENTION_DAYS`, default 14 days).

Record completion in the audit log.

## Rollback

Rotation is reversible only up to step 5, and only because the old key still
exists:

- **Failed at step 2** — restore the previous env files, restart. Nothing was
  re-encrypted.
- **Failed mid step 3** — harmless. Rows are split across two versions and both
  keys are present, so everything still decrypts. Fix the job and resume.
- **Failed after step 5** — the old key is archived, not destroyed. Put it back
  in `*_PREVIOUS`, restart, and re-run step 4 to find what was missed. This is
  precisely why step 5 says archive.

## Cadence

Rotate `SESSION_SECRET` freely; it is nearly free. Rotate the encryption keys
annually, on operator departure, or on any suspicion of exposure. Do not rotate
`API_KEY_LOOKUP_SECRET` on a schedule — the customer impact outweighs the
hygiene benefit for a secret protecting 24-hour credentials.
