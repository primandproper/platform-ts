import type { ObservabilityDeps } from "@primandproper/observability";

import type { Compressor } from "./compression.js";
import {
  NodeCompressionConfigSchema,
  type NodeCompressionConfigInput,
} from "./config.js";
import { NoopCompressor } from "./providers/noop.js";
import { WebStandardCompressor } from "./providers/web-standard.js";
import { ZlibCompressor } from "./providers/zlib.node.js";

export * from "./compression.js";
export * from "./config.js";

/**
 * Node default factory: validates config and returns the matching provider. Mirrors the Go
 * platform's `ProvideCompressor`. `gzip`/`deflate` use the web-standard provider, `brotli`
 * the Node-only `node:zlib` provider, and `none` the identity provider.
 */
export function provideCompressor(
  config?: NodeCompressionConfigInput,
  deps?: ObservabilityDeps,
): Compressor {
  const cfg = NodeCompressionConfigSchema.parse(config ?? {});
  switch (cfg.algorithm) {
    case "gzip":
    case "deflate":
      return new WebStandardCompressor({ format: cfg.algorithm }, deps);
    case "brotli":
      return new ZlibCompressor({ algorithm: cfg.algorithm }, deps);
    case "none":
      return new NoopCompressor();
  }
}
