import Link from "next/link";
import { Card } from "../components/Card";
import { listPublicModels } from "../lib/api";
import { PUBLIC_API_URL } from "../lib/env";
import { formatTokensExact } from "../lib/format";
import { MAX_TOKENS_PER_KEY, VALIDITY_HOURS } from "../lib/packages";

/**
 * Public API documentation (PLAN.md §8 surfaces, §9 models, §10 metering).
 *
 * The model table comes from the gateway's own `/v1/models`, so it cannot drift
 * from what is actually purchasable. When the gateway is unreachable the page
 * says so rather than falling back to invented rows — §9 keeps multipliers
 * admin-managed and versioned, and §3 forbids advertising a model before it
 * passes the compatibility gate.
 */

export const metadata = {
  title: "API documentation",
};

export const dynamic = "force-dynamic";

const OPENAI_EXAMPLE = `curl ${"https://api.bosanda.dev"}/v1/chat/completions \\
  -H "Authorization: Bearer $BOSANDA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "<model-id>",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'`;

const ANTHROPIC_EXAMPLE = `curl ${"https://api.bosanda.dev"}/v1/messages \\
  -H "x-api-key: $BOSANDA_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "<model-id>",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;

const SDK_EXAMPLE = `# OpenAI SDKs: point base_url at the gateway.
from openai import OpenAI

client = OpenAI(
    api_key="<your bosanda key>",
    base_url="https://api.bosanda.dev/v1",
)`;

export default async function DocsPage() {
  const models = await listPublicModels();

  return (
    <main id="main" className="shell">
      <section className="section">
        <p className="eyebrow">API reference</p>
        <h1>Point your existing client at Bosanda</h1>
        <p className="lede">
          Two compatible surfaces on one balance. If your tool already speaks to OpenAI or to
          Anthropic, change the base URL and the key — nothing else.
        </p>
        <p>
          Base URL: <code className="inline">{PUBLIC_API_URL}</code>
        </p>
      </section>

      <section className="section" aria-labelledby="auth-heading">
        <h2 id="auth-heading">Authentication</h2>
        <Card>
          <p>
            Send your key as <code className="inline">Authorization: Bearer &lt;key&gt;</code> on
            the OpenAI-compatible surface, or as{" "}
            <code className="inline">x-api-key: &lt;key&gt;</code> on the Anthropic-compatible one.
            Keys look like <code className="inline">bsk_…</code>.
          </p>
          <p className="muted">
            Treat a key as a bearer credential: anyone holding it can spend your balance. Keys are
            shown masked in your dashboard and can be revoked there at any time. We cannot recover a
            key you have lost from anywhere other than your own dashboard.
          </p>
        </Card>
      </section>

      <section className="section" aria-labelledby="models-heading">
        <h2 id="models-heading">Models and multipliers</h2>
        <p className="muted">
          Your balance is drawn down by{" "}
          <strong>(input tokens + output tokens) × the model multiplier</strong>. Multipliers are
          versioned and effective-dated, so a change never re-prices usage you have already spent.
        </p>

        {models.length === 0 ? (
          <div className="alert alert--info" role="status">
            <div className="alert__body">
              <strong>No models are published yet.</strong> We do not list a model — or its
              multiplier — until it has passed our upstream compatibility checks. Call{" "}
              <code className="inline">GET /v1/models</code> for the live list; it is the
              authoritative source and this page renders exactly what it returns.
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <caption>
                Published models. Fetched live from <code className="inline">GET /v1/models</code>.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Model ID</th>
                  <th scope="col">Name</th>
                  <th scope="col" className="num">
                    Context
                  </th>
                  <th scope="col" className="num">
                    Multiplier
                  </th>
                  <th scope="col">Capabilities</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id}>
                    <td className="mono">{model.id}</td>
                    <td>{model.label}</td>
                    <td className="num">{formatTokensExact(model.contextWindow)}</td>
                    <td className="num">
                      {model.multiplier}×
                      <span className="visually-hidden"> (version {model.multiplierVersion})</span>
                    </td>
                    <td>
                      {[
                        model.supportsTools ? "tools" : null,
                        model.supportsReasoning ? "reasoning" : null,
                      ]
                        .filter((capability) => capability !== null)
                        .join(", ") || "text"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="openai-heading">
        <h2 id="openai-heading">OpenAI-compatible surface</h2>
        <Card>
          <ul>
            <li>
              <code className="inline">POST /v1/chat/completions</code> — streaming and
              non-streaming, tool calls included
            </li>
            <li>
              <code className="inline">GET /v1/models</code> and{" "}
              <code className="inline">GET /v1/models/:id</code>
            </li>
          </ul>
          <pre className="code">{OPENAI_EXAMPLE}</pre>
          <pre className="code">{SDK_EXAMPLE}</pre>
          <p className="muted">
            Pass <code className="inline">stream_options.include_usage</code> to get a final usage
            chunk with the token counts we billed.
          </p>
        </Card>
      </section>

      <section className="section" aria-labelledby="anthropic-heading">
        <h2 id="anthropic-heading">Anthropic-compatible surface</h2>
        <Card>
          <ul>
            <li>
              <code className="inline">POST /v1/messages</code> — streaming and non-streaming
            </li>
            <li>
              <code className="inline">POST /v1/messages/count_tokens</code> — counted locally, and
              free: it never reaches a model, so it costs you nothing
            </li>
          </ul>
          <pre className="code">{ANTHROPIC_EXAMPLE}</pre>
          <p className="muted">
            The <code className="inline">anthropic-version</code> header is required, matching the
            upstream contract.
          </p>
        </Card>
      </section>

      <section className="section" aria-labelledby="limits-heading">
        <h2 id="limits-heading">Limits and errors</h2>
        <div className="grid cols-2">
          <Card>
            <h3 className="card__title">Per-key limits</h3>
            <ul>
              <li>5 concurrent requests</li>
              <li>100 requests per minute</li>
              <li>{formatTokensExact(MAX_TOKENS_PER_KEY)} weighted tokens maximum on one key</li>
              <li>{VALIDITY_HOURS}-hour validity from confirmed payment</li>
            </ul>
            <p className="muted">
              A stream that has already started is always allowed to finish, even if it crosses your
              remaining balance. You are never cut off mid-response.
            </p>
          </Card>
          <Card>
            <h3 className="card__title">Errors</h3>
            <p>
              Errors use the error envelope of whichever surface you called, so your existing client
              handles them unchanged. Status codes follow the usual conventions:{" "}
              <code className="inline">401</code> for a bad or revoked key,{" "}
              <code className="inline">429</code> for a rate, concurrency, or quota limit,{" "}
              <code className="inline">503</code> when no capacity is available.
            </p>
            <p className="muted">
              Error messages are deliberately generic. We do not forward upstream provider text,
              because it can contain details that are not ours to relay.
            </p>
          </Card>
        </div>
      </section>

      <section className="section" aria-labelledby="privacy-heading">
        <h2 id="privacy-heading">What we log</h2>
        <Card>
          <p>
            Token counts, model ID, timings, and error classes — the minimum needed to bill you
            correctly and keep the service up. We do not retain prompts, responses, tool inputs, or
            tool results.
          </p>
          <p className="muted">
            Tools execute in your client. The gateway passes tool definitions and results through
            and never runs a tool, reads your filesystem, or injects a tool you did not send.
          </p>
        </Card>
        <p style={{ marginTop: 20 }}>
          <Link className="btn btn--primary" href="/">
            Buy a package
          </Link>
        </p>
      </section>
    </main>
  );
}
