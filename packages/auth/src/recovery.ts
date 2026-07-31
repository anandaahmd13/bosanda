/**
 * Admin-initiated password reset (PLAN.md §12 "Manual account recovery").
 *
 * There is deliberately NO self-service reset flow. Version 1 does not collect
 * email, so there is no channel to send a reset link to; a "recovery" that
 * relied on anything the requester supplies would be an account-takeover
 * endpoint. Users contact support, and an authenticated admin performs the
 * reset here.
 *
 * The four requirements §12 places on this operation — admin authentication,
 * revoke every session, audit actor/target/timestamp/reason, never reveal the
 * old password — are enforced by this module rather than left to the caller,
 * because a route that forgets the session revocation leaves the attacker's
 * stolen cookie working after the victim's password changes.
 */

import { BosandaError } from "@bosanda/protocol";
import type { Clock } from "@bosanda/shared";
import { hashPassword } from "./passwords.js";

export type AdminActor = {
  userId: string;
  /** Must be `admin`; checked here rather than trusted. */
  role: "admin" | "customer";
  /** The admin's own session, recorded so a reset is traceable to a login. */
  sessionId: string;
  ip: string | null;
  userAgent: string | null;
};

export type ResetAuditEntry = {
  action: "user.password_reset";
  /** The admin who performed it. */
  actorType: "admin";
  actorId: string;
  actorSessionId: string;
  /** The account that was reset. */
  targetUserId: string;
  /** Free text the admin must supply. Never contains a password. */
  reason: string;
  ip: string | null;
  userAgent: string | null;
  at: Date;
  /** How many sessions the reset invalidated. */
  revokedSessionCount: number;
  outcome: "succeeded" | "denied";
};

export type ResetAuditSink = {
  record(entry: ResetAuditEntry): Promise<void>;
};

export type ResetStore = {
  /** Persist the new hash. Must not touch any other column. */
  setPasswordHash(userId: string, passwordHash: string, at: Date): Promise<void>;
  /** Revoke every session for the user; returns how many were affected. */
  revokeAllSessions(userId: string, at: Date): Promise<number>;
};

export const MIN_RESET_REASON_LENGTH = 8;

export type ResetPasswordInput = {
  actor: AdminActor;
  targetUserId: string;
  newPassword: string;
  reason: string;
  store: ResetStore;
  audit: ResetAuditSink;
  clock: Clock;
};

export type ResetPasswordResult = {
  revokedSessionCount: number;
  at: Date;
};

/**
 * Reset a user's password as an admin.
 *
 * Ordering matters: the password is changed first, then every session is
 * revoked, then the audit row is written. Revoking after the change means there
 * is no window in which the old password is dead but an old cookie still works.
 * The audit write is awaited and its failure propagates — an unaudited reset is
 * treated as a failed reset (§12 requires the record).
 */
export async function resetPasswordAsAdmin(
  input: ResetPasswordInput,
): Promise<ResetPasswordResult> {
  const { actor, targetUserId, newPassword, reason, store, audit, clock } = input;
  const at = clock.now();

  const deny = async (detail: string, code: "authentication_error" | "invalid_request") => {
    await audit.record({
      action: "user.password_reset",
      actorType: "admin",
      actorId: actor.userId,
      actorSessionId: actor.sessionId,
      targetUserId,
      reason,
      ip: actor.ip,
      userAgent: actor.userAgent,
      at,
      revokedSessionCount: 0,
      outcome: "denied",
    });
    throw new BosandaError(code, { internalDetail: detail });
  };

  if (actor.role !== "admin") {
    // Audited even when denied: a non-admin reaching this call is worth seeing.
    await deny(
      `non-admin ${actor.userId} attempted password reset of ${targetUserId}`,
      "authentication_error",
    );
  }

  // A reason is mandatory because it is the only record of why an admin took
  // over an account, and identity verification is an operational
  // responsibility (§12) that this text documents.
  if (reason.trim().length < MIN_RESET_REASON_LENGTH) {
    await deny(
      `password reset of ${targetUserId} rejected: reason must be at least ` +
        `${MIN_RESET_REASON_LENGTH} characters`,
      "invalid_request",
    );
  }

  // hashPassword validates length and throws before anything is written.
  const passwordHash = await hashPassword(newPassword);

  await store.setPasswordHash(targetUserId, passwordHash, at);
  const revokedSessionCount = await store.revokeAllSessions(targetUserId, at);

  await audit.record({
    action: "user.password_reset",
    actorType: "admin",
    actorId: actor.userId,
    actorSessionId: actor.sessionId,
    targetUserId,
    reason: reason.trim(),
    ip: actor.ip,
    userAgent: actor.userAgent,
    at,
    revokedSessionCount,
    outcome: "succeeded",
  });

  return { revokedSessionCount, at };
}

/**
 * Text for the admin UI. §12 requires warning that identity verification is the
 * admin's responsibility — the system cannot verify who asked.
 */
export const RESET_OPERATOR_WARNING =
  "Verify the requester's identity through the published support channel before resetting. " +
  "Bosanda cannot confirm who asked: this action takes over the account, signs out every " +
  "existing session, and is recorded against your admin account.";
