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
});

export type EncodingConfig = z.infer<typeof EncodingConfigSchema>;
export type EncodingConfigInput = z.input<typeof EncodingConfigSchema>;
