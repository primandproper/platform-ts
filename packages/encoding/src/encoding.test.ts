import { makeRecordingObserver } from "@primandproper/observability";
import { describe, expect, it } from "vitest";

import { JsonCodec } from "./providers/json.js";
import { TomlCodec } from "./providers/toml.js";
import { XmlCodec } from "./providers/xml.js";
import { YamlCodec } from "./providers/yaml.js";

import {
  ContentTypeJSON,
  ContentTypeTOML,
  ContentTypeXML,
  ContentTypeYAML,
  EncodingError,
  RequestBodyTooLargeError,
  UnsupportedContentTypeError,
  contentTypeFromString,
  decode,
  decodeJSON,
  encode,
  encodeJSON,
  provideEncoder,
  provideServerEncoderDecoder,
  type Codec,
} from "./index.js";

const decoder = new TextDecoder();

/**
 * Provider-agnostic conformance suite. Running the same round-trip against every codec proves the
 * `Codec` interface is implementation-independent. Each codec gets a format-appropriate sample:
 * XML is structurally lossy, so its sample is a plain nested element tree of strings.
 */
function conformance(name: string, make: () => Codec, sample: unknown): void {
  describe(name, () => {
    it("round-trips a value", () => {
      const codec = make();
      expect(codec.decode(codec.encode(sample))).toStrictEqual(sample);
    });

    it("encodes to non-empty bytes", () => {
      expect(make().encode(sample).byteLength).toBeGreaterThan(0);
    });
  });
}

const richSample = {
  name: "platform",
  count: 3,
  nested: { enabled: true },
  tags: ["a", "b"],
};
const xmlSample = { note: { to: "Tove", from: "Jani", body: "Reminder" } };

conformance("JsonCodec", () => new JsonCodec(), richSample);
conformance("YamlCodec", () => new YamlCodec(), richSample);
conformance("TomlCodec", () => new TomlCodec(), richSample);
conformance("XmlCodec", () => new XmlCodec(), xmlSample);

describe("JsonCodec", () => {
  it("round-trips arrays and scalars too", () => {
    const codec = new JsonCodec();
    expect(codec.decode(codec.encode([1, 2, 3]))).toStrictEqual([1, 2, 3]);
    expect(codec.decode(codec.encode("scalar"))).toBe("scalar");
  });
});

// ENC-1: the XML parser is lenient; decode must reject non-XML instead of fabricating an object.
describe("XmlCodec malformed input", () => {
  const enc = new TextEncoder();

  it("throws on non-XML instead of returning {}", () => {
    const codec = new XmlCodec();
    expect(() => codec.decode(enc.encode("this is not xml"))).toThrow();
  });

  it("throws on mismatched tags", () => {
    const codec = new XmlCodec();
    expect(() => codec.decode(enc.encode("<a><b></a></b>"))).toThrow();
  });

  it("surfaces as an EncodingError through the manager", () => {
    const encoder = provideEncoder({ contentType: ContentTypeXML });
    expect(() => encoder.decode(enc.encode("this is not xml"))).toThrow(EncodingError);
  });
});

describe("Encoder", () => {
  it("encodes and decodes through the configured content type", () => {
    const enc = provideEncoder({ contentType: ContentTypeYAML });
    expect(enc.contentType).toBe(ContentTypeYAML);
    expect(enc.encodeToString({ a: 1 })).toContain("a: 1");
    expect(enc.decode(enc.encode(richSample))).toStrictEqual(richSample);
    expect(enc.decodeString(enc.encodeToString(richSample))).toStrictEqual(richSample);
  });

  it("defaults to JSON when no content type is configured", () => {
    const enc = provideEncoder();
    expect(enc.contentType).toBe(ContentTypeJSON);
    expect(decoder.decode(enc.encode({ a: 1 }))).toBe('{"a":1}');
  });

  it("throws an EncodingError on malformed input", () => {
    const enc = provideEncoder();
    expect(() => enc.decode(new TextEncoder().encode("{not valid"))).toThrow(
      EncodingError,
    );
  });
});

