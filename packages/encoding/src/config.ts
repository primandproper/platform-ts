import { z } from "zod";

import {
  ContentTypeJSON,
  ContentTypeTOML,
  ContentTypeXML,
  ContentTypeYAML,
} from "./content-type.js";

/**
 * Encoding config. Replaces platform-go's `env:`-tagged struct + ozzo `ValidateWithContext`.
 * `contentType` is the default format for the byte-level encoder and the server encoder/decoder's
 * non-negotiated paths; it defaults to JSON, matching Go's `contentTypeFromString` fallback.
 */
export const EncodingConfigSchema = z.object({
  contentType: z
    .enum([ContentTypeJSON, ContentTypeXML, ContentTypeTOML, ContentTypeYAML])
    .default(ContentTypeJSON),
  /**
   * Maximum accepted request-body size in bytes for the server decoder's `decodeRequest`; `0`
   * disables the cap. Defaults to 1 MiB — a bound on attacker-typed input, not a tuning knob.
   */
  maxRequestBytes: z
    .number()
    .int()
    .nonnegative()
    .default(1024 * 1024),
  /**
   * Content types the server decoder will accept on an incoming request. Omitted allows every
   * supported type; a list restricts which parser the request's `Content-Type` may select.
   */
  allowedContentTypes: z
    .array(z.enum([ContentTypeJSON, ContentTypeXML, ContentTypeTOML, ContentTypeYAML]))
    .optional(),
});

export type EncodingConfig = z.infer<typeof EncodingConfigSchema>;
export type EncodingConfigInput = z.input<typeof EncodingConfigSchema>;
