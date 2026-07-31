import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import { fixedClock } from "@bosanda/shared";
import {
  DEFAULT_RESERVATION_MS,
  consumeStock,
  consumesStock,
  freeStock,
  isReservationExpired,
  releaseReservation,
  reserveStock,
  type StockState,
} from "../src/stock.js";
import { NOW, TEN_M, clock, order, packageSnapshot } from "./fixtures.js";

const stock = (overrides: Partial<StockState> = {}): StockState => ({
  weightedTokenQuota: TEN_M,
  available: 5,
  reserved: 0,
  ...overrides,
});

describe("freeStock", () => {
  it("subtracts reservations from the physical count", () => {
    expect(freeStock(stock({ available: 5, reserved: 2 }))).toBe(3);
  });

  it("never reports a negative count", () => {
    expect(freeStock(stock({ available: 1, reserved: 4 }))).toBe(0);
  });
});

describe("consumesStock", () => {
  it("always consumes for a new key", () => {
    expect(consumesStock("new_key")).toBe(true);
    expect(consumesStock("new_key", "exempt")).toBe(true);
  });

  it("follows package policy for a top-up, defaulting to consume", () => {
    expect(consumesStock("top_up")).toBe(true);
    expect(consumesStock("top_up", "consume")).toBe(true);
    expect(consumesStock("top_up", "exempt")).toBe(false);
  });
});

describe("reserveStock", () => {
  it("holds one unit for the configured window", () => {
    const decision = reserveStock(stock(), "new_key", clock);
    expect(decision).toEqual({
      reserved: true,
      units: 1,
      expiresAt: new Date(NOW.getTime() + DEFAULT_RESERVATION_MS),
    });
  });

  it("honours a custom reservation window", () => {
    const decision = reserveStock(stock(), "new_key", clock, { reservationMs: 60_000 });
    expect(decision).toMatchObject({ expiresAt: new Date(NOW.getTime() + 60_000) });
  });

  it("holds nothing for an exempt top-up", () => {
    expect(reserveStock(stock(), "top_up", clock, { policy: "exempt" })).toEqual({
      reserved: true,
      units: 0,
      expiresAt: null,
    });
  });

  it("refuses when every unit is already reserved, as a 409", () => {
    const decision = reserveStock(stock({ available: 2, reserved: 2 }), "new_key", clock);
    expect(decision.reserved).toBe(false);
    if (decision.reserved) return;
    expect(decision.error).toBeInstanceOf(BosandaError);
    expect(decision.error.code).toBe("conflict");
    expect(decision.error.status).toBe(409);
  });

  it("refuses when stock is zero", () => {
    expect(reserveStock(stock({ available: 0 }), "new_key", clock).reserved).toBe(false);
  });

  it("keeps counts out of the client-facing message", () => {
    const decision = reserveStock(stock({ available: 0 }), "new_key", clock);
    if (decision.reserved) return;
    expect(decision.error.publicMessage).toBe(
      "The request conflicts with the current state of the resource.",
    );
    expect(decision.error.internalDetail).toContain("available 0");
  });

  it("reports non-integer counts as internal_error rather than guessing", () => {
    const decision = reserveStock(stock({ available: 1.5 }), "new_key", clock);
    expect(decision.reserved).toBe(false);
    if (decision.reserved) return;
    expect(decision.error.code).toBe("internal_error");
  });

  it("tracks the injected clock", () => {
    const later = fixedClock(new Date(NOW.getTime() + 3_600_000));
    const decision = reserveStock(stock(), "new_key", later);
    expect(decision).toMatchObject({
      expiresAt: new Date(NOW.getTime() + 3_600_000 + DEFAULT_RESERVATION_MS),
    });
  });
});

describe("isReservationExpired", () => {
  it("is true only for a lapsed pending order", () => {
    expect(
      isReservationExpired(
        order({ stockReservationExpiresAt: new Date(NOW.getTime() - 1) }),
        clock,
      ),
    ).toBe(true);
  });

  it("is false for a live reservation", () => {
    expect(isReservationExpired(order(), clock)).toBe(false);
  });

  it("is false when no deadline was recorded", () => {
    expect(isReservationExpired(order({ stockReservationExpiresAt: null }), clock)).toBe(false);
  });

  it("is false once the order left pending_payment", () => {
    for (const status of ["paid", "activated", "cancelled"] as const) {
      expect(
        isReservationExpired(
          order({ status, stockReservationExpiresAt: new Date(NOW.getTime() - 1) }),
          clock,
        ),
      ).toBe(false);
    }
  });

  it("treats the exact deadline as expired", () => {
    expect(isReservationExpired(order({ stockReservationExpiresAt: NOW }), clock)).toBe(true);
  });
});

describe("releaseReservation", () => {
  it("returns one unit of the sold size", () => {
    expect(releaseReservation(order())).toEqual({
      units: 1,
      weightedTokenQuota: TEN_M,
      orderId: "01JQORDER00000000000000001",
    });
  });

  it("uses the frozen snapshot size, not a current package row", () => {
    const release = releaseReservation(
      order({ packageSnapshot: packageSnapshot({ weightedTokenQuota: 70_000_000 }) }),
    );
    expect(release?.weightedTokenQuota).toBe(70_000_000);
  });

  it("returns null for a non-pending order", () => {
    expect(releaseReservation(order({ status: "activated" }))).toBeNull();
    expect(releaseReservation(order({ status: "paid" }))).toBeNull();
  });

  it("returns null for an exempt top-up", () => {
    expect(
      releaseReservation(order({ type: "top_up", targetApiKeyId: "k1" }), { policy: "exempt" }),
    ).toBeNull();
  });
});

describe("consumeStock", () => {
  it("consumes one unit for a new key", () => {
    expect(consumeStock(order(), false)).toEqual({ consume: true, units: 1 });
  });

  it("never decrements twice", () => {
    expect(consumeStock(order(), true)).toEqual({ consume: false, reason: "already_consumed" });
  });

  it("skips an exempt top-up", () => {
    expect(
      consumeStock(order({ type: "top_up", targetApiKeyId: "k1" }), false, { policy: "exempt" }),
    ).toEqual({ consume: false, reason: "exempt" });
  });

  it("consumes for a top-up under the default policy", () => {
    expect(consumeStock(order({ type: "top_up", targetApiKeyId: "k1" }), false)).toEqual({
      consume: true,
      units: 1,
    });
  });
});
