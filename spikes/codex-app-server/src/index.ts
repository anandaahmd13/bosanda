export type CodexGateResult = {
  initialized: boolean;
  authenticated: boolean;
  textStreaming: boolean;
  clientToolsSafe: boolean;
};

export const CODEX_APP_SERVER_PROTOCOL = {
  commit: "c82cb044f3413e6584308d969b94e7a1430711ab",
  launch: ["app-server", "--listen", "stdio://"],
  initialize: "initialize",
  initialized: "initialized",
} as const;
