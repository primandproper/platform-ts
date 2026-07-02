import { urlAlphabet } from "nanoid";
import { describe, expect, it } from "vitest";

import { IdentifierConfigSchema } from "./config.js";

import { provideIdentifierGenerator } from "./index.js";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("provideIdentifierGenerator", () => {
  it("defaults to the nanoid scheme with a 21-char URL-safe ID", () => {
    const gen = provideIdentifierGenerator();
    const allowed = new Set(urlAlphabet);

    const id = gen.generate();
    expect(id).toHaveLength(21);
    for (const ch of id) {
      expect(allowed.has(ch)).toBe(true);
    }
    expect(gen.isValid(id)).toBe(true);
  });

  it("applies a custom nanoid alphabet and size from config", () => {
    const gen = provideIdentifierGenerator({
      scheme: "nanoid",
      alphabet: "xyz",
      size: 6,
    });
    const id = gen.generate();

    expect(/^[xyz]{6}$/.test(id)).toBe(true);
    expect(gen.isValid(id)).toBe(true);
  });

  it("builds a sortable ulid generator when scheme is ulid", () => {
    const gen = provideIdentifierGenerator({ scheme: "ulid" });
    const id = gen.generate();

    expect(ULID_PATTERN.test(id)).toBe(true);
    expect(gen.isValid(id)).toBe(true);
  });

  it("threads injected randomness into the nanoid scheme", () => {
    const randomBytes = (bytes: number) => new Uint8Array(bytes).fill(0);
    const a = provideIdentifierGenerator(
      { scheme: "nanoid", alphabet: "ab", size: 4 },
      { randomBytes },
    );
    const b = provideIdentifierGenerator(
      { scheme: "nanoid", alphabet: "ab", size: 4 },
      { randomBytes },
    );

    expect(a.generate()).toBe(b.generate());
  });

  it("threads injected clock/prng into the ulid scheme", () => {
    const deps = { now: () => 1_700_000_000_000, prng: () => 0 };
    const id = provideIdentifierGenerator({ scheme: "ulid" }, deps).generate();
    // First ID at a frozen time with prng=0 has an all-zero random component.
    expect(id.slice(10)).toBe("0000000000000000");
  });

  it("rejects an unknown scheme via Zod", () => {
    expect(() => provideIdentifierGenerator({ scheme: "xid" as never })).toThrow();
  });

  it("rejects a non-positive nanoid size via Zod", () => {
    expect(() => provideIdentifierGenerator({ size: 0 })).toThrow();
    expect(() => provideIdentifierGenerator({ size: -1 })).toThrow();
  });

  it("rejects an empty alphabet via Zod", () => {
    expect(() => provideIdentifierGenerator({ alphabet: "" })).toThrow();
  });
});

describe("IdentifierConfigSchema", () => {
  it("fills defaults for an empty input", () => {
    const cfg = IdentifierConfigSchema.parse({});
    expect(cfg).toStrictEqual({ scheme: "nanoid", alphabet: urlAlphabet, size: 21 });
  });
});
