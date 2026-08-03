/**
 * Mints the CSRF cookie and owns the Content-Security-Policy.
 *
 * Next 16 renamed the `middleware` file convention to `proxy`; the exported
 * function must be named `proxy` (or be the default export). This always runs on
 * the Node.js runtime, so no route segment config is permitted here.
 *
 * CSP OWNERSHIP (important, and coordinated with deploy/nginx): the admin vhost
 * currently also sends a `Content-Security-Policy` header. `add_header` does not
 * overwrite an upstream header of the same name, so the browser would receive
 * BOTH and enforce their INTERSECTION — which breaks the nonce below. The nginx
 * line must be removed; see the OWNER ACTION item in the report. That file is
 * not mine to edit.
 *
 * The nonce is per-request from a CSPRNG. Next stamps it onto its hydration
 * bootstrap scripts, which is what lets `script-src` stay free of
 * 'unsafe-inline'.
 */

import { NextResponse, type NextRequest } from "next/server";

const CSRF_COOKIE_PROD = "__Host-bosanda_admin_csrf";
const CSRF_COOKIE_DEV = "bosanda_admin_csrf_dev";

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function proxy(request: NextRequest): NextResponse {
  const isProduction = process.env.NODE_ENV === "production";
  const csrfCookie = isProduction ? CSRF_COOKIE_PROD : CSRF_COOKIE_DEV;

  const nonce = randomHex(16);

  // Next reads the nonce out of the incoming CSP header on the request.
  //
  // style-src keeps 'unsafe-inline' because Next injects the critical CSS for
  // `next/font` as an inline <style> that carries no nonce. This is a real
  // weakening, bounded to stylesheets: with object-src/base-uri 'none' and a
  // nonced script-src, inline CSS is not a script-execution vector here.
  const csp = [
    "default-src 'self'",
    // React's development server uses eval to reconstruct server-component
    // callstacks. Keep that exception out of production, where React does not
    // use eval and the CSP should remain strict.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProduction ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);

  // Double-submit CSRF: minted once per browser and reused. HttpOnly, so a
  // cross-site script cannot read it to forge a matching form field.
  if (request.cookies.get(csrfCookie) === undefined) {
    response.cookies.set(csrfCookie, randomHex(32), {
      httpOnly: true,
      secure: isProduction,
      sameSite: "strict",
      path: "/",
    });
  }

  return response;
}

export const config = {
  // Skip static assets: they need no CSRF cookie and no per-request nonce.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
