import { describe, expect, it } from "vitest";

import { EnvSecretSource } from "./providers/env.js";
import { GCPSecretSource, type GCPSecretAccessor } from "./providers/gcp.node.js";
import { KubectlSecretSource, type K8sSecretReader } from "./providers/kubectl.node.js";
import { NoopSecretSource } from "./providers/noop.js";
import { SSMSecretSource, type SSMParameterAccessor } from "./providers/ssm.node.js";
import { StaticSecretSource } from "./providers/static.js";

import { provideSecrets, MissingSecretError, type SecretSource } from "./index.js";

/** A GCP seam fake keyed by the bare secret id extracted from a resolved resource name. */
function gcpFake(values: Record<string, string>): GCPSecretAccessor {
  return {
    access(resourceName) {
      const match = /secrets\/([^/]+)\//.exec(resourceName);
      const id = match?.[1] ?? resourceName;
      return Promise.resolve(values[id]);
    },
    close: () => Promise.resolve(),
  };
}

/** An SSM seam fake keyed by resolved parameter name. */
function ssmFake(values: Record<string, string>): SSMParameterAccessor {
  return { get: (name) => Promise.resolve(values[name]) };
}

/** A Kubernetes seam fake keyed by secret name, returning an already-decoded data map. */
function k8sFake(secrets: Record<string, Record<string, string>>): K8sSecretReader {
  return { read: (name) => Promise.resolve(secrets[name]) };
}

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple providers
 * proves the `SecretSource` interface is implementation-independent. Every provider whose keys
 * are bare (i.e. not the `secret/key` shape kubectl demands) participates.
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

    it("closes without throwing", async () => {
      await expect(make().close()).resolves.toBeUndefined();
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
conformance(
  "GCPSecretSource",
  () => new GCPSecretSource({ projectID: "p", client: gcpFake({ known: "value" }) }),
  { knowsSecret: true },
);
conformance(
  "SSMSecretSource",
  () => new SSMSecretSource({ client: ssmFake({ known: "value" }) }),
  { knowsSecret: true },
);

describe("EnvSecretSource prefix", () => {
  it("prepends the prefix before reading", async () => {
    const source = new EnvSecretSource({ prefix: "APP_", env: { APP_TOKEN: "t" } });
    expect(await source.get("TOKEN")).toBe("t");
  });
});

describe("GCPSecretSource", () => {
  it("resolves a bare key into the latest version resource name", async () => {
    let seen = "";
    const source = new GCPSecretSource({
      projectID: "proj",
      client: {
        access(resourceName) {
          seen = resourceName;
          return Promise.resolve("v");
        },
        close: () => Promise.resolve(),
      },
    });
    await source.get("db-password");
    expect(seen).toBe("projects/proj/secrets/db-password/versions/latest");
  });

  it("passes a fully-qualified resource name through untouched", async () => {
    let seen = "";
    const source = new GCPSecretSource({
      projectID: "proj",
      client: {
        access(resourceName) {
          seen = resourceName;
          return Promise.resolve("v");
        },
        close: () => Promise.resolve(),
      },
    });
    await source.get("projects/other/secrets/x/versions/3");
    expect(seen).toBe("projects/other/secrets/x/versions/3");
  });

  it("propagates a non-not-found error from the client", async () => {
    const source = new GCPSecretSource({
      projectID: "p",
      client: {
        access: () => Promise.reject(new Error("permission denied")),
        close: () => Promise.resolve(),
      },
    });
    await expect(source.get("x")).rejects.toThrow("permission denied");
  });

  it("closes the underlying client", async () => {
    let closed = false;
    const source = new GCPSecretSource({
      projectID: "p",
      client: {
        access: () => Promise.resolve(undefined),
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      },
    });
    await source.close();
    expect(closed).toBe(true);
  });
});

describe("SSMSecretSource", () => {
  it("passes an absolute name through, otherwise prepends the prefix", async () => {
    const seen: string[] = [];
    const client: SSMParameterAccessor = {
      get(name) {
        seen.push(name);
        return Promise.resolve("v");
      },
    };
    const source = new SSMSecretSource({ prefix: "/app/", client });
    await source.get("token");
    await source.get("/absolute/token");
    expect(seen).toEqual(["/app/token", "/absolute/token"]);
  });

  it("propagates a non-not-found error from the client", async () => {
    const source = new SSMSecretSource({
      client: { get: () => Promise.reject(new Error("throttled")) },
    });
    await expect(source.get("x")).rejects.toThrow("throttled");
  });
});

describe("KubectlSecretSource", () => {
  const make = (): KubectlSecretSource =>
    new KubectlSecretSource({
      namespace: "default",
      client: k8sFake({ "app-secrets": { password: "hunter2" } }),
    });

  it("reads a key out of a named secret", async () => {
    expect(await make().get("app-secrets/password")).toBe("hunter2");
  });

  it("returns undefined for a missing key in an existing secret", async () => {
    expect(await make().get("app-secrets/missing")).toBeUndefined();
  });

  it("returns undefined for a missing secret", async () => {
    expect(await make().get("nope/password")).toBeUndefined();
  });

  it("getRequired throws MissingSecretError on a miss", async () => {
    await expect(make().getRequired("app-secrets/missing")).rejects.toBeInstanceOf(
      MissingSecretError,
    );
  });

  it("rejects a name without the secret/key separator", async () => {
    await expect(make().get("no-separator")).rejects.toThrow(/expected format/);
  });

  it("pings and closes without throwing", async () => {
    await expect(make().ping()).resolves.toBeUndefined();
    await expect(make().close()).resolves.toBeUndefined();
  });
});

describe("provideSecrets", () => {
  it("defaults to the env provider", () => {
    expect(provideSecrets(undefined, {})).toBeInstanceOf(EnvSecretSource);
  });

  it("serves a static map", async () => {
    const source = provideSecrets({ provider: "static", static: { values: { a: "1" } } });
    expect(await source.get("a")).toBe("1");
  });

  it("builds a gcp source from config", () => {
    const source = provideSecrets({ provider: "gcp", gcp: { projectID: "p" } });
    expect(source).toBeInstanceOf(GCPSecretSource);
  });

  it("builds an ssm source from config", () => {
    const source = provideSecrets({ provider: "ssm", ssm: { region: "us-east-1" } });
    expect(source).toBeInstanceOf(SSMSecretSource);
  });

  it("rejects a static provider without config", () => {
    expect(() => provideSecrets({ provider: "static" })).toThrow();
  });

  it("rejects a gcp provider without config", () => {
    expect(() => provideSecrets({ provider: "gcp" })).toThrow();
  });

  it("rejects an ssm provider missing its required region", () => {
    // @ts-expect-error region is required by the schema
    expect(() => provideSecrets({ provider: "ssm", ssm: {} })).toThrow();
  });

  it("rejects a kubectl provider without config", () => {
    expect(() => provideSecrets({ provider: "kubectl" })).toThrow();
  });
});
