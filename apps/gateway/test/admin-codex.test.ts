import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { adminHarness, providerAccount } from "./admin-harness.js";
import { harness } from "./harness.js";

async function setup(
  options: Parameters<typeof adminHarness>[0] = {},
  codex?: {
    authenticated?: boolean;
    models?: Record<string, unknown>[];
    runtimeEnabled?: boolean;
  },
) {
  const admin = await adminHarness(options);
  if (codex !== undefined) {
    admin.deps.codex.isRuntimeEnabled = () => codex.runtimeEnabled ?? true;
    admin.deps.codex.accountRead = async () => ({
      authenticated: codex.authenticated ?? false,
    });
    admin.deps.codex.loginStart = async () => ({
      state: "pending",
      authUrl: "http://127.0.0.1:1455/auth",
    });
    admin.deps.codex.loginStatus = async () => ({ state: "pending" });
    admin.deps.codex.loginCancel = async () => ({ state: "cancelled" });
    admin.deps.codex.logout = async () => undefined;
    admin.deps.codex.listModels = async () => codex.models ?? [{ id: "gpt-5-codex" }];
  }
  const metered = harness();
  const app = buildApp({ deps: metered.deps, admin: admin.deps });
  return { app, cookie: admin.cookie, fixtures: admin.fixtures, recorded: admin.recorded, admin };
}

describe("Codex admin lifecycle", () => {
  it("creates a managed Codex account without sealing credentials", async () => {
    const { app, cookie, fixtures, recorded } = await setup({}, { runtimeEnabled: true });

    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts/codex",
      headers: { cookie },
      payload: { label: "codex-pool-1", reason: "stage first Codex login" },
    });

    expect(response.statusCode).toBe(200);
    expect(fixtures.accounts.some((a) => a.providerType === "openai_codex")).toBe(true);
    const created = fixtures.accounts.find((a) => a.providerType === "openai_codex")!;
    expect(created.encryptionKeyVersion).toBeNull();
    expect(created.persona).toBe("app_server");
    expect(created.status).toBe("disabled");
    expect(recorded.sealed).toHaveLength(0);
    expect(recorded.audit.at(-1)!.action).toBe("provider_account.created");
  });

  it("lists Codex accounts with hasStoredCredential from runtime auth state", async () => {
    const account = providerAccount({
      providerType: "openai_codex",
      persona: "app_server",
      encryptionKeyVersion: null,
      label: "codex-1",
    });
    const { app, cookie } = await setup(
      { fixtures: { accounts: [account] } },
      { runtimeEnabled: true, authenticated: true },
    );

    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/provider-accounts/codex",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ accounts: Record<string, unknown>[] }>();
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]!["providerType"]).toBe("openai_codex");
    expect(body.accounts[0]!["hasStoredCredential"]).toBe(true);
    expect(body.accounts[0]!["persona"]).toBe("app_server");
  });

  it("starts login and never returns token material", async () => {
    const account = providerAccount({
      providerType: "openai_codex",
      persona: "app_server",
      encryptionKeyVersion: null,
    });
    const { app, cookie, recorded } = await setup(
      { fixtures: { accounts: [account] } },
      { runtimeEnabled: true },
    );

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/provider-accounts/${account.id}/codex/login/start`,
      headers: { cookie },
      payload: { reason: "operator login" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body["state"]).toBe("pending");
    expect(body["authUrl"]).toBe("http://127.0.0.1:1455/auth");
    expect(JSON.stringify(body)).not.toMatch(/refresh|access_token|sk-/i);
    expect(recorded.audit.at(-1)!.action).toBe("provider_account.codex_login_started");
  });

  it("syncs models as unpublished", async () => {
    const account = providerAccount({
      providerType: "openai_codex",
      persona: "app_server",
      encryptionKeyVersion: null,
    });
    const { app, cookie, fixtures, recorded } = await setup(
      { fixtures: { accounts: [account] } },
      { runtimeEnabled: true, models: [{ id: "gpt-5-codex", displayName: "Codex" }] },
    );

    const response = await app.inject({
      method: "POST",
      url: `/admin/v1/provider-accounts/${account.id}/codex/models/sync`,
      headers: { cookie },
      payload: { reason: "discover models after login" },
    });

    expect(response.statusCode).toBe(200);
    const model = fixtures.models.find((m) => m.publicId === "bosanda-codex-gpt-5-codex");
    expect(model).toBeDefined();
    expect(model!.published).toBe(false);
    expect(model!.providerType).toBe("openai_codex");
    expect(recorded.audit.at(-1)!.action).toBe("provider_account.codex_models_synced");
  });

  it("refuses Codex create when runtime is disabled", async () => {
    const { app, cookie } = await setup({}, { runtimeEnabled: false });
    const response = await app.inject({
      method: "POST",
      url: "/admin/v1/provider-accounts/codex",
      headers: { cookie },
      payload: { label: "codex", reason: "should fail" },
    });
    expect(response.statusCode).toBe(503);
  });
});
