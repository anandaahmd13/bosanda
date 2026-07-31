/**
 * Entrypoint for the G0-G4 evidence harness (PLAN.md §20 M0).
 *
 *   pnpm --filter @bosanda/spike-kiro-direct gate:offline
 *   KIRO_DIRECT_ENABLED=true pnpm --filter @bosanda/spike-kiro-direct gate \
 *     -- --credentials=/root/kiro-test-account.json
 *
 * The credential file must live OUTSIDE the repository. It is plaintext provider
 * material and must never be committed (§16).
 */

import { runHarness } from "./harness.js";

const exitCode = await runHarness(process.argv.slice(2));
process.exit(exitCode);
