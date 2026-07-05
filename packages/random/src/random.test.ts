import { describe, expect, it } from "vitest";

import { bytesToBase32, bytesToBase64Url, bytesToHex } from "./encoding.js";
import { provideRandomGenerator } from "./index.node.js";
import { NoopGenerator } from "./providers/noop.js";
import { StandardGenerator } from "./providers/standard.js";
import type { RandomGenerator } from "./random.js";
import { randomElement } from "./slices.js";

const encoder = new TextEncoder();

describe("encoding", () => {
  it("encodes lowercase hex, zero-padded per byte", () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe("000fff");
    expect(bytesToHex(new Uint8Array())).toBe("");
  });

  it("encodes RFC 4648 base32 test vectors with padding", () => {
    expect(bytesToBase32(encoder.encode(""))).toBe("");
    expect(bytesToBase32(encoder.encode("f"))).toBe("MY======");
    expect(bytesToBase32(encoder.encode("fo"))).toBe("MZXQ====");
    expect(bytesToBase32(encoder.encode("foo"))).toBe("MZXW6===");
    expect(bytesToBase32(encoder.encode("foobar"))).toBe("MZXW6YTBOI======");
  });

  it("encodes raw URL-safe base64 without padding", () => {
    // standard base64 of [0xfb, 0xff] is "+/8="; URL-safe + unpadded is "-_8".
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(bytesToBase64Url(new Uint8Array())).toBe("");
  });

  it("encodes a payload larger than the chunk size (PERF-4)", () => {
    // A repeated byte across >0x8000 bytes: base64 of all-zero bytes is all "A"s, unpadded.
    const bytes = new Uint8Array(0x8000 + 30); // 32798 bytes, all 0x00
    const encoded = bytesToBase64Url(bytes);
    // Every char is "A" (0x00 groups), unpadded, and never contains "+/=" or whitespace.
    expect(/^A+$/.test(encoded)).toBe(true);
    expect(encoded.length).toBe(Math.ceil((bytes.length * 8) / 6));
  });
});

/**
 * Provider-agnostic conformance suite: the same assertions run against the standard and noop
 * generators, proving the {@link RandomGenerator} interface is implementation-independent.
 */
function conformance(
  name: string,
  make: () => RandomGenerator,
  opts: { readonly empty: boolean },
): void {
  describe(name, () => {
    it("encodes hex as 2 chars per requested byte", () => {
      expect(make().generateHexEncodedString(16)).toMatch(
        opts.empty ? /^$/ : /^[0-9a-f]{32}$/,
      );
    });

    it("returns the requested number of raw bytes", () => {
      expect(make().generateRawBytes(16).length).toBe(opts.empty ? 0 : 16);
    });

    it("emits base32 and base64 strings", () => {
      const g = make();
      if (opts.empty) {
        expect(g.generateBase32EncodedString(16)).toBe("");
        expect(g.generateBase64EncodedString(16)).toBe("");
      } else {
        expect(g.generateBase32EncodedString(16).length).toBeGreaterThan(0);
        expect(g.generateBase64EncodedString(16).length).toBeGreaterThan(0);
      }
    });
  });
}

conformance("StandardGenerator", () => new StandardGenerator(), { empty: false });
conformance("NoopGenerator", () => new NoopGenerator(), { empty: true });

describe("StandardGenerator", () => {
  it("produces distinct values across calls", () => {
    const g = new StandardGenerator();
    expect(g.generateHexEncodedString(32)).not.toBe(g.generateHexEncodedString(32));
  });

  it("returns empty results for length 0", () => {
    const g = new StandardGenerator();
    expect(g.generateRawBytes(0)).toStrictEqual(new Uint8Array());
    expect(g.generateHexEncodedString(0)).toBe("");
  });

  it("chunks fills larger than the WebCrypto per-call ceiling", () => {
    const g = new StandardGenerator();
    expect(g.generateRawBytes(70000).length).toBe(70000);
  });

  it("rejects negative or non-integer lengths", () => {
    const g = new StandardGenerator();
    expect(() => g.generateRawBytes(-1)).toThrow(RangeError);
    expect(() => g.generateRawBytes(1.5)).toThrow(RangeError);
  });
});

describe("randomElement", () => {
  it("returns undefined for an empty array", () => {
    expect(randomElement<string>([])).toBeUndefined();
  });

  it("only ever returns a member of the input", () => {
    const items = ["a", "b", "c"] as const;
    for (let i = 0; i < 50; i += 1) {
      expect(items).toContain(randomElement(items));
    }
  });
});

describe("provideRandomGenerator", () => {
  it("defaults to the standard provider", () => {
    expect(provideRandomGenerator().generateRawBytes(8).length).toBe(8);
  });

  it("builds a noop provider when configured", () => {
    expect(provideRandomGenerator({ provider: "noop" }).generateRawBytes(8).length).toBe(
      0,
    );
  });
});
