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

## Owner-run evidence required

- Record the exact `codex --version` output and reject unexpected versions.
- Start browser login through App Server; use `ssh -N -L 1455:127.0.0.1:1455 <host>` for a remote server.
- Verify account state after login, restart, and logout without reading token material.
- Verify model discovery, text/reasoning deltas, complete usage, abort, and sanitized errors.
- Prove complete canonical history and client-side dynamic-tool continuation across requests.
- Prove no shell, filesystem, MCP, web, collaboration, or other host-side action can run in the runtime account.
- Verify process loss never silently resumes a turn on another account.

## Release gates

Until all evidence is recorded, models stay unpublished/untested and `OPENAI_CODEX_COMMERCIAL_ENABLED`, `OPENAI_CODEX_TOOL_USE_ENABLED`, and public Codex routing stay false. Written OpenAI approval is also required before subscription-account pooling or resale is enabled.

The App Server README marks websocket transport and several plugin methods experimental or unsuitable for production clients; use stdio only for this integration.
