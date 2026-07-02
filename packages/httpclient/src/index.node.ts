import type { ObservabilityDeps } from "@primandproper/observability";

import { HttpClientConfigSchema, type HttpClientConfigInput } from "./config.js";
import type { HttpClient } from "./httpclient.js";
import { FetchHttpClient } from "./providers/fetch.js";

export * from "./httpclient.js";
export * from "./config.js";
export {
  FetchHttpClient,
  type FetchHttpClientOptions,
  type FetchLike,
} from "./providers/fetch.js";

/**
 * Node default factory: validates config and returns a `fetch`-backed {@link HttpClient}.
 * Mirrors the Go platform's `ProvideHTTPClient`. `globalThis.fetch` exists on Node 20+, so the
 * client is universal — this factory shares its signature with the browser build, keeping
 * call-site code portable.
 */
export function provideHttpClient(
  config?: HttpClientConfigInput,
  deps?: ObservabilityDeps,
): HttpClient {
  const cfg = HttpClientConfigSchema.parse(config ?? {});
  return new FetchHttpClient(cfg, deps);
}
