import { NextResponse, type NextRequest } from "next/server";
import { CSRF_COOKIE, COOKIE_SECURE } from "./app/lib/env";

/**
 * Per-request CSP nonce + CSRF token minting.
 *
 * CSP: deploy/nginx/sites-available/bosanda.dev.conf documents that Next's App
 * Router emits inline hydration bootstrap scripts, so a nonce-free strict policy
 * breaks hydration, and nginx cannot generate a per-request random value. That
 * makes the app the only place that can own this header. OWNER ACTION, already
 * flagged in that file: delete its `add_header Content-Security-Policy` line,
 * because a browser enforces the INTERSECTION of two CSP headers and the nginx
 * fallback has no nonce.
 *
 * No 'unsafe-inline' for script-src. Next reads the nonce from the incoming
 * request's CSP header and stamps it onto the scripts it generates.
 *
 * 'unsafe-inline' IS present for style-src: Next injects inline <style> for
 * critical CSS and styled-jsx, and there is no nonce mechanism for those. That
 * is a deliberate, documented weakening limited to styles, which cannot execute.
 *
 * CSRF: double-submit. A non-HttpOnly random cookie is minted here when absent;
 * every mutating form embeds the same value and the server action compares them
 * (see app/lib/session.ts). Readable by JS on purpose — that is the mechanism —
 * and useless without the HttpOnly session cookie, which a foreign origin can
 * neither read nor set.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // The gateway origin, so the dashboard may talk to the documented API host.
    "connect-src 'self' https://api.bosanda.dev",
    // §13 hands checkout off to the payment provider via a form POST.
    "form-action 'self' https://pakasir.com",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  // Next reads the nonce back off the request headers it is handed.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");

  if (request.cookies.get(CSRF_COOKIE) === undefined) {
    response.cookies.set({
      name: CSRF_COOKIE,
      value: crypto.randomUUID(),
      // Readable by JS: required for the double-submit pattern.
      httpOnly: false,
      // Lax, not Strict: a Strict cookie is withheld on the top-level
      // cross-site GET back from the payment provider (§13), which would leave
      // the return page unable to render a working form.
      sameSite: "lax",
      secure: COOKIE_SECURE,
      path: "/",
      maxAge: 60 * 60 * 8,
    });
  }

  return response;
}

export const config = {
  // Skip static assets: they need no nonce and no cookie, and running
  // middleware on every chunk request is wasted work.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
