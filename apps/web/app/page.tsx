import Link from "next/link";
import { Card } from "./components/Card";
import { Chip } from "./components/Chip";
import { getStorefront } from "./lib/api";
import { formatIdr, formatTokensCompact, formatTokensExact } from "./lib/format";
import { MAX_TOKENS_PER_KEY, PRICE_PER_10M_IDR, STEP_TOKENS, VALIDITY_HOURS } from "./lib/packages";
import type { StockEntry } from "./lib/schemas";

/**
 * Storefront (PLAN.md §11 packages/pricing/stock, §22 commercial summary).
 *
 * Server component. Stock and the global sales switch are read per request —
 * a cached package grid would advertise stock that is already sold.
 */

export const metadata = {
  title: "Prepaid AI gateway packages",
};

// Stock changes on every order; §11 makes availability the thing a buyer acts on.
export const dynamic = "force-dynamic";

/** Availability wording. Never claims a count when the size is switched off. */
function availability(entry: StockEntry): {
  tone: "success" | "warning" | "danger" | "neutral";
  label: string;
} {
  if (!entry.enabled) return { tone: "neutral", label: "Unavailable" };
  if (entry.available <= 0) return { tone: "danger", label: "Sold out" };
  if (entry.available <= 2) return { tone: "warning", label: `Only ${entry.available} left` };
  return { tone: "success", label: "In stock" };
}

export default async function StorefrontPage() {
  // A gateway outage must not 500 the public storefront: it renders the
  // explanation below and the pricing rule, which are both still true.
  let storefront: Awaited<ReturnType<typeof getStorefront>> | null = null;
  try {
    storefront = await getStorefront();
  } catch {
    storefront = null;
  }

  const salesEnabled = storefront?.salesEnabled ?? false;
  const stock = storefront?.stock ?? [];

  return (
    <main id="main" className="shell">
      <section className="section">
        <p className="eyebrow">Prepaid, no subscription</p>
        <h1>An OpenAI- and Anthropic-compatible gateway you top up like credit</h1>
        <p className="lede">
          Buy a block of weighted tokens, get an API key, point your existing client at it. Nothing
          recurring, no seats, no minimum. {formatIdr(PRICE_PER_10M_IDR)} per{" "}
          {formatTokensCompact(STEP_TOKENS)} weighted tokens.
        </p>
        <div className="btn-row">
          <Link className="btn btn--primary" href="#packages">
            See packages
          </Link>
          <Link className="btn btn--ghost" href="/docs">
            Read the API docs
          </Link>
        </div>
      </section>

      {storefront === null ? (
        <div className="alert alert--warning" role="status">
          <div className="alert__body">
            <strong>Live availability is unavailable right now.</strong> Pricing below is the
            published rule and is accurate, but we cannot confirm stock until the service responds.
            Please try again shortly.
          </div>
        </div>
      ) : null}

      {storefront !== null && !salesEnabled ? (
        <div className="alert alert--info" role="status">
          <div className="alert__body">
            <strong>Sales are currently closed.</strong> New purchases are switched off while we
            validate upstream model compatibility. Existing keys keep working until they expire.
          </div>
        </div>
      ) : null}

      <section className="section" id="packages" aria-labelledby="packages-heading">
        <h2 id="packages-heading">Packages</h2>
        <p className="muted">
          Every size is the same price per token. Larger blocks exist for convenience, not for a
          discount — the rate is flat and stated up front.
        </p>

        {stock.length === 0 ? (
          <Card>
            <p className="muted" style={{ margin: 0 }}>
              No package sizes are published at the moment.
            </p>
          </Card>
        ) : (
          <ul className="grid cols-3" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {stock.map((entry) => {
              const state = availability(entry);
              const buyable = salesEnabled && entry.enabled && entry.available > 0;
              return (
                <Card as="li" key={entry.packageId}>
                  <div className="row-between">
                    <h3 className="card__title" style={{ margin: 0 }}>
                      {formatTokensCompact(entry.tokens)} tokens
                    </h3>
                    <Chip tone={state.tone}>{state.label}</Chip>
                  </div>
                  <p className="price">{formatIdr(entry.priceIdr)}</p>
                  <p className="muted" style={{ marginTop: 0 }}>
                    {formatTokensExact(entry.tokens)} weighted tokens · valid {VALIDITY_HOURS} hours
                    from payment
                  </p>
                  {buyable ? (
                    <Link
                      className="btn btn--primary btn--sm"
                      href={`/checkout?package=${encodeURIComponent(entry.packageId)}`}
                    >
                      Buy {formatTokensCompact(entry.tokens)}
                      <span className="visually-hidden">
                        {" "}
                        tokens for {formatIdr(entry.priceIdr)}
                      </span>
                    </Link>
                  ) : (
                    <p className="sold-out" style={{ marginBottom: 0 }}>
                      {entry.enabled ? "Out of stock" : "Not for sale"}
                    </p>
                  )}
                </Card>
              );
            })}
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="how-heading">
        <h2 id="how-heading">How the billing works</h2>
        <div className="grid cols-2">
          <Card>
            <h3 className="card__title">Weighted tokens, not requests</h3>
            <p>
              You are charged{" "}
              <strong>(input tokens + output tokens) × the model&apos;s multiplier</strong>. A
              cheaper model draws down your balance more slowly; an expensive one draws it faster.
              One balance covers every model.
            </p>
            <p className="muted">
              Each model&apos;s current multiplier is published on the{" "}
              <Link href="/docs">API docs page</Link>, and multipliers are versioned so a change
              never re-prices usage you already spent.
            </p>
          </Card>
          <Card>
            <h3 className="card__title">A key lasts {VALIDITY_HOURS} hours</h3>
            <p>
              Validity starts when your payment is confirmed, not when you first call the API. Any
              balance left when the window closes is not carried over, so buy the size you will
              actually use.
            </p>
            <p className="muted">
              A single key holds at most {formatTokensCompact(MAX_TOKENS_PER_KEY)} tokens. You can
              top up a key that is still active instead of creating a new one.
            </p>
          </Card>
        </div>
      </section>

      <section className="section" aria-labelledby="honest-heading">
        <h2 id="honest-heading">What we do not do</h2>
        <Card>
          <ul>
            <li>No free tier and no trial credit.</li>
            <li>
              No refunds for unused balance once a key is activated — the validity window is stated
              before you pay.
            </li>
            <li>
              We do not store your prompts, responses, tool inputs, or tool results. We record token
              counts for billing and error classes for reliability, nothing else.
            </li>
            <li>Tools run in your client. This service never executes a tool on your behalf.</li>
          </ul>
        </Card>
      </section>
    </main>
  );
}
