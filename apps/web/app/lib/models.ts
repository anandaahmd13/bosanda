/**
 * Model list shown on the public docs page (PLAN.md §9).
 *
 * The authoritative list lives in the database and is served by the gateway at
 * `GET /v1/models`; the docs page fetches it through `api.ts` and falls back to
 * this table only when the gateway is unreachable, so the page still explains
 * the multiplier concept.
 *
 * Multipliers here are ILLUSTRATIVE and labelled as such in the UI. §9 requires
 * multipliers to be admin-managed, versioned, and effective-dated, and §3 says
 * no model may be advertised before it passes the compatibility gate — which
 * per docs/IMPLEMENTATION-STATUS.md has NOT happened yet.
 */

export type DocsModel = {
  publicId: string;
  label: string;
  contextWindow: number;
  multiplier: number;
  supportsTools: boolean;
};

/**
 * Empty on purpose. Advertising specific model IDs and multipliers before the
 * §3 gate produces evidence would be exactly the kind of marketing claim §21
 * forbids. The docs page renders "model list unavailable" and explains why,
 * rather than inventing plausible-looking rows.
 */
export const FALLBACK_MODELS: readonly DocsModel[] = [];
