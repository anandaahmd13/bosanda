/**
 * The single audit-write path for the admin surface (PLAN.md §15, §16 invariant 7).
 *
 * ── ONE FUNCTION, SO "EVERY MUTATION IS AUDITED" IS CHECKABLE ─────────────
 * Every admin mutation writes an `audit_events` row inside the same transaction as its
 * effect. Routing all of them through `writeAudit` means the property is verifiable by
 * reading the call sites of one function rather than by auditing thirty handlers, and the
 * `reason`-goes-in-metadata detail below is decided once.
 *
 * ── WHY `reason` IS METADATA AND NOT A COLUMN ─────────────────────────────
 * `auditEvent` in the admin schema has a top-level `reason`, and `audit_events` has no
 * such column — `AppendAuditInput` offers `metadata` and nothing else. `"reason"` is not
 * in `FORBIDDEN_METADATA_KEYS`, so `metadata: {reason}` is legal, and the read path lifts
 * it back to the top level. The alternative (dropping the reason) would defeat the point
 * of §15, and the client sends one on nearly every mutation specifically so the record
 * exists.
 *
 * ── WHAT MAY NOT BE IN AN AUDIT ROW ───────────────────────────────────────
 * No credential, no password, no plaintext key, no session token — not even a length or a
 * prefix of one. `assertMetadataIsSafe` in `audit.ts` rejects the obvious key names by
 * throwing, which is a backstop and not the control: the control is that the callers here
 * pass ids, counts, and enum values only. Where a mutation's whole subject is a secret
 * (a credential rotation, a password reset) the row records THAT IT HAPPENED and to whom,
 * which is exactly what an investigation needs and all it may have.
 */

import { ulid } from "@bosanda/shared";
import type { AdminActor } from "./session.js";
import type { AdminTx } from "./deps.js";

/**
 * Action names, as one closed list.
 *
 * A string literal at each call site would drift (`user.disable` vs `user.disabled`) and
 * the audit log's only value is that a search for an action finds every instance of it.
 * The `<target>.<verb>` shape matches the two actions `executeActivation` already writes
 * (`order.activated_new_key`, `order.activated_top_up`) so the table reads uniformly.
 */
export const ADMIN_ACTIONS = {
  sessionCreated: "admin.session_created",
  sessionRevoked: "admin.session_revoked",

  providerAccountCreated: "provider_account.created",
  providerAccountUpdated: "provider_account.updated",
  providerCredentialRotated: "provider_account.credential_rotated",
  providerAccountEnabled: "provider_account.enabled_changed",
  providerAccountValidated: "provider_account.validated",
  providerCodexLoginStarted: "provider_account.codex_login_started",
  providerCodexLoginCancelled: "provider_account.codex_login_cancelled",
  providerCodexLoggedOut: "provider_account.codex_logged_out",
  providerCodexModelsSynced: "provider_account.codex_models_synced",

  modelMultiplierChanged: "model.multiplier_changed",
  modelPublishedChanged: "model.published_changed",

  packageUpdated: "package.updated",
  packageStockChanged: "package.stock_changed",

  orderActivated: "order.activated_by_admin",
  orderRefunded: "order.refunded",

  userEnabled: "user.enabled_changed",
  userPasswordReset: "user.password_reset",

  keyQuotaAdjusted: "api_key.quota_adjusted",
  keyRevoked: "api_key.revoked",

  flagChanged: "feature_flag.changed",
} as const;

export type AdminAction = (typeof ADMIN_ACTIONS)[keyof typeof ADMIN_ACTIONS];

export type AuditWrite = {
  readonly action: AdminAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  /**
   * Extra context. Ids, counts, booleans, and enum values ONLY.
   *
   * Typed as `string | number | boolean | null` rather than `unknown` so a credential or
   * an object containing one cannot be passed without a deliberate cast — the type is the
   * first line of the §16 control, `assertMetadataIsSafe` is the second.
   */
  readonly details?: Record<string, string | number | boolean | null>;
};

/**
 * Who performed the action.
 *
 * Narrower than `AdminActor` so `POST /admin/v1/session` can audit its own login: at
 * that point there is no session id yet and the authenticated user came from
 * `attemptLogin` rather than from the session guard. Widening the parameter is honest;
 * casting a `UserRecord` into an `AdminActor` to fit would not be.
 */
export type AuditActor = { readonly id: string; readonly username: string };

export function auditActor(actor: AdminActor): AuditActor {
  return { id: actor.user.id, username: actor.user.username };
}

/**
 * Appends one audit row for an admin action.
 *
 * Takes the transaction, not the deps: an audit row that commits while its effect rolls
 * back (or the reverse) is worse than either outcome alone, so there is no way to call
 * this outside the transaction that performs the change.
 */
export async function writeAudit(
  tx: AdminTx,
  actor: AuditActor,
  write: AuditWrite,
  at: Date,
): Promise<void> {
  await tx.audit.append({
    id: ulid(),
    actorType: "admin",
    actorId: actor.id,
    action: write.action,
    targetType: write.targetType,
    targetId: write.targetId,
    metadata: {
      reason: write.reason,
      // Denormalized so the log stays readable after a username changes; `actorId` above
      // remains the join key. Not a secret — it is the operator's own login.
      actorUsername: actor.username,
      ...(write.details ?? {}),
    },
    createdAt: at,
  });
}
