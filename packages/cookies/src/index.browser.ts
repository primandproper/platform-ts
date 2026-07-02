import type { ObservabilityDeps } from "@primandproper/observability";

import { BrowserCookieConfigSchema, type BrowserCookieConfigInput } from "./config.js";
import type { CookieStore } from "./cookies.js";
import { DocumentCookieStore } from "./providers/document.browser.js";
import { NoopCookieStore } from "./providers/noop.js";

export * from "./cookies.js";
export * from "./config.js";
export * from "./serialize.js";
export { DocumentCookieStore } from "./providers/document.browser.js";
export { NoopCookieStore } from "./providers/noop.js";

/**
 * Browser default factory: validates config and returns the matching provider. Supports
 * `document` (default; live `document.cookie`) and `noop`. Same shape as the Node factory,
 * so call-site code is identical across environments.
 */
export function provideCookieStore(
  config?: BrowserCookieConfigInput,
  deps?: ObservabilityDeps,
): CookieStore {
  const cfg = BrowserCookieConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "document":
      return new DocumentCookieStore({ defaults: cfg.defaults }, deps);
    case "noop":
      return new NoopCookieStore();
  }
}
