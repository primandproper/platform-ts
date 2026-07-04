import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { getRequired, type SecretSource } from "../secrets.js";

import {
  NAME_KEY,
  PROJECT_ID_KEY,
  secretInstruments,
  type SecretInstruments,
} from "./support.js";

const sourceName = "gcp_secret_source";
const SECRET_VERSION_LATEST = "latest";
const PROJECTS_PREFIX = "projects/";

/** gRPC status code for NOT_FOUND, the shape the Secret Manager client throws on a missing version. */
const GRPC_NOT_FOUND = 5;

/**
 * Minimal GCP Secret Manager seam — the analogue of Go's `SecretVersionAccessor`. `access`
 * returns `undefined` for a version that does not exist so a miss stays a miss; auth/network
 * failures propagate. Inject a fake in tests; the real adapter wraps the SDK client.
 */
export interface GCPSecretAccessor {
  /** Returns the payload for a fully-qualified resource name, or `undefined` if it is absent. */
  access(resourceName: string): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface GCPSecretSourceOptions {
  /** The GCP project secrets are resolved against. */
  projectID: string;
  /** Inject a client for tests; defaults to a real Secret Manager client (Application Default Credentials). */
  client?: GCPSecretAccessor;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === GRPC_NOT_FOUND
  );
}

/** Wraps the real Secret Manager client, translating NOT_FOUND into a miss. */
class RealGCPAccessor implements GCPSecretAccessor {
  readonly #client = new SecretManagerServiceClient();

  async access(resourceName: string): Promise<string | undefined> {
    try {
      const [response] = await this.#client.accessSecretVersion({ name: resourceName });
      const data = response.payload?.data;
      if (data === undefined || data === null) {
        return undefined;
      }
      return typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  close(): Promise<void> {
    return this.#client.close();
  }
}

/** A {@link SecretSource} backed by GCP Secret Manager. Faithful to Go's `gcp` secret source. */
export class GCPSecretSource implements SecretSource {
  readonly #client: GCPSecretAccessor;
  readonly #projectID: string;
  readonly #observer: Observer;
  readonly #instruments: SecretInstruments;

  constructor(options: GCPSecretSourceOptions, deps: ObservabilityDeps = {}) {
    this.#projectID = options.projectID;
    this.#client = options.client ?? new RealGCPAccessor();
    this.#observer = deps.observer ?? makeObserver(sourceName, deps);
    this.#instruments = secretInstruments(deps, sourceName);
  }

  get(key: string): Promise<string | undefined> {
    return this.#observer.run("get_secret", async (op) => {
      const start = performance.now();
      op.set(NAME_KEY, key).set(PROJECT_ID_KEY, this.#projectID);
      try {
        const value = await this.#client.access(this.#resolveName(key));
        this.#instruments.lookups.add(1);
        return value;
      } catch (err) {
        this.#instruments.errors.add(1);
        throw op.error(err, `accessing secret ${key}`);
      } finally {
        this.#instruments.latency.record(performance.now() - start);
      }
    });
  }

  getRequired(key: string): Promise<string> {
    return getRequired(this, key);
  }

  // Secret Manager exposes no cheap reachability check; a real client is assumed live via ADC.
  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return this.#client.close();
  }

  #resolveName(name: string): string {
    if (name.startsWith(PROJECTS_PREFIX)) {
      return name;
    }
    return `projects/${this.#projectID}/secrets/${name}/versions/${SECRET_VERSION_LATEST}`;
  }
}
