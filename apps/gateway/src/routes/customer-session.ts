import type { FastifyInstance, FastifyRequest } from "fastify";
import { BosandaError } from "@bosanda/protocol";
import {
  evaluateSession,
  parseCookies,
  sessionDigest,
  serializeCookie,
  clearedCookie,
  startSession,
  attemptLogin,
  assertLoginSucceeded,
  prepareRegistration,
  type UserRecord,
} from "@bosanda/auth";
import { ulid } from "@bosanda/shared";
import type { CustomerDeps } from "../customer-dependencies.js";

export const CUSTOMER_SESSION_COOKIE = "bosanda_session";

function invalid(detail: string): BosandaError {
  return new BosandaError("invalid_request", { internalDetail: `customer request: ${detail}` });
}

function body(request: FastifyRequest): Record<string, unknown> {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    throw invalid("body must be an object");
  }
  return request.body as Record<string, unknown>;
}

function field(input: Record<string, unknown>, key: string, max: number): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw invalid(`${key} is invalid`);
  }
  return value;
}

function sessionCookie(deps: CustomerDeps, token: string, expiresAt: Date): string {
  return serializeCookie({
    // The web app forwards this exact cookie name to the gateway. `Secure` is the
    // transport attribute; changing the name in production would make every next
    // server-to-server request appear signed out.
    name: CUSTOMER_SESSION_COOKIE,
    value: token,
    maxAgeSeconds: Math.max(
      0,
      Math.floor((expiresAt.getTime() - deps.clock.now().getTime()) / 1000),
    ),
    secure: deps.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
  });
}

function clearSessionCookie(deps: CustomerDeps): string {
  return serializeCookie(
    clearedCookie(CUSTOMER_SESSION_COOKIE, { secure: deps.env.NODE_ENV === "production" }),
  );
}

function tokenFrom(request: FastifyRequest): string | null {
  const raw = request.headers.cookie;
  if (typeof raw !== "string") return null;
  const token = parseCookies(raw).get(CUSTOMER_SESSION_COOKIE);
  return token !== undefined && token.length > 0 ? token : null;
}

export type CustomerActor = {
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
};

export async function requireCustomer(
  request: FastifyRequest,
  deps: CustomerDeps,
): Promise<CustomerActor> {
  const token = tokenFrom(request);
  if (token === null) {
    throw new BosandaError("authentication_error", { internalDetail: "customer session missing" });
  }
  const found = await deps.sessions.findWithUser(sessionDigest(token, deps.keyring));
  const validity = evaluateSession(found?.session ?? null, deps.clock.now());
  if (!validity.valid || found === null || found.user.status !== "active") {
    throw new BosandaError("authentication_error", { internalDetail: "customer session rejected" });
  }
  await deps.sessions.touchLastUsed(found.session.id, deps.clock.now());
  return { sessionId: found.session.id, userId: found.user.id, username: found.user.username };
}

export function registerCustomerSessionRoutes(app: FastifyInstance, deps: CustomerDeps): void {
  app.post("/v1/auth/register", async (request, reply) => {
    const input = body(request);
    const username = field(input, "username", 64);
    const password = field(input, "password", 1024);
    const prepared = await prepareRegistration(username, password, deps.clock);
    const created = await deps.transact(async (tx) => {
      const user = await tx.users.insert({ id: ulid(), ...prepared });
      const session = startSession(user.id, deps.keyring, deps.clock);
      await tx.sessions.insert({
        id: ulid(),
        userId: user.id,
        tokenHash: session.token.digest,
        expiresAt: session.record.expiresAt,
        createdAt: session.record.createdAt,
        lastUsedAt: session.record.lastUsedAt ?? session.record.createdAt,
      });
      await tx.audit.append({
        id: ulid(),
        actorType: "user",
        actorId: user.id,
        action: "session.created",
        targetType: "user",
        targetId: user.id,
        metadata: { reason: "customer registration" },
        createdAt: deps.clock.now(),
      });
      return { user, session };
    });
    return reply
      .status(201)
      .header(
        "set-cookie",
        sessionCookie(deps, created.session.token.plaintext, created.session.record.expiresAt),
      )
      .send({ ok: true });
  });

  app.post("/v1/auth/login", async (request, reply) => {
    const input = body(request);
    const username = field(input, "username", 64);
    const password = field(input, "password", 1024);
    const existing = await deps.users.findByUsername(username);
    const candidate: UserRecord | null =
      existing === null
        ? null
        : {
            id: existing.id,
            username: existing.username,
            passwordHash: existing.passwordHash,
            role: existing.role,
            status: existing.status,
          };
    const outcome = await attemptLogin({
      username,
      password,
      user: candidate,
      decoyHash: deps.decoyHash,
    });
    const user = assertLoginSucceeded(outcome);
    const started = startSession(user.id, deps.keyring, deps.clock);
    await deps.transact(async (tx) => {
      await tx.sessions.insert({
        id: ulid(),
        userId: user.id,
        tokenHash: started.token.digest,
        expiresAt: started.record.expiresAt,
        createdAt: started.record.createdAt,
        lastUsedAt: started.record.lastUsedAt ?? started.record.createdAt,
      });
      await tx.audit.append({
        id: ulid(),
        actorType: "user",
        actorId: user.id,
        action: "session.created",
        targetType: "user",
        targetId: user.id,
        metadata: { reason: "customer login" },
        createdAt: deps.clock.now(),
      });
    });
    return reply
      .status(200)
      .header("set-cookie", sessionCookie(deps, started.token.plaintext, started.record.expiresAt))
      .send({ ok: true });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const actor = await requireCustomer(request, deps);
    const token = tokenFrom(request);
    if (token !== null) {
      await deps.sessions.revokeByTokenHash(sessionDigest(token, deps.keyring), deps.clock.now());
    }
    await deps.transact((tx) =>
      tx.audit.append({
        id: ulid(),
        actorType: "user",
        actorId: actor.userId,
        action: "session.revoked",
        targetType: "session",
        targetId: actor.sessionId,
        metadata: { reason: "customer logout" },
        createdAt: deps.clock.now(),
      }),
    );
    return reply.status(200).header("set-cookie", clearSessionCookie(deps)).send({ ok: true });
  });
}

export { body, field, invalid, tokenFrom };
