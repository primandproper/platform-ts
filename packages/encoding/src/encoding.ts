import { PlatformError } from "@primandproper/errors";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
  type Operation,
} from "@primandproper/observability";

import { arrayBufferBacked, bytesToText, textToBytes } from "./bytes.js";
import {
  ContentTypeHeaderKey,
  ContentTypeJSON,
  ContentTypeTOML,
  ContentTypeXML,
  ContentTypeYAML,
  contentTypeFromString,
  type ContentType,
} from "./content-type.js";
import { JsonCodec } from "./providers/json.js";
import { TomlCodec } from "./providers/toml.js";
import { XmlCodec } from "./providers/xml.js";
import { YamlCodec } from "./providers/yaml.js";

const o11yName = "encoding";

/**
 * A leaf format handler: bytes in, value out and back. Codecs are pure — no observability, no
 * error wrapping — so they compose cleanly into the instrumented {@link Encoder} and
 * {@link ServerEncoderDecoder} below. A raw codec throws whatever its backing library throws.
 */
export interface Codec {
  /** The content type this codec handles. */
  readonly contentType: ContentType;
  /** Serializes a value to bytes. */
  encode(value: unknown): Uint8Array;
  /** Parses bytes back into a value. */
  decode(data: Uint8Array): unknown;
}

/**
 * The byte-level encoder — the analogue of platform-go's `ClientEncoder`. Encodes and decodes
 * against a single, fixed content type. Failures throw an {@link EncodingError}.
 */
export interface Encoder {
  /** The content type this encoder reads and writes. */
  readonly contentType: ContentType;
  /** Serializes a value to bytes. */
  encode(value: unknown): Uint8Array;
  /** Serializes a value to a string. */
  encodeToString(value: unknown): string;
  /** Parses bytes into a value. The caller narrows the `unknown` result. */
  decode(data: Uint8Array): unknown;
  /** Parses a string into a value. The caller narrows the `unknown` result. */
  decodeString(data: string): unknown;
}

/**
 * The HTTP-facing encoder/decoder — the analogue of platform-go's `ServerEncoderDecoder`, on the
 * web-standard Fetch `Request`/`Response` (global on Node 20+ and browsers) rather than Go's
 * `net/http` types. Failures throw an {@link EncodingError}.
 *
 * Content-type selection mirrors platform-go: {@link decodeRequest} reads the *incoming* request's
 * `Content-Type` header; {@link decodeBytes}, {@link encode}, and {@link encodeJSON} use the
 * configured default. {@link encodeResponse} takes the content type explicitly — Fetch builds a
 * fresh `Response`, so there is no pre-set outgoing header for it to read (as Go reads off the
 * `ResponseWriter`).
 */
export interface ServerEncoderDecoder {
  /** Encodes `value` into a `Response` with the given status and content type (default: configured). */
  encodeResponse(value: unknown, status: number, contentType?: ContentType): Response;
  /** Decodes a request body, selecting the format from its `Content-Type` header. */
  decodeRequest(request: Request): Promise<unknown>;
  /** Decodes bytes using the configured content type. */
  decodeBytes(data: Uint8Array): unknown;
  /** Encodes `value` using the configured content type. Throws on failure (Go's `MustEncode`). */
  encode(value: unknown): Uint8Array;
  /** Encodes `value` as JSON regardless of the configured type (Go's `MustEncodeJSON`). */
  encodeJSON(value: unknown): Uint8Array;
}

/** Thrown when a codec fails to encode or decode. Carries the offending content type via `cause`. */
export class EncodingError extends PlatformError {
  constructor(action: "encode" | "decode", contentType: ContentType, cause: unknown) {
    super(
      `encoding/${action}-failed`,
      `${action === "encode" ? "encoding" : "decoding"} ${contentType} content`,
      { cause },
    );
    this.name = "EncodingError";
  }
}

/** Every content type mapped to its codec. Always complete, so lookups never miss. */
export type CodecRegistry = Record<ContentType, Codec>;

