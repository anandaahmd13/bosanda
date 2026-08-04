# Codex App Server compatibility gate

Status: **NOT PASSED**. Codex customer routing and tool use remain disabled.

Pinned reference: `openai/codex` commit `c82cb044f3413e6584308d969b94e7a1430711ab`.

## Supported boundary

Bosanda must launch the official CLI as `codex app-server --listen stdio://` and speak its newline-delimited external protocol. The wire format is JSON request/notification/response without relying on a `jsonrpc` field. Each connection performs exactly:

1. `initialize` with `clientInfo` (`name`, optional `title`, `version`) and capabilities.
2. Wait for the initialize response.
3. Send `{"method":"initialized"}` with no params.
4. Use documented account/model/thread/turn methods only.

Bosanda must not implement OAuth token exchange, copy `auth.json`, call private ChatGPT endpoints, or use the in-process `app-server-client` crate as an external protocol.

Gateway ↔ runtime uses a Unix socket (`OPENAI_CODEX_SOCKET`) with ops: `health`, `account.*`, `model.list`, `turn.*`. App Server credentials stay under per-account `CODEX_HOME` dirs; Postgres rows for Codex use null sealed credentials.

## Owner-run evidence required

Fill each row with **observed** results only. Offline unit tests do not clear this gate.

| #   | Check                                                                       | Result           | Evidence |
| --- | --------------------------------------------------------------------------- | ---------------- | -------- |
| V1  | Exact `codex --version`; reject mismatch vs `OPENAI_CODEX_EXPECTED_VERSION` | NOT-YET-EXECUTED |          |
| O1  | Browser login via App Server (local)                                        | NOT-YET-EXECUTED |          |
| O2  | Remote login tunnel `ssh -N -L 1455:127.0.0.1:1455 <host>`                  | NOT-YET-EXECUTED |          |
| O3  | Account state after login / process restart / logout (no token reads)       | NOT-YET-EXECUTED |          |
| M1  | Model discovery via runtime `model.list`                                    | NOT-YET-EXECUTED |          |
| S1  | Text + reasoning deltas stream                                              | NOT-YET-EXECUTED |          |
| S2  | Complete usage reported                                                     | NOT-YET-EXECUTED |          |
| S3  | Abort mid-turn                                                              | NOT-YET-EXECUTED |          |
| S4  | Sanitized errors (no token/prompt leak)                                     | NOT-YET-EXECUTED |          |
| C1  | Full client-supplied history across requests                                | NOT-YET-EXECUTED |          |
| C2  | Client-side dynamic-tool continuation, account-pinned                       | NOT-YET-EXECUTED |          |
| I1  | No shell/fs/MCP/web/host tools in runtime account                           | NOT-YET-EXECUTED |          |
| P1  | Process loss never silently resumes turn on another account                 | NOT-YET-EXECUTED |          |

## Release gates

Until all evidence is recorded, models stay unpublished/untested and `OPENAI_CODEX_COMMERCIAL_ENABLED`, `OPENAI_CODEX_TOOL_USE_ENABLED`, and public Codex routing stay false. Written OpenAI approval is also required before subscription-account pooling or resale is enabled.

The App Server README marks websocket transport and several plugin methods experimental or unsuitable for production clients; use stdio only for this integration.

## Offline scaffolding (not evidence)

- `apps/codex-runtime` — socket server + `CodexRpcClient`
- `packages/provider-codex` — adapter, events, continuation map, socket client
- `spikes/codex-app-server` — pinned protocol constants for owner harnesses
- Admin routes under `/admin/v1/provider-accounts/codex*` for managed OAuth lifecycle
