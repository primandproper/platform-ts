import { describe, expect, it } from "vitest";

import { parseCookieHeader, serializeCookie } from "./serialize.js";

describe("serializeCookie", () => {
  it("serializes a bare name/value", () => {
    expect(serializeCookie("session", "abc")).toBe("session=abc");
  });

  it("URI-encodes the value", () => {
    expect(serializeCookie("q", "a b&c=d")).toBe("q=a%20b%26c%3Dd");
  });

  it("emits Path", () => {
    expect(serializeCookie("s", "v", { path: "/app" })).toBe("s=v; Path=/app");
  });

  it("emits Domain", () => {
    expect(serializeCookie("s", "v", { domain: "example.com" })).toBe(
      "s=v; Domain=example.com",
    );
  });

  it("emits Max-Age, truncating to an integer", () => {
    expect(serializeCookie("s", "v", { maxAge: 60.9 })).toBe("s=v; Max-Age=60");
  });

  it("emits Max-Age=0", () => {
    expect(serializeCookie("s", "v", { maxAge: 0 })).toBe("s=v; Max-Age=0");
  });

  it("emits Expires as an RFC 1123 date", () => {
    expect(serializeCookie("s", "v", { expires: new Date(0) })).toBe(
      "s=v; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
  });

  it("emits HttpOnly only when true", () => {
    expect(serializeCookie("s", "v", { httpOnly: true })).toBe("s=v; HttpOnly");
    expect(serializeCookie("s", "v", { httpOnly: false })).toBe("s=v");
  });

  it("emits Secure only when true", () => {
    expect(serializeCookie("s", "v", { secure: true })).toBe("s=v; Secure");
    expect(serializeCookie("s", "v", { secure: false })).toBe("s=v");
  });

  it("emits each SameSite value with its canonical label", () => {
    expect(serializeCookie("s", "v", { sameSite: "strict" })).toBe(
      "s=v; SameSite=Strict",
    );
    expect(serializeCookie("s", "v", { sameSite: "lax" })).toBe("s=v; SameSite=Lax");
    expect(serializeCookie("s", "v", { sameSite: "none" })).toBe("s=v; SameSite=None");
  });

  it("serializes all attributes together in canonical order", () => {
    const out = serializeCookie("sid", "x y", {
      maxAge: 3600,
      domain: "example.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
    expect(out).toBe(
      "sid=x%20y; Max-Age=3600; Domain=example.com; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });
});

describe("parseCookieHeader", () => {
  it("returns an empty map for an empty header", () => {
    expect(parseCookieHeader("")).toStrictEqual(new Map());
  });

  it("parses a single cookie", () => {
    expect([...parseCookieHeader("session=abc")]).toStrictEqual([["session", "abc"]]);
  });

  it("parses a multi-cookie header, trimming whitespace", () => {
    expect([...parseCookieHeader("a=1; b=2;c=3")]).toStrictEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
  });

  it("URI-decodes values", () => {
    expect(parseCookieHeader("q=a%20b%26c%3Dd").get("q")).toBe("a b&c=d");
  });

  it("keeps the first occurrence on a repeated name", () => {
    expect(parseCookieHeader("a=1; a=2").get("a")).toBe("1");
  });

  it("skips malformed pairs", () => {
    expect([...parseCookieHeader("a=1; garbage; =novalue; b=2")]).toStrictEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("round-trips a serialized name/value", () => {
    const header = serializeCookie("token", "héllo=&world").split("; ")[0];
    expect(parseCookieHeader(header ?? "").get("token")).toBe("héllo=&world");
  });
});
