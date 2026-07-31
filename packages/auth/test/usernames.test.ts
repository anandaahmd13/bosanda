import { describe, expect, it } from "vitest";
import { BosandaError } from "@bosanda/protocol";
import {
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  assertUsernameAcceptable,
  isReservedUsername,
  normalizeUsername,
  validateUsername,
} from "../src/usernames.js";

describe("normalizeUsername", () => {
  it("lowercases and trims", () => {
    expect(normalizeUsername("  BudiSantoso  ")).toBe("budisantoso");
  });

  it("applies NFKC, so visually identical names collapse to one", () => {
    // Fullwidth characters would otherwise register as a separate account that
    // looks the same in a support conversation.
    expect(normalizeUsername("ｂｕｄｉ")).toBe("budi");
  });

  it("is idempotent", () => {
    const once = normalizeUsername("Budi_01");
    expect(normalizeUsername(once)).toBe(once);
  });
});

describe("validateUsername", () => {
  it("accepts a simple name", () => {
    expect(validateUsername("budi")).toEqual([]);
  });

  it("accepts digits, underscore, and hyphen", () => {
    expect(validateUsername("budi_santoso-01")).toEqual([]);
  });

  it("accepts a name given in mixed case, since it is normalized first", () => {
    expect(validateUsername("BudiSantoso")).toEqual([]);
  });

  it("rejects a name below the minimum length", () => {
    expect(validateUsername("ab")).toContain(
      `Username must be at least ${MIN_USERNAME_LENGTH} characters.`,
    );
  });

  it("rejects a name above the maximum length", () => {
    expect(validateUsername("a".repeat(MAX_USERNAME_LENGTH + 1))).toContain(
      `Username must be at most ${MAX_USERNAME_LENGTH} characters.`,
    );
  });

  it("accepts exactly the boundary lengths", () => {
    expect(validateUsername("a".repeat(MIN_USERNAME_LENGTH))).toEqual([]);
    expect(validateUsername("a".repeat(MAX_USERNAME_LENGTH))).toEqual([]);
  });

  it("rejects a name starting with underscore or hyphen", () => {
    expect(validateUsername("_budi")).not.toEqual([]);
    expect(validateUsername("-budi")).not.toEqual([]);
  });

  it("rejects spaces and punctuation", () => {
    for (const name of ["budi santoso", "budi.santoso", "budi@example", "budi/../admin"]) {
      expect(validateUsername(name)).not.toEqual([]);
    }
  });

  it("rejects non-ASCII letters", () => {
    // Restricting to ASCII keeps two accounts from being indistinguishable to
    // an admin doing manual recovery.
    expect(validateUsername("budí")).not.toEqual([]);
    expect(validateUsername("буди")).not.toEqual([]);
  });

  it("rejects a zero-width character used to shadow another name", () => {
    expect(validateUsername("bu​di")).not.toEqual([]);
  });

  it("reports every problem at once", () => {
    // So a form can show them all rather than one per submit.
    expect(validateUsername("_").length).toBeGreaterThan(1);
  });

  it("rejects an empty name", () => {
    expect(validateUsername("")).not.toEqual([]);
  });
});

describe("reserved names", () => {
  it.each(["admin", "root", "bosanda", "support", "billing", "security", "api"])(
    "reserves %s",
    (name) => {
      expect(isReservedUsername(name)).toBe(true);
      expect(validateUsername(name)).toContain("That username is reserved.");
    },
  );

  it("reserves regardless of case or padding", () => {
    expect(isReservedUsername("  ADMIN ")).toBe(true);
  });

  it("does not reserve a name that merely contains a reserved word", () => {
    expect(isReservedUsername("adminah")).toBe(false);
    expect(validateUsername("adminah")).toEqual([]);
  });
});

describe("assertUsernameAcceptable", () => {
  it("passes a valid name", () => {
    expect(() => assertUsernameAcceptable("budi")).not.toThrow();
  });

  it("raises invalid_request for a rejected name", () => {
    try {
      assertUsernameAcceptable("!!");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BosandaError);
      expect((error as BosandaError).code).toBe("invalid_request");
    }
  });
});
