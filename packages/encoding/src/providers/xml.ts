import { XMLBuilder, XMLParser } from "fast-xml-parser";

import { bytesToText, textToBytes } from "../bytes.js";
import { ContentTypeXML, type ContentType } from "../content-type.js";
import type { Codec } from "../encoding.js";

/**
 * XML codec backed by `fast-xml-parser`. Note XML is structurally lossy compared to the other
 * formats — attributes, namespaces, and mixed content do not survive an object round-trip
 * cleanly. The builder and parser share matching options so plain nested element trees round-trip.
 */
export class XmlCodec implements Codec {
  // XMLBuilder carries a @deprecated tag in fast-xml-parser v5.9 nudging toward the brand-new
  // `fast-xml-builder` split-out. It remains the in-package builder and works fine; we keep it
  // rather than adopt an unproven dependency. Revisit if fast-xml-builder matures.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  readonly #builder = new XMLBuilder({ ignoreAttributes: true });
  readonly #parser = new XMLParser({ ignoreAttributes: true });
  readonly contentType: ContentType = ContentTypeXML;

  encode(value: unknown): Uint8Array {
    return textToBytes(this.#builder.build(value));
  }

  decode(data: Uint8Array): unknown {
    return this.#parser.parse(bytesToText(data));
  }
}
