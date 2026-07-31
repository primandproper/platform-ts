import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  fingerprintJson,
  fingerprintOf,
  fingerprintRequest,
} from "./fingerprint.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively, so property order is not a false mismatch", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("keeps array order, because order is meaning in an array", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("normalises numbers the way JSON does, so a re-serialised payload still matches", () => {
    expect(canonicalJson({ n: 1.0 })).toBe(canonicalJson({ n: 1 }));
    expect(canonicalJson({ n: Number.NaN })).toBe('{"n":null}');
  });

  it("honours toJSON, so a Date canonicalises to its ISO string", () => {
    expect(canonicalJson({ at: new Date(0) })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
  });

  it("drops undefined from objects and nulls it in arrays, as JSON.stringify does", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe("[null]");
  });

  it("renders a bare undefined as null rather than returning undefined", () => {
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("fingerprintOf", () => {
  it("is stable for the same parts", async () => {
    await expect(fingerprintOf(["a", "b"])).resolves.toBe(
      await fingerprintOf(["a", "b"]),
    );
  });

  it("length-prefixes parts, so a shifted boundary is a different fingerprint", async () => {
    // Without framing, "a" + "bc" and "ab" + "c" would hash identically — and one user's
    // recorded response could be replayed to another.
    expect(await fingerprintOf(["a", "bc"])).not.toBe(await fingerprintOf(["ab", "c"]));
  });

  it("accepts raw bytes alongside strings", async () => {
    const digest = await fingerprintOf(["POST", new Uint8Array([1, 2, 3])]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("fingerprintJson", () => {
  it("treats reordered keys as the same request", async () => {
    expect(await fingerprintJson({ a: 1, b: 2 })).toBe(
      await fingerprintJson({ b: 2, a: 1 }),
    );
  });

  it("treats a different value as a different request", async () => {
    expect(await fingerprintJson({ amount: 100 })).not.toBe(
      await fingerprintJson({ amount: 101 }),
    );
  });
});

describe("fingerprintRequest", () => {
  const base = { method: "POST", url: "/charges", principal: "user-1", body: "{}" };

  it("is stable across attempts of the same request", async () => {
    expect(await fingerprintRequest(base)).toBe(await fingerprintRequest(base));
  });

  it("sorts the query, so parameter order is not reported as key reuse", async () => {
    expect(await fingerprintRequest({ ...base, url: "/charges?a=1&b=2" })).toBe(
      await fingerprintRequest({ ...base, url: "/charges?b=2&a=1" }),
    );
  });

  it("commits to the method, path, query, principal, and body", async () => {
    const original = await fingerprintRequest(base);
    expect(await fingerprintRequest({ ...base, method: "PUT" })).not.toBe(original);
    expect(await fingerprintRequest({ ...base, url: "/refunds" })).not.toBe(original);
    expect(await fingerprintRequest({ ...base, url: "/charges?a=1" })).not.toBe(original);
    expect(await fingerprintRequest({ ...base, principal: "user-2" })).not.toBe(original);
    expect(await fingerprintRequest({ ...base, body: '{"a":1}' })).not.toBe(original);
  });

  it("ignores the origin, so the same request through two hosts matches", async () => {
    expect(
      await fingerprintRequest({ ...base, url: "https://api.example.com/charges" }),
    ).toBe(await fingerprintRequest(base));
  });

  it("case-folds the method", async () => {
    expect(await fingerprintRequest({ ...base, method: "post" })).toBe(
      await fingerprintRequest(base),
    );
  });
});
