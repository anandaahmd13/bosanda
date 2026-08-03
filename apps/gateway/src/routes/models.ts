/**
 * `GET /v1/models` and `GET /v1/models/:id` (PLAN.md §8 surfaces, §3 kill switches).
 *
 * The catalogue is the one authenticated endpoint that touches neither quota nor a
 * provider, so it is also the cheapest place a client can confirm its key works.
 * It still authenticates: the model list names what a customer may spend money on,
 * and §12's no-oracle rule applies to it exactly as it does to a completion.
 *
 * ── TWO FILTERS, AND WHY BOTH ─────────────────────────────────────────────
 * `listPublished()` reports what the catalogue says; `isModelPubliclyVisible()`
 * applies the runtime switches. §3 requires that disabling the adapter hides its
 * models rather than leaving them listed and failing on use — a client that can see
 * a model will try it, and a 503 on a model the API advertised is a worse experience
 * than the model not being offered while it is down. The database cannot express
 * this because the switches live in env plus `feature_flags`, which is precisely why
 * the repository documents that the CALLER filters.
 *
 * ── WHAT NEVER LEAVES THIS FILE ───────────────────────────────────────────
 * `upstreamId`. The frozen `ProviderModel` contract marks it "never surfaced to
 * clients", and the reason is competitive rather than cryptographic: it names the
 * upstream model behind a Bosanda public id. `toProviderModel` exists so nobody
 * serializes a `ModelRecord` straight to a response, and this file goes through it
 * for both the list and the single-model shape.
 */

import { BosandaError } from "@bosanda/protocol";
import { isModelPubliclyVisible } from "@bosanda/provider-core";
import type { KillSwitches } from "@bosanda/provider-core";
import type { ModelRecord } from "@bosanda/database";
import type { FastifyInstance } from "fastify";
import type { GatewayDeps } from "../dependencies.js";
import { requireAuth } from "./authenticate.js";

/**
 * The public shape of one model.
 *
 * Deliberately NOT the OpenAI `{id, object, created, owned_by}` envelope and not
 * Anthropic's either: §8 defines one Bosanda catalogue shape carrying the fields a
 * client needs to make a routing decision (context window, tool support, price
 * multiplier). Clients that want the OpenAI envelope get it from the OpenAI SDK's
 * own `models.list`, which we do not claim to implement byte-for-byte here.
 */
export type PublicModel = {
  id: string;
  label: string;
  context_window: number;
  supports_tools: boolean;
  supports_reasoning: boolean;
  /** The weighted-token multiplier, as the exact stored decimal (§9). */
  multiplier: string;
  multiplier_version: string;
};

/**
 * Projects a catalogue row for a customer.
 *
 * `multiplier` is the stored STRING, not `multiplierNumeric`: a customer comparing
 * their invoice against the advertised rate must see the same digits the ledger
 * recorded, and a float round-trip through JSON can produce `1.2999999999999998`
 * for a row that says `1.3000`.
 */
export function toPublicModel(record: ModelRecord): PublicModel {
  return {
    id: record.publicId,
    label: record.label,
    context_window: record.contextWindow,
    supports_tools: record.supportsTools,
    supports_reasoning: record.supportsReasoning,
    multiplier: record.multiplier,
    multiplier_version: record.multiplierVersion,
  };
}

/**
 * Applies §3 visibility to a catalogue listing.
 *
 * Exported so the test suite can assert the filter without standing up HTTP, and so
 * the admin catalogue can reuse the same predicate rather than reimplementing it.
 */
export function visibleModels(
  records: readonly ModelRecord[],
  switches: KillSwitches,
): ModelRecord[] {
  return records.filter((record) => isModelPubliclyVisible(switches, record.publicId));
}

export async function registerModelRoutes(app: FastifyInstance, deps: GatewayDeps): Promise<void> {
  app.get("/v1/models", async (request, reply) => {
    // 401 before anything else, so an unauthenticated caller cannot learn the
    // catalogue — this is the assertion `scripts/healthcheck.sh` makes against
    // production, where a 200 here means the auth boundary is broken.
    await requireAuth(request, deps);

    const [records, switches] = await Promise.all([
      deps.models.listPublished(),
      deps.killSwitches(),
    ]);
    const models = visibleModels(records, switches).map(toPublicModel);

    return reply.status(200).send({ object: "list", data: models });
  });

  app.get<{ Params: { id: string } }>("/v1/models/:id", async (request, reply) => {
    await requireAuth(request, deps);

    const [record, switches] = await Promise.all([
      deps.models.findByPublicId(request.params.id),
      deps.killSwitches(),
    ]);

    // Unknown, unpublished, and switched-off all answer identically. A client that
    // could tell them apart could map the unreleased catalogue by probing ids, and
    // §8 gives a customer no legitimate reason to distinguish the three.
    if (
      record === null ||
      !record.published ||
      !isModelPubliclyVisible(switches, record.publicId)
    ) {
      throw new BosandaError("not_found", {
        internalDetail: `model ${request.params.id} is unknown, unpublished, or disabled`,
      });
    }

    return reply.status(200).send(toPublicModel(record));
  });
}
