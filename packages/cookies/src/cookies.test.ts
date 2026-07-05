import type { Logger, LogValues } from "@primandproper/observability";
import { describe, expect, it } from "vitest";

import { NodeCookieConfigSchema } from "./config.js";
import type { CookieStore } from "./cookies.js";
import { HeaderCookieStore } from "./providers/header.js";
import { NoopCookieStore } from "./providers/noop.js";

/** A logger that records every warn line, returning itself for `with`/`child`/`withSpan`. */
class RecordingLogger implements Logger {
  readonly warns: { message: string; values: LogValues }[] = [];
  debug(): void {}
  info(): void {}
  warn(message: string, values?: LogValues): void {
    this.warns.push({ message, values: values ?? {} });
  }
  error(): void {}
  with(): Logger {
    return this;
  }
  child(): Logger {
    return this;
  }
  withSpan(): Logger {
    return this;
  }
}

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple
 * providers proves the `CookieStore` interface is implementation-independent.
 */
function conformance(
  name: string,
  make: () => CookieStore,
  opts: { readonly persists: boolean },
): void {
  describe(name, () => {
    it("returns undefined for an unset cookie", () => {
      expect(make().get("missing")).toBeUndefined();
    });

    it("reflects a set within the same store", () => {
      const store = make();
      store.set("session", "abc");
      expect(store.get("session")).toBe(opts.persists ? "abc" : undefined);
    });

    it("removes a cookie on delete", () => {
      const store = make();
      store.set("session", "abc");
      store.delete("session");
      expect(store.get("session")).toBeUndefined();
    });

    it("exposes all readable cookies via getAll", () => {
      const store = make();
      store.set("a", "1");
      store.set("b", "2");
      const all = store.getAll();
      expect(all.get("a")).toBe(opts.persists ? "1" : undefined);
      expect(all.get("b")).toBe(opts.persists ? "2" : undefined);
    });
  });
}

conformance("HeaderCookieStore", () => new HeaderCookieStore(), { persists: true });
conformance("NoopCookieStore", () => new NoopCookieStore(), { persists: false });

describe("HeaderCookieStore", () => {
  it("reads cookies from the incoming Cookie header", () => {
    const store = new HeaderCookieStore({ header: "a=1; b=2" });
    expect(store.get("a")).toBe("1");
    expect(store.get("b")).toBe("2");
    expect([...store.getAll()]).toStrictEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("URI-decodes values from the incoming header", () => {
    const store = new HeaderCookieStore({ header: "q=a%20b" });
    expect(store.get("q")).toBe("a b");
  });

  it("accumulates Set-Cookie strings for each set", () => {
    const store = new HeaderCookieStore({
      defaults: { path: "/", sameSite: "lax", secure: true },
    });
    store.set("session", "abc");
    store.set("theme", "dark", { httpOnly: true });
    expect(store.headers()).toStrictEqual([
      "session=abc; Path=/; Secure; SameSite=Lax",
      "theme=dark; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  it("getAll returns a copy that does not mutate the store", () => {
    const store = new HeaderCookieStore({ header: "a=1" });
    store.getAll().set("a", "tampered");
    expect(store.get("a")).toBe("1");
  });

  it("set reflects in subsequent reads within the request", () => {
    const store = new HeaderCookieStore({ header: "a=1" });
    store.set("b", "2");
    expect(store.get("b")).toBe("2");
    expect([...store.getAll()]).toStrictEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("emits an expiring Set-Cookie on delete", () => {
    const store = new HeaderCookieStore({ header: "session=abc" });
    store.delete("session");
    expect(store.get("session")).toBeUndefined();
    expect(store.headers()).toStrictEqual([
      "session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ]);
  });

  it("starts with no pending headers", () => {
    expect(new HeaderCookieStore({ header: "a=1" }).headers()).toStrictEqual([]);
  });

  it("warns (does not throw) when a cookie exceeds the browser size limit", () => {
    const logger = new RecordingLogger();
    const store = new HeaderCookieStore({}, { logger });
    store.set("big", "x".repeat(5000));
    const warn = logger.warns.find((w) => w.message.includes("size limit"));
    expect(warn).toBeDefined();
    expect(warn?.values).toMatchObject({ name: "big" });
    // it is still queued despite being oversized.
    expect(store.headers()).toHaveLength(1);
  });

  it("does not warn for a normally-sized cookie", () => {
    const logger = new RecordingLogger();
    const store = new HeaderCookieStore({}, { logger });
    store.set("small", "value");
    expect(logger.warns.some((w) => w.message.includes("size limit"))).toBe(false);
  });
});

describe("NodeCookieConfigSchema", () => {
  it("defaults server cookies to HttpOnly", () => {
    expect(NodeCookieConfigSchema.parse({}).defaults.httpOnly).toBe(true);
  });

  it("lets a caller opt out of the HttpOnly default", () => {
    expect(
      NodeCookieConfigSchema.parse({ defaults: { httpOnly: false } }).defaults.httpOnly,
    ).toBe(false);
  });
});
