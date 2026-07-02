import { bytesToText, textToBytes } from "../bytes.js";
import { ContentTypeJSON, type ContentType } from "../content-type.js";
import type { Codec } from "../encoding.js";

/** JSON codec backed by the stdlib `JSON` global. Zero dependencies, fully isomorphic. */
export class JsonCodec implements Codec {
  readonly contentType: ContentType = ContentTypeJSON;

  encode(value: unknown): Uint8Array {
    return textToBytes(JSON.stringify(value));
  }

  decode(data: Uint8Array): unknown {
    return JSON.parse(bytesToText(data));
  }
}
