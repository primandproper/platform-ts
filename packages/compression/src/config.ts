import { z } from "zod";

/**
 * Node compression config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`.
 * `brotli` is Node-only — the web-standard `CompressionStream` cannot offer it.
 */
export const NodeCompressionConfigSchema = z.object({
  algorithm: z.enum(["gzip", "deflate", "brotli", "none"]).default("gzip"),
});

export type NodeCompressionConfig = z.infer<typeof NodeCompressionConfigSchema>;
export type NodeCompressionConfigInput = z.input<typeof NodeCompressionConfigSchema>;

/**
 * Browser compression config. Same shape as the Node config, minus `brotli` — the browser's
 * `CompressionStream` only supports gzip/deflate.
 */
export const BrowserCompressionConfigSchema = z.object({
  algorithm: z.enum(["gzip", "deflate", "none"]).default("gzip"),
});

export type BrowserCompressionConfig = z.infer<typeof BrowserCompressionConfigSchema>;
export type BrowserCompressionConfigInput = z.input<
  typeof BrowserCompressionConfigSchema
>;
