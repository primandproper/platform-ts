import { describe, expect, it } from "vitest";

import { EnvSecretSource } from "./providers/env.js";
import { NoopSecretSource } from "./providers/noop.js";
import { StaticSecretSource } from "./providers/static.js";

import { provideSecrets, MissingSecretError, type SecretSource } from "./index.js";

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple
 * providers proves the `SecretSource` interface is implementation-independent.
 */
function conformance(
  name: string,
  make: () => SecretSource,
  opts: { readonly knowsSecret: boolean },
): void {
  describe(name, () => {
    it("returns undefined for an unknown secret", async () => {
      expect(await make().get("unknown")).toBeUndefined();
    });

    it("reads a known secret", async () => {
      expect(await make().get("known")).toBe(opts.knowsSecret ? "value" : undefined);
    });

    it("throws MissingSecretError from getRequired on a miss", async () => {
      await expect(make().getRequired("unknown")).rejects.toBeInstanceOf(
        MissingSecretError,
      );
    });

    it("pings without throwing", async () => {
      await expect(make().ping()).resolves.toBeUndefined();
    });
  });
}

conformance("EnvSecretSource", () => new EnvSecretSource({ env: { known: "value" } }), {
  knowsSecret: true,
});
conformance(
  "StaticSecretSource",
  () => new StaticSecretSource({ values: { known: "value" } }),
  { knowsSecret: true },
);
conformance("NoopSecretSource", () => new NoopSecretSource(), { knowsSecret: false });

describe("EnvSecretSource prefix", () => {
  it("prepends the prefix before reading", async () => {
    const source = new EnvSecretSource({ prefix: "APP_", env: { APP_TOKEN: "t" } });
    expect(await source.get("TOKEN")).toBe("t");
  });
});

describe("provideSecrets", () => {
  it("defaults to the env provider", async () => {
    const source = provideSecrets(undefined, {});
    expect(source).toBeInstanceOf(EnvSecretSource);
  });

  it("serves a static map", async () => {
    const source = provideSecrets({ provider: "static", static: { values: { a: "1" } } });
    expect(await source.get("a")).toBe("1");
  });

  it("rejects a static provider without config", () => {
    expect(() => provideSecrets({ provider: "static" })).toThrow();
  });
});
