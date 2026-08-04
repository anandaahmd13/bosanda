export type CodexGateResult = {
  initialized: boolean;
  authenticated: boolean;
  textStreaming: boolean;
  clientToolsSafe: boolean;
  usageComplete: boolean;
  abortWorks: boolean;
  historyContinuation: boolean;
  processLossIsolated: boolean;
  hostToolsIsolated: boolean;
};

export const CODEX_APP_SERVER_PROTOCOL = {
  commit: "c82cb044f3413e6584308d969b94e7a1430711ab",
  launch: ["app-server", "--listen", "stdio://"] as const,
  initialize: "initialize",
  initialized: "initialized",
  /** Methods the owner harness should exercise against a pinned binary. */
  methods: [
    "account/read",
    "account/login/start",
    "account/login/cancel",
    "account/logout",
    "model/list",
    "turn/start",
    "turn/continue",
    "turn/abort",
  ] as const,
  runtimeSocketOps: [
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
  ] as const,
} as const;

/** Empty template — fill only after owner-run observations. */
export function emptyGateResult(): CodexGateResult {
  return {
    initialized: false,
    authenticated: false,
    textStreaming: false,
    clientToolsSafe: false,
    usageComplete: false,
    abortWorks: false,
    historyContinuation: false,
    processLossIsolated: false,
    hostToolsIsolated: false,
  };
}
