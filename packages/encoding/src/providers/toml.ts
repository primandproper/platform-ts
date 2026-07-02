import { parse, stringify } from "smol-toml";

import { bytesToText, textToBytes } from "../bytes.js";
import { ContentTypeTOML, type ContentType } from "../content-type.js";
import type { Codec } from "../encoding.js";

/**
 * TOML codec backed by `smol-toml`. TOML can only represent a table at the top level, so encoding
 * a bare array or scalar throws — the same constraint as Go's TOML encoder.
 */
export class TomlCodec implements Codec {
  readonly contentType: ContentType = ContentTypeTOML;

  encode(value: unknown): Uint8Array {
    return textToBytes(stringify(value as Parameters<typeof stringify>[0]));
  }

  decode(data: Uint8Array): unknown {
    return parse(bytesToText(data));
  }
}
