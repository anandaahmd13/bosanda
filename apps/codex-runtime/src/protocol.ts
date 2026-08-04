/**
 * Unix-socket protocol between the gateway and the Codex runtime service.
 * Newline-delimited JSON. Responses never carry token material.
 */

export type RuntimeRequest = {
  id?: string;
  op: string;
  accountId?: string;
  params?: Record<string, unknown>;
};

export type RuntimeResponse = {
  id?: string;
  ok: boolean;
  error?: string;
  result?: unknown;
  event?: { method: string; params?: Record<string, unknown> };
  done?: boolean;
};

export const RUNTIME_OPS = [
  "health",
  "account.read",
  "account.login.start",
  "account.login.status",
  "account.login.cancel",
  "account.logout",
  "model.list",
  "turn.start",
  "turn.abort",
  "turn.continue",
] as const;

export type RuntimeOp = (typeof RUNTIME_OPS)[number];
