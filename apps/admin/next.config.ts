import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * admin.bosanda.dev (PLAN.md §15, §16).
 *
 * Security headers: deliberately NOT set here. `middleware.ts` owns
 * Content-Security-Policy because a Next App Router page needs a per-request
 * nonce for its hydration bootstrap script, and only the app can generate one.
 * See the OWNER ACTION note in the report: the `add_header
 * Content-Security-Policy` line in deploy/nginx/sites-available/
 * admin.bosanda.dev.conf must be removed, or the browser enforces the
 * INTERSECTION of both policies and blocks the nonced script.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Never advertise the framework on the highest-value host on the box.
  poweredByHeader: false,

  // Operator-specific responses only; nothing here is publicly cacheable and
  // nothing should be indexed. nginx repeats these, harmlessly.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },

  // The admin dashboard renders no remote images and no user-supplied media.
  images: { disableStaticImages: false, remotePatterns: [] },

  // Pin the workspace root. Next walks up looking for a lockfile and finds a
  // stray ~/package-lock.json above the repo, which makes it infer the wrong
  // root and emit a warning. The repo root is the correct answer, and Turbopack
  // requires it as an absolute path.
  turbopack: { root: fileURLToPath(new URL("../..", import.meta.url)) },

  // The local browser may use either loopback spelling. Without this, Next
  // rejects Server Actions submitted from 127.0.0.1 while the page itself loads.
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default nextConfig;
