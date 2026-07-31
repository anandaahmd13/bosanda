import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import {
  PAKASIR_MAX_ATTEMPTS,
  buildCheckoutRequest,
  checkoutUrl,
  createPakasirCheckout,
  fetchPakasirTransaction,
  normalizePakasirStatus,
  parseTransactionPayload,
  redactPakasirUrl,
} from "../src/pakasir.js";
import { TimeoutError } from "@bosanda/shared";
import { config, fakeTransport, order, packageSnapshot } from "./fixtures.js";

const okBody = JSON.stringify({
  order_id: "01JQORDER00000000000000001",
  status: "pending",
  transaction_id: "trx_synthetic_1",
  amount: 9_500,
});

const expectBosanda = (error: unknown, code: string): BosandaError => {
  expect(error).toBeInstanceOf(BosandaError);
  const bosanda = error as BosandaError;
  expect(bosanda.code).toBe(code);
  return bosanda;
};

describe("buildCheckoutRequest", () => {
  it("builds from server-created order truth", () => {
    const request = buildCheckoutRequest(order(), "https://bosanda.test/orders/1");
    expect(request).toEqual({
      orderId: "01JQORDER00000000000000001",
      amount: 9_500,
      currency: "IDR",
      redirectUrl: "https://bosanda.test/orders/1",
    });
  });

  it("rejects a fractional amount (integer rupiah only)", () => {
    try {
      buildCheckoutRequest(
        order({ amountIdr: 9_500.5, packageSnapshot: packageSnapshot({ priceIdr: 9_500.5 }) }),
      );
      throw new Error("expected rejection");
    } catch (error) {
      expectBosanda(error, "invalid_request");
    }
  });

  it("rejects a zero or negative amount", () => {
    for (const amount of [0, -9_500]) {
      try {
        buildCheckoutRequest(
          order({ amountIdr: amount, packageSnapshot: packageSnapshot({ priceIdr: amount }) }),
        );
        throw new Error("expected rejection");
      } catch (error) {
        expectBosanda(error, "invalid_request");
      }
    }
  });

  it("rejects an amount that drifted from the frozen snapshot price", () => {
    try {
      buildCheckoutRequest(order({ amountIdr: 1_000 }));
      throw new Error("expected rejection");
    } catch (error) {
      const bosanda = expectBosanda(error, "invalid_request");
      expect(bosanda.internalDetail).toContain("!=");
    }
  });

  it("never leaks internal detail through publicMessage", () => {
    try {
      buildCheckoutRequest(order({ amountIdr: 1_000 }));
      throw new Error("expected rejection");
    } catch (error) {
      const bosanda = error as BosandaError;
      expect(bosanda.publicMessage).toBe("The request was invalid.");
      expect(bosanda.publicMessage).not.toContain("1000");
    }
  });
});

describe("checkoutUrl", () => {
  it("carries no api key into a browser-facing URL", () => {
    const url = checkoutUrl(config, buildCheckoutRequest(order()));
    expect(url).toContain("/pay/bosanda-test/9500");
    expect(url).toContain("order_id=01JQORDER00000000000000001");
    expect(url).not.toContain(String(config.apiKey));
  });
});