describe("ServerEncoderDecoder", () => {
  it("decodes a request using its Content-Type header", async () => {
    const sed = provideServerEncoderDecoder();
    const req = new Request("http://example.test/", {
      method: "POST",
      headers: { "content-type": ContentTypeYAML },
      body: "a: 1\nb: two\n",
    });
    expect(await sed.decodeRequest(req)).toStrictEqual({ a: 1, b: "two" });
  });

  it("falls back to JSON when the request has no usable Content-Type", async () => {
    const sed = provideServerEncoderDecoder();
    const req = new Request("http://example.test/", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ x: true }),
    });
    expect(await sed.decodeRequest(req)).toStrictEqual({ x: true });
  });

  it("encodes a Response with status, canonical header, and body", async () => {
    const sed = provideServerEncoderDecoder();
    const res = sed.encodeResponse({ ok: true }, 201, ContentTypeXML);
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe(ContentTypeXML);
    expect(await res.text()).toContain("<ok>true</ok>");
  });

  it("uses the configured type for decodeBytes and encode", () => {
    const sed = provideServerEncoderDecoder({ contentType: ContentTypeYAML });
    expect(decoder.decode(sed.encode({ a: 1 }))).toContain("a: 1");
    expect(sed.decodeBytes(sed.encode({ a: 1 }))).toStrictEqual({ a: 1 });
  });

  it("always encodes JSON via encodeJSON regardless of configured type", () => {
    const sed = provideServerEncoderDecoder({ contentType: ContentTypeYAML });
    expect(decoder.decode(sed.encodeJSON({ a: 1 }))).toBe('{"a":1}');
  });

  it("rejects a request body over maxRequestBytes as it streams (no Content-Length trust)", async () => {
    const sed = provideServerEncoderDecoder({ maxRequestBytes: 8 });
    const req = new Request("http://example.test/", {
      method: "POST",
      headers: { "content-type": ContentTypeJSON },
      body: JSON.stringify({ a: "much longer than eight bytes" }),
    });
    await expect(sed.decodeRequest(req)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("rejects a request whose declared Content-Length exceeds the cap early", async () => {
    const sed = provideServerEncoderDecoder({ maxRequestBytes: 4 });
    const req = new Request("http://example.test/", {
      method: "POST",
      headers: { "content-type": ContentTypeJSON, "content-length": "1000000" },
      body: JSON.stringify({ a: 1 }),
    });
    await expect(sed.decodeRequest(req)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("accepts a body within the cap", async () => {
    const sed = provideServerEncoderDecoder({ maxRequestBytes: 1024 });
    const req = new Request("http://example.test/", {
      method: "POST",
      headers: { "content-type": ContentTypeJSON },
      body: JSON.stringify({ ok: true }),
    });
    expect(await sed.decodeRequest(req)).toStrictEqual({ ok: true });
  });

  it("rejects a content type outside the allow-list", async () => {
    const sed = provideServerEncoderDecoder({
      allowedContentTypes: [ContentTypeJSON],
    });
    const req = new Request("http://example.test/", {
      method: "POST",
      headers: { "content-type": ContentTypeYAML },
      body: "a: 1\n",
    });
    await expect(sed.decodeRequest(req)).rejects.toBeInstanceOf(
      UnsupportedContentTypeError,
    );
  });

  it("allows a permitted content type through the allow-list", async () => {
    const sed = provideServerEncoderDecoder({
      allowedContentTypes: [ContentTypeJSON, ContentTypeYAML],
    });
    const req = new Request("http://example.test/", {
      method: "POST",
      headers: { "content-type": ContentTypeYAML },
      body: "a: 1\n",
    });
    expect(await sed.decodeRequest(req)).toStrictEqual({ a: 1 });
  });
});

describe("observability", () => {
  it("records the content type and payload length", () => {
    const observer = makeRecordingObserver();
    provideEncoder({ contentType: ContentTypeYAML }, { observer }).encode({ a: 1 });
    expect(observer.data().content_type).toBe(ContentTypeYAML);
    expect(observer.observed("length")).toBe(true);
  });

  it("records the error on a failed operation", () => {
    const observer = makeRecordingObserver();
    const enc = provideEncoder({}, { observer });
    expect(() => enc.decode(new TextEncoder().encode("{not valid"))).toThrow(
      EncodingError,
    );
    expect(observer.errors.length).toBeGreaterThan(0);
    expect(observer.errors[0]!.operation).toBe("encoding.decode");
  });
});

describe("package-level helpers", () => {
  it("round-trip via encode/decode and the JSON shortcuts", () => {
    expect(decodeJSON(encodeJSON({ hi: "there" }))).toStrictEqual({ hi: "there" });
    expect(decode(encode({ x: 1 }, ContentTypeYAML), ContentTypeYAML)).toStrictEqual({
      x: 1,
    });
    expect(decode(encode(richSample, ContentTypeTOML), ContentTypeTOML)).toStrictEqual(
      richSample,
    );
  });
});

describe("contentTypeFromString", () => {
  it("normalizes case, trims, and drops charset params", () => {
    expect(contentTypeFromString("APPLICATION/YAML; charset=utf-8")).toBe(
      ContentTypeYAML,
    );
    expect(contentTypeFromString("  application/toml  ")).toBe(ContentTypeTOML);
  });

  it("defaults to JSON for empty, null, or unknown values", () => {
    expect(contentTypeFromString("")).toBe(ContentTypeJSON);
    expect(contentTypeFromString(null)).toBe(ContentTypeJSON);
    expect(contentTypeFromString("text/plain")).toBe(ContentTypeJSON);
  });
});
