import type { ObservabilityDeps } from "@primandproper/observability";

import type { Cache } from "./cache.js";
import { BrowserCacheConfigSchema, type BrowserCacheConfigInput } from "./config.js";
import { InMemoryCache } from "./providers/memory.js";
import { NoopCache } from "./providers/noop.js";
import { WebStorageCache } from "./providers/web.browser.js";

export * from "./cache.js";
export * from "./config.js";

/**
 * Browser default factory: validates config and returns the matching provider. Supports
 * `memory` (default), `web` (localStorage/Web Storage), and `noop`. Same shape as the Node
 * factory, so call-site code is identical across environments.
 */
export function provideCache<T>(
  config?: BrowserCacheConfigInput,
  deps?: ObservabilityDeps,
): Cache<T> {
  const cfg = BrowserCacheConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "memory":
      return new InMemoryCache<T>(
        { expiryMs: cfg.expiryMs, maxEntries: cfg.maxEntries },
        deps,
      );
    case "web":
      return new WebStorageCache<T>(
        { namespace: cfg.namespace, expiryMs: cfg.expiryMs },
        deps,
      );
    case "noop":
      return new NoopCache<T>();
  }
}
