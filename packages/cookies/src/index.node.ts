import type { ObservabilityDeps } from "@primandproper/observability";

import { NodeCookieConfigSchema, type NodeCookieConfigInput } from "./config.js";
import type { CookieStore } from "./cookies.js";
import { HeaderCookieStore } from "./providers/header.js";
import { NoopCookieStore } from "./providers/noop.js";

export * from "./cookies.js";
export * from "./config.js";
export * from "./serialize.js";
export { HeaderCookieStore } from "./providers/header.js";
export { NoopCookieStore } from "./providers/noop.js";

/**
 * Node default factory: validates config and returns the matching provider. Mirrors the Go
 * platform's `ProvideCookies`. Supports `header` (default; reads a `Cookie:` header, emits
 * `Set-Cookie` strings) and `noop`. Pass the incoming request header via `header`.
 */
export function provideCookieStore(
  config?: NodeCookieConfigInput,
  deps?: ObservabilityDeps,
): CookieStore {
  const cfg = NodeCookieConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "header":
      return new HeaderCookieStore({ header: cfg.header, defaults: cfg.defaults }, deps);
    case "noop":
      return new NoopCookieStore();
  }
}
