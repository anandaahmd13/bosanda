/**
 * Persistent "this is not real data" strip.
 *
 * Renders only when `api.ts` is serving fixtures. The whole point is that a
 * screenshot of a fixture render cannot be mistaken for production state, so
 * this is loud, sticky, and never dismissible.
 */

import { apiMode } from "../lib/api";

export function FixtureBanner() {
  if (apiMode() !== "fixtures") return null;
  return (
    <div className="fixture-banner" role="status">
      DEV FIXTURES — every number, key, and order on this page is fake. No gateway is connected.
    </div>
  );
}
