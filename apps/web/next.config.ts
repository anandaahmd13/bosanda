import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Storefront + user dashboard (PLAN.md §4 "Web", §22 domains: bosanda.dev).
 *
 * Deliberately minimal.
 *
 *  - TypeScript errors are NOT ignored: a type error must fail the build.
 *  - Linting is a separate verification step (`pnpm exec eslint apps/web` from
 *    the repo root, against the shared root flat config). Next 16 removed the
 *    `eslint` config key, so there is nothing to opt out of here.
 *  - `outputFileTracingRoot` points at the workspace root because dependencies
 *    are hoisted there. This app intentionally declares no dependencies of its
 *    own so it does not add an importer to the shared pnpm lockfile. Next 16
 *    requires this value to be absolute.
 */
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // nginx is the only thing in front of this app; it does not need to know the
  // framework version, and §16 favours withholding fingerprints.
  poweredByHeader: false,

  outputFileTracingRoot: workspaceRoot,

  typescript: { ignoreBuildErrors: false },

  // No remote images are loaded anywhere in this app; the backdrop is CSS.
  images: { remotePatterns: [] },
};

export default nextConfig;
