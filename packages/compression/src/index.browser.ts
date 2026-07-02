import type { ObservabilityDeps } from "@primandproper/observability";

import type { Compressor } from "./compression.js";
import {
  BrowserCompressionConfigSchema,
  type BrowserCompressionConfigInput,
} from "./config.js";
import { NoopCompressor } from "./providers/noop.js";
import { WebStandardCompressor } from "./providers/web-standard.js";

export * from "./compression.js";
export * from "./config.js";

/**
 * Browser default factory: validates config and returns the matching provider. `gzip`/
 * `deflate` use the web-standard `CompressionStream` provider and `none` the identity
 * provider. Brotli is intentionally absent — the browser runtime can't offer it. Same shape
 * as the Node factory, so call-site code is identical across environments.
 */
export function provideCompressor(
  config?: BrowserCompressionConfigInput,
  deps?: ObservabilityDeps,
): Compressor {
  const cfg = BrowserCompressionConfigSchema.parse(config ?? {});
  switch (cfg.algorithm) {
    case "gzip":
    case "deflate":
      return new WebStandardCompressor({ format: cfg.algorithm }, deps);
    case "none":
      return new NoopCompressor();
  }
}
