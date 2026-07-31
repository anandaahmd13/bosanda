/**
 * Adapter registry (PLAN.md §4 "provider-core", §22 "Future providers").
 *
 * Why this exists: the gateway must resolve "which adapter serves this account"
 * without importing `provider-kiro`. If the gateway imported the concrete
 * package, the dependency arrow would point from the routing layer to a specific
 * upstream, and adding an official provider later would mean editing the
 * gateway. Instead the composition root (apps/gateway/src/main.ts) constructs
 * the adapters and registers them here; everything downstream depends only on
 * the `ProviderAdapter` interface in ./types.ts.
 *
 * The registry is deliberately dumb: no lazy construction, no service locator
 * that resolves by string name. Registration happens once at boot, so a missing
 * adapter is a wiring bug that should surface immediately rather than as a
 * 503 under load.
 */

import { BosandaError } from "@bosanda/protocol";
import type { ProviderAdapter, ProviderType } from "./types.js";

export class AdapterRegistry {
  private readonly adapters = new Map<ProviderType, ProviderAdapter>();

  /**
   * Registers an adapter for its own `providerType`.
   *
   * Throws on a duplicate rather than overwriting: two adapters claiming the
   * same provider type means the composition root is wired twice, and silently
   * keeping the last one would make which adapter is live depend on module
   * evaluation order — the kind of bug that only shows up in production.
   */
  register(adapter: ProviderAdapter): this {
    const existing = this.adapters.get(adapter.providerType);
    if (existing) {
      throw new BosandaError("internal_error", {
        internalDetail:
          `duplicate adapter for provider type "${adapter.providerType}": ` +
          `already registered version ${existing.adapterVersion}, ` +
          `refused version ${adapter.adapterVersion}`,
      });
    }
    this.adapters.set(adapter.providerType, adapter);
    return this;
  }

  has(providerType: ProviderType): boolean {
    return this.adapters.has(providerType);
  }

  tryGet(providerType: ProviderType): ProviderAdapter | undefined {
    return this.adapters.get(providerType);
  }

  /**
   * Resolves an adapter, throwing `internal_error` (500) when absent.
   *
   * 500 rather than 503 is deliberate: an unregistered provider type is a
   * Bosanda deployment fault, not upstream unavailability. Reporting it as 503
   * would make it look like transient provider capacity and hide a broken
   * deploy behind the same alert as a Kiro outage.
   */
  get(providerType: ProviderType): ProviderAdapter {
    const adapter = this.adapters.get(providerType);
    if (!adapter) {
      throw new BosandaError("internal_error", {
        internalDetail: `no adapter registered for provider type "${providerType}"`,
      });
    }
    return adapter;
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  get size(): number {
    return this.adapters.size;
  }
}

export function createAdapterRegistry(adapters: Iterable<ProviderAdapter> = []): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