/** Builds a fresh registry holding one codec per supported content type. */
export function buildCodecs(): CodecRegistry {
  return {
    [ContentTypeJSON]: new JsonCodec(),
    [ContentTypeYAML]: new YamlCodec(),
    [ContentTypeXML]: new XmlCodec(),
    [ContentTypeTOML]: new TomlCodec(),
  };
}

/**
 * Runs `fn` inside an instrumented operation: opens a span, tags it with the content type, logs
 * and re-throws as an {@link EncodingError} on failure, and always ends the span. The shared
 * spine of every method below.
 */
function instrument<T>(
  observer: Observer,
  action: "encode" | "decode",
  contentType: ContentType,
  fn: (op: Operation) => T,
): T {
  const op = observer.begin(`${o11yName}.${action}`);
  try {
    op.set("content_type", contentType);
    return fn(op);
  } catch (cause) {
    const err = new EncodingError(action, contentType, cause);
    op.error(err, err.message);
    throw err;
  } finally {
    op.end();
  }
}

/** Default {@link Encoder}: a single codec wrapped in observability and error handling. */
export class DefaultEncoder implements Encoder {
  readonly #codec: Codec;
  readonly #observer: Observer;
  readonly contentType: ContentType;

  constructor(codec: Codec, deps: ObservabilityDeps = {}) {
    this.#codec = codec;
    this.contentType = codec.contentType;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
  }

  encode(value: unknown): Uint8Array {
    return instrument(this.#observer, "encode", this.contentType, (op) => {
      const out = this.#codec.encode(value);
      op.set("length", out.byteLength).logger().debug("encoded");
      return out;
    });
  }

  encodeToString(value: unknown): string {
    return bytesToText(this.encode(value));
  }

  decode(data: Uint8Array): unknown {
    return instrument(this.#observer, "decode", this.contentType, (op) => {
      const out = this.#codec.decode(data);
      op.set("length", data.byteLength).logger().debug("decoded");
      return out;
    });
  }

  decodeString(data: string): unknown {
    return this.decode(textToBytes(data));
  }
}

/** Default {@link ServerEncoderDecoder} over Fetch `Request`/`Response`. */
export class DefaultServerEncoderDecoder implements ServerEncoderDecoder {
  readonly #codecs: CodecRegistry;
  readonly #defaultContentType: ContentType;
  readonly #observer: Observer;

  constructor(defaultContentType: ContentType, deps: ObservabilityDeps = {}) {
    this.#codecs = buildCodecs();
    this.#defaultContentType = defaultContentType;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
  }

  encodeResponse(value: unknown, status: number, contentType?: ContentType): Response {
    const ct = contentType ?? this.#defaultContentType;
    const body = instrument(this.#observer, "encode", ct, (op) => {
      const out = this.#codecs[ct].encode(value);
      op.set("length", out.byteLength).set("response.status", status);
      return out;
    });
    return new Response(arrayBufferBacked(body), {
      status,
      headers: { [ContentTypeHeaderKey]: ct },
    });
  }

  async decodeRequest(request: Request): Promise<unknown> {
    const ct = contentTypeFromString(request.headers.get(ContentTypeHeaderKey));
    const data = new Uint8Array(await request.arrayBuffer());
    return instrument(this.#observer, "decode", ct, (op) => {
      op.set("length", data.byteLength);
      return this.#codecs[ct].decode(data);
    });
  }

  decodeBytes(data: Uint8Array): unknown {
    return instrument(this.#observer, "decode", this.#defaultContentType, (op) => {
      op.set("length", data.byteLength);
      return this.#codecs[this.#defaultContentType].decode(data);
    });
  }

  encode(value: unknown): Uint8Array {
    return instrument(this.#observer, "encode", this.#defaultContentType, (op) => {
      const out = this.#codecs[this.#defaultContentType].encode(value);
      op.set("length", out.byteLength);
      return out;
    });
  }

  encodeJSON(value: unknown): Uint8Array {
    return instrument(this.#observer, "encode", ContentTypeJSON, (op) => {
      const out = this.#codecs[ContentTypeJSON].encode(value);
      op.set("length", out.byteLength);
      return out;
    });
  }
}