describe("createPakasirCheckout", () => {
  it("sends the expected request shape and returns a hosted URL", async () => {
    const { deps, calls } = fakeTransport([{ status: 200, body: okBody }]);
    const checkout = await createPakasirCheckout(order(), config, deps);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://pakasir.test/api/transactions");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      project: "bosanda-test",
      order_id: "01JQORDER00000000000000001",
      amount: 9_500,
      currency: "IDR",
    });
    expect(checkout.providerTransactionId).toBe("trx_synthetic_1");
    expect(checkout.status).toBe("pending");
    expect(checkout.paymentUrl).not.toContain(String(config.apiKey));
  });

  it("retries a transport failure and succeeds", async () => {
    const { deps, calls, sleeps } = fakeTransport([
      { throws: new Error("ECONNRESET") },
      { status: 200, body: okBody },
    ]);
    const checkout = await createPakasirCheckout(order(), config, deps);

    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(checkout.orderId).toBe("01JQORDER00000000000000001");
  });

  it("never retries a 4xx", async () => {
    const { deps, calls } = fakeTransport([{ status: 422, body: "unprocessable" }]);
    await expect(createPakasirCheckout(order(), config, deps)).rejects.toBeInstanceOf(BosandaError);
    expect(calls).toHaveLength(1);
  });

  it("never retries a 5xx, because a re-POST could double-charge", async () => {
    const { deps, calls } = fakeTransport([{ status: 502, body: "bad gateway" }]);
    await expect(createPakasirCheckout(order(), config, deps)).rejects.toBeInstanceOf(BosandaError);
    expect(calls).toHaveLength(1);
  });

  it("keeps the upstream body out of the error", async () => {
    const { deps } = fakeTransport([{ status: 400, body: "SECRET_UPSTREAM_ECHO" }]);
    try {
      await createPakasirCheckout(order(), config, deps);
      throw new Error("expected rejection");
    } catch (error) {
      const bosanda = error as BosandaError;
      expect(bosanda.internalDetail ?? "").not.toContain("SECRET_UPSTREAM_ECHO");
      expect(bosanda.internalDetail ?? "").toContain("400");
    }
  });

  it("times out a hanging attempt and gives up after maxAttempts", async () => {
    const { deps, calls } = fakeTransport([{ hang: true }, { hang: true }, { hang: true }]);
    try {
      await createPakasirCheckout(order(), config, deps);
      throw new Error("expected rejection");
    } catch (error) {
      const bosanda = expectBosanda(error, "upstream_timeout");
      expect(bosanda.status).toBe(504);
    }
    expect(calls).toHaveLength(PAKASIR_MAX_ATTEMPTS);
  });

  it("exhausts bounded retries on repeated transport failure", async () => {
    const { deps, calls, sleeps } = fakeTransport([
      { throws: new Error("EAI_AGAIN") },
      { throws: new Error("EAI_AGAIN") },
      { throws: new Error("EAI_AGAIN") },
    ]);
    await expect(createPakasirCheckout(order(), config, deps)).rejects.toBeInstanceOf(BosandaError);
    expect(calls).toHaveLength(3);
    // One fewer sleep than attempts: no wait after the final failure.
    expect(sleeps).toHaveLength(2);
  });

  it("no error from a failed checkout contains the api key", async () => {
    const { deps } = fakeTransport([{ throws: new Error("boom") }, { hang: true }, { hang: true }]);
    try {
      await createPakasirCheckout(order(), config, deps);
      throw new Error("expected rejection");
    } catch (error) {
      const serialized = JSON.stringify({
        message: (error as Error).message,
        detail: (error as BosandaError).internalDetail,
      });
      expect(serialized).not.toContain(String(config.apiKey));
    }
  });

  it("still returns a usable checkout when the body is unparseable", async () => {
    const { deps } = fakeTransport([{ status: 201, body: "not json" }]);
    const checkout = await createPakasirCheckout(order(), config, deps);
    expect(checkout.status).toBe("pending");
    expect(checkout.providerTransactionId).toBeNull();
    expect(checkout.paymentUrl).toContain("/pay/");
  });

  it("propagates a TimeoutError as upstream_timeout, not internal_error", async () => {
    const { deps } = fakeTransport([
      { throws: new TimeoutError("hard", 5) },
      { throws: new TimeoutError("hard", 5) },
      { throws: new TimeoutError("hard", 5) },
    ]);
    try {
      await createPakasirCheckout(order(), config, deps);
      throw new Error("expected rejection");
    } catch (error) {
      expectBosanda(error, "upstream_timeout");
    }
  });
});

