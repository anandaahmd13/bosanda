import { describe, expect, it } from "vitest";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearedCookie,
  csrfCookie,
  csrfTokensMatch,
  generateCsrfToken,
  parseCookies,
  serializeCookie,
  sessionCookie,
} from "../src/cookies.js";

describe("sessionCookie", () => {
  it("is HttpOnly, Secure, SameSite=Lax by default", () => {
    const cookie = sessionCookie("token", 3600);
    expect(cookie).toMatchObject({
      name: SESSION_COOKIE,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
    });
  });

  it("uses Lax rather than Strict, so the payment return navigation keeps the session", () => {
    // Strict would withhold the cookie on the provider's top-level redirect
    // back to us, landing a paying customer on a logged-out page.
    expect(sessionCookie("t", 60).sameSite).toBe("Lax");
  });

  it("allows secure to be disabled only explicitly, for local http", () => {
    expect(sessionCookie("t", 60, { secure: false }).secure).toBe(false);
  });

  it("serializes every security attribute", () => {
    const header = serializeCookie(sessionCookie("abc", 7200));
    expect(header).toContain(`${SESSION_COOKIE}=abc`);
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=7200");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
  });

  it("percent-encodes a value containing a delimiter", () => {
    const header = serializeCookie(sessionCookie("a;b c", 60));
    expect(header).not.toContain("a;b c");
    expect(header).toContain("a%3Bb%20c");
  });
});

describe("csrfCookie", () => {
  it("is readable by client script, because double-submit requires it", () => {
    expect(csrfCookie("t", 60).httpOnly).toBe(false);
  });

  it("is still Secure and SameSite=Lax", () => {
    const cookie = csrfCookie("t", 60);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
  });

  it("omits HttpOnly from the serialized header", () => {
    expect(serializeCookie(csrfCookie("t", 60))).not.toContain("HttpOnly");
  });
});

describe("clearedCookie", () => {
  it("has an empty value and zero age", () => {
    const cookie = clearedCookie(SESSION_COOKIE);
    expect(cookie.value).toBe("");
    expect(cookie.maxAgeSeconds).toBe(0);
  });

  it("also sets a past Expires, for clients that ignore Max-Age", () => {
    const header = serializeCookie(clearedCookie(SESSION_COOKIE));
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Expires=Thu, 01 Jan 1970");
  });

  it("clamps a negative age to zero rather than emitting it", () => {
    const header = serializeCookie({ ...clearedCookie("x"), maxAgeSeconds: -50 });
    expect(header).toContain("Max-Age=0");
  });
});

describe("parseCookies", () => {
  it("parses multiple cookies", () => {
    const jar = parseCookies(`${SESSION_COOKIE}=abc; ${CSRF_COOKIE}=xyz`);
    expect(jar.get(SESSION_COOKIE)).toBe("abc");
    expect(jar.get(CSRF_COOKIE)).toBe("xyz");
  });

  it("returns an empty jar for absent or empty input", () => {
    expect(parseCookies(null).size).toBe(0);
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies("").size).toBe(0);
  });

  it("decodes percent-encoded values", () => {
    expect(parseCookies("a=x%3By").get("a")).toBe("x;y");
  });

  it("keeps the first of a duplicated name, resisting cookie shadowing", () => {
    // A second cookie with the same name is how an attacker on a sibling
    // subdomain tries to override the real value.
    expect(parseCookies("s=real; s=attacker").get("s")).toBe("real");
  });

  it("ignores malformed segments without a name", () => {
    const jar = parseCookies("=novalue; ; valid=1; =x");
    expect(jar.get("valid")).toBe("1");
    expect(jar.size).toBe(1);
  });

  it("keeps a raw value when it is not valid percent-encoding", () => {
    expect(parseCookies("a=100%").get("a")).toBe("100%");
  });

  it("tolerates whitespace around names and values", () => {
    expect(parseCookies("  a = 1 ;  b = 2 ").get("a")).toBe("1");
  });
});

describe("generateCsrfToken", () => {
  it("is url-safe and long", () => {
    const token = generateCsrfToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(generateCsrfToken());
    expect(seen.size).toBe(2000);
  });
});

describe("csrfTokensMatch", () => {
  it("accepts a matching pair", () => {
    const token = generateCsrfToken();
    expect(csrfTokensMatch(token, token)).toBe(true);
  });

  it("rejects a mismatched pair", () => {
    expect(csrfTokensMatch(generateCsrfToken(), generateCsrfToken())).toBe(false);
  });

  it("rejects when both are empty, rather than passing on equality", () => {
    // A request with neither cookie nor field must not satisfy the check.
    expect(csrfTokensMatch("", "")).toBe(false);
  });

  it("rejects null and undefined on either side", () => {
    const token = generateCsrfToken();
    expect(csrfTokensMatch(null, token)).toBe(false);
    expect(csrfTokensMatch(token, null)).toBe(false);
    expect(csrfTokensMatch(undefined, undefined)).toBe(false);
  });

  it("rejects a length mismatch without throwing", () => {
    expect(csrfTokensMatch("abc", "abcd")).toBe(false);
  });

  it("rejects a prefix of the real token", () => {
    const token = generateCsrfToken();
    expect(csrfTokensMatch(token, token.slice(0, -1))).toBe(false);
  });
});
