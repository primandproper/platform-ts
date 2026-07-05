import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";

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
    const text = bytesToText(data);
    // fast-xml-parser's parser is lenient: non-XML fabricates `{}` and mismatched tags parse
    // "successfully". Validate first so malformed input fails loudly (the manager's `instrument`
    // wraps this into an EncodingError, matching how JsonCodec relies on JSON.parse throwing).
    // XMLValidator carries a @deprecated tag in v5 nudging toward the new `fast-xml-validator`
    // split-out; it remains the in-package validator and works fine (same call as the XMLBuilder
    // note above) — revisit if that package matures.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const validation = XMLValidator.validate(text);
    if (validation !== true) {
      throw new Error(
        `invalid XML: ${validation.err.msg} (line ${String(validation.err.line)})`,
      );
    }
    return this.#parser.parse(text);
  }
}