describe("fetchPakasirTransaction", () => {
  it("performs a GET with the order amount and id", async () => {
    const { deps, calls } = fakeTransport([
      { status: 200, body: JSON.stringify({ status: "completed", amount: 9_500 }) },
    ]);
    const transaction = await fetchPakasirTransaction(order(), config, deps);

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("amount=9500");
    expect(calls[0]?.url).toContain("order_id=01JQORDER00000000000000001");
    expect(transaction.status).toBe("paid");
    expect(transaction.amountIdr).toBe(9_500);
  });

  it("maps 404 to not_found without retrying", async () => {
    const { deps, calls } = fakeTransport([{ status: 404, body: "{}" }]);
    try {
      await fetchPakasirTransaction(order(), config, deps);
      throw new Error("expected rejection");
    } catch (error) {
      expectBosanda(error, "not_found");
    }
    expect(calls).toHaveLength(1);
  });

  it("retries a read-only lookup on transport failure", async () => {
    const { deps, calls } = fakeTransport([
      { throws: new Error("ECONNRESET") },
      { status: 200, body: JSON.stringify({ status: "pending" }) },
    ]);
    const transaction = await fetchPakasirTransaction(order(), config, deps);
    expect(calls).toHaveLength(2);
    expect(transaction.status).toBe("pending");
  });
});

describe("parseTransactionPayload", () => {
  it("treats a fractional amount as unverified rather than coercing it", () => {
    const parsed = parseTransactionPayload(
      JSON.stringify({ status: "paid", amount: 9_500.5 }),
      "o1",
    );
    expect(parsed.amountIdr).toBeNull();
  });

  it("treats a numeric string amount as unverified", () => {
    const parsed = parseTransactionPayload(
      JSON.stringify({ status: "paid", amount: "9500" }),
      "o1",
    );
    expect(parsed.amountIdr).toBeNull();
  });

  it("reads a nested transaction envelope", () => {
    const parsed = parseTransactionPayload(
      JSON.stringify({ transaction: { status: "completed", order_id: "o2", amount: 19_000 } }),
      "fallback",
    );
    expect(parsed.orderId).toBe("o2");
    expect(parsed.status).toBe("paid");
    expect(parsed.amountIdr).toBe(19_000);
  });

  it("falls back to the caller's order id when absent", () => {
    const parsed = parseTransactionPayload(JSON.stringify({ status: "paid" }), "fallback-id");
    expect(parsed.orderId).toBe("fallback-id");
  });

  it("rejects a non-JSON and a non-object body", () => {
    expect(() => parseTransactionPayload("<html>", "o1")).toThrow(BosandaError);
    expect(() => parseTransactionPayload("[1,2]", "o1")).toThrow(BosandaError);
  });

  it("ignores an unparseable completed_at", () => {
    const parsed = parseTransactionPayload(
      JSON.stringify({ status: "paid", completed_at: "not-a-date" }),
      "o1",
    );
    expect(parsed.paidAt).toBeNull();
  });
});

describe("normalizePakasirStatus", () => {
  it("maps known vocabulary", () => {
    expect(normalizePakasirStatus("completed")).toBe("paid");
    expect(normalizePakasirStatus("  SETTLED ")).toBe("paid");
    expect(normalizePakasirStatus("failed")).toBe("failed");
    expect(normalizePakasirStatus("expired")).toBe("expired");
    expect(normalizePakasirStatus("canceled")).toBe("cancelled");
  });

  it("maps an unknown word to pending, never to paid", () => {
    expect(normalizePakasirStatus("weird_new_state")).toBe("pending");
    expect(normalizePakasirStatus("")).toBe("pending");
  });
});

describe("redactPakasirUrl", () => {
  it("redacts secret-shaped query parameters", () => {
    const redacted = redactPakasirUrl("https://pakasir.test/x?api_key=abc123&order_id=o1");
    expect(redacted).not.toContain("abc123");
    expect(redacted).toContain("order_id=o1");
  });

  it("returns a placeholder for an unparseable value", () => {
    expect(redactPakasirUrl("::::")).toBe("[unparseable url]");
  });
});
