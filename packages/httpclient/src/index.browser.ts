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
 * Browser default factory: validates config and returns a `fetch`-backed {@link HttpClient}.
 * Identical in shape to the Node factory — the browser's global `fetch` backs the same
 * universal provider, so call-site code is copy-paste portable across environments.
 */
export function provideHttpClient(
  config?: HttpClientConfigInput,
  deps?: ObservabilityDeps,
): HttpClient {
  const cfg = HttpClientConfigSchema.parse(config ?? {});
  return new FetchHttpClient(cfg, deps);
}
