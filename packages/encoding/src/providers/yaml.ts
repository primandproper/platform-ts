import { parse, stringify } from "yaml";

import { bytesToText, textToBytes } from "../bytes.js";
import { ContentTypeYAML, type ContentType } from "../content-type.js";
import type { Codec } from "../encoding.js";

/** YAML codec backed by the `yaml` package. */
export class YamlCodec implements Codec {
  readonly contentType: ContentType = ContentTypeYAML;

  encode(value: unknown): Uint8Array {
    return textToBytes(stringify(value));
  }

  decode(data: Uint8Array): unknown {
    return parse(bytesToText(data));
  }
}
