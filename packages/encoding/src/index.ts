import type { ObservabilityDeps } from "@primandproper/observability";

import { EncodingConfigSchema, type EncodingConfigInput } from "./config.js";
import {
  ContentTypeJSON,
  DEFAULT_CONTENT_TYPE,
  type ContentType,
} from "./content-type.js";
import {
  buildCodecs,
  DefaultEncoder,
  DefaultServerEncoderDecoder,
  type CodecRegistry,
  type Encoder,
  type ServerEncoderDecoder,
} from "./encoding.js";

export * from "./bytes.js";
export * from "./content-type.js";
export * from "./encoding.js";
export * from "./config.js";

/**
 * Builds an {@link Encoder} for the configured content type. The analogue of platform-go's
 * `ProvideClientEncoder` composed with `ProvideContentType`.
 */
export function provideEncoder(
  config?: EncodingConfigInput,
  deps?: ObservabilityDeps,
): Encoder {
  const cfg = EncodingConfigSchema.parse(config ?? {});
  return new DefaultEncoder(buildCodecs()[cfg.contentType], deps);
}

/**
 * Builds a {@link ServerEncoderDecoder} whose default content type comes from config. The analogue
 * of platform-go's `ProvideServerEncoderDecoder`.
 */
export function provideServerEncoderDecoder(
  config?: EncodingConfigInput,
  deps?: ObservabilityDeps,
): ServerEncoderDecoder {
  const cfg = EncodingConfigSchema.parse(config ?? {});
  return new DefaultServerEncoderDecoder(cfg.contentType, deps, {
    maxRequestBytes: cfg.maxRequestBytes,
    allowedContentTypes: cfg.allowedContentTypes,
  });
}

// Package-level convenience helpers, mirroring platform-go's `utils.go`. They carry no
// observability (a noop logger/tracer) and throw on failure, like Go's `Must*` family. The codec
// registry is built once and shared across calls.
let sharedCodecs: CodecRegistry | undefined;

function helperEncoder(contentType: ContentType): Encoder {
  sharedCodecs ??= buildCodecs();
  return new DefaultEncoder(sharedCodecs[contentType]);
}

/** Encodes a value to bytes using `contentType` (default JSON). Throws on failure. */
export function encode(
  value: unknown,
  contentType: ContentType = DEFAULT_CONTENT_TYPE,
): Uint8Array {
  return helperEncoder(contentType).encode(value);
}

/** Decodes bytes using `contentType` (default JSON). Throws on failure. */
export function decode(
  data: Uint8Array,
  contentType: ContentType = DEFAULT_CONTENT_TYPE,
): unknown {
  return helperEncoder(contentType).decode(data);
}

/** Encodes a value to JSON bytes. Throws on failure. */
export function encodeJSON(value: unknown): Uint8Array {
  return helperEncoder(ContentTypeJSON).encode(value);
}

/** Decodes JSON bytes. Throws on failure. */
export function decodeJSON(data: Uint8Array): unknown {
  return helperEncoder(ContentTypeJSON).decode(data);
}
