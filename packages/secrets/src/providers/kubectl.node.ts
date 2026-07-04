import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { PlatformError } from "@primandproper/errors";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { getRequired, type SecretSource } from "../secrets.js";

import {
  SECRET_DATA_KEY,
  SECRET_NAME_KEY,
  secretInstruments,
  type SecretInstruments,
} from "./support.js";

const sourceName = "kubectl_secret_source";

/**
 * Minimal Kubernetes secrets seam — the analogue of Go's `SecretGetter`. `read` returns the
 * secret's decoded (base64 → utf8) data map, or `undefined` if the secret does not exist so a
 * miss stays a miss; other failures propagate. Inject a fake in tests; the real adapter wraps
 * the SDK client and namespace.
 */
export interface K8sSecretReader {
  read(name: string): Promise<Record<string, string> | undefined>;
}

export interface KubectlSecretSourceOptions {
  /** The namespace secrets are read from. */
  namespace: string;
  /** Path to a kubeconfig; empty uses in-cluster config. Mirrors Go's `kubectl.Config.Kubeconfig`. */
  kubeconfig?: string;
  /** Inject a reader for tests; defaults to a real client built from the kubeconfig or in-cluster config. */
  client?: K8sSecretReader;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const status = err as { code?: unknown; statusCode?: unknown };
  return status.code === 404 || status.statusCode === 404;
}

/** Wraps the real Kubernetes client, translating a 404 into a miss and decoding base64 data. */
class RealK8sReader implements K8sSecretReader {
  readonly #api: CoreV1Api;
  readonly #namespace: string;

  constructor(namespace: string, kubeconfig: string) {
    const kc = new KubeConfig();
    if (kubeconfig === "") {
      kc.loadFromCluster();
    } else {
      kc.loadFromFile(kubeconfig);
    }
    this.#api = kc.makeApiClient(CoreV1Api);
    this.#namespace = namespace;
  }

  async read(name: string): Promise<Record<string, string> | undefined> {
    try {
      const secret = await this.#api.readNamespacedSecret({
        name,
        namespace: this.#namespace,
      });
      const data = secret.data ?? {};
      const decoded: Record<string, string> = {};
      for (const [key, value] of Object.entries(data)) {
        decoded[key] = Buffer.from(value, "base64").toString("utf8");
      }
      return decoded;
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }
}

/**
 * Splits a lookup of the form `secret-name/key` into its parts. An input without a `/` is a
 * caller error, not a miss — it throws, matching Go's `resolveName`.
 */
function resolveName(input: string): { secretName: string; key: string } {
  const slash = input.indexOf("/");
  if (slash === -1) {
    throw new PlatformError(
      "secrets/invalid-key",
      `invalid secret name "${input}": expected format "secret-name/key"`,
    );
  }
  return { secretName: input.slice(0, slash), key: input.slice(slash + 1) };
}

/** A {@link SecretSource} backed by Kubernetes secrets. Faithful to Go's `kubectl` secret source. */
export class KubectlSecretSource implements SecretSource {
  readonly #client: K8sSecretReader;
  readonly #observer: Observer;
  readonly #instruments: SecretInstruments;

  constructor(options: KubectlSecretSourceOptions, deps: ObservabilityDeps = {}) {
    this.#client =
      options.client ?? new RealK8sReader(options.namespace, options.kubeconfig ?? "");
    this.#observer = deps.observer ?? makeObserver(sourceName, deps);
    this.#instruments = secretInstruments(deps, sourceName);
  }

  get(key: string): Promise<string | undefined> {
    return this.#observer.run("get_secret", async (op) => {
      const start = performance.now();
      try {
        const { secretName, key: dataKey } = resolveName(key);
        op.set(SECRET_NAME_KEY, secretName).set(SECRET_DATA_KEY, dataKey);

        const data = await this.#client.read(secretName);
        this.#instruments.lookups.add(1);
        // A missing secret or a missing key within it is a miss, not an error.
        return data?.[dataKey];
      } catch (err) {
        this.#instruments.errors.add(1);
        throw op.error(err, `getting kubernetes secret ${key}`);
      } finally {
        this.#instruments.latency.record(performance.now() - start);
      }
    });
  }

  getRequired(key: string): Promise<string> {
    return getRequired(this, key);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
