import {
  GetParameterCommand,
  SSMClient,
  type SSMClientConfig,
} from "@aws-sdk/client-ssm";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { getRequired, type SecretSource } from "../secrets.js";

import { NAME_KEY, secretInstruments, type SecretInstruments } from "./support.js";

const sourceName = "ssm_secret_source";

/**
 * Minimal SSM Parameter Store seam — the analogue of Go's `GetParameterAPI`. `get` returns
 * `undefined` for a parameter that does not exist so a miss stays a miss; other failures
 * propagate. Inject a fake in tests; the real adapter wraps the SDK client.
 */
export interface SSMParameterAccessor {
  get(name: string): Promise<string | undefined>;
  /** Releases the underlying client, if any. */
  close?(): void;
}

export interface SSMSecretSourceOptions {
  region?: string | undefined;
  /** Prepended to every non-absolute parameter name, mirroring Go's `ssm.Config.Prefix`. */
  prefix?: string | undefined;
  /** Override the SSM endpoint — e.g. a LocalStack URL for tests. */
  endpoint?: string | undefined;
  credentials?:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }
    | undefined;
  /** Inject a client for tests; defaults to a real SSM client (default credential chain). */
  client?: SSMParameterAccessor;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ParameterNotFound"
  );
}

/** Wraps the real SSM client, translating ParameterNotFound into a miss. */
class RealSSMAccessor implements SSMParameterAccessor {
  readonly #client: SSMClient;

  constructor(options: SSMSecretSourceOptions) {
    const config: SSMClientConfig = {};
    if (options.region !== undefined) {
      config.region = options.region;
    }
    if (options.endpoint !== undefined) {
      config.endpoint = options.endpoint;
    }
    if (options.credentials !== undefined) {
      const { accessKeyId, secretAccessKey, sessionToken } = options.credentials;
      config.credentials = {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken === undefined ? {} : { sessionToken }),
      };
    }
    this.#client = new SSMClient(config);
  }

  async get(name: string): Promise<string | undefined> {
    try {
      const output = await this.#client.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
      );
      return output.Parameter?.Value ?? undefined;
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  close(): void {
    this.#client.destroy();
  }
}

/** A {@link SecretSource} backed by AWS SSM Parameter Store. Faithful to Go's `ssm` secret source. */
export class SSMSecretSource implements SecretSource {
  readonly #client: SSMParameterAccessor;
  readonly #prefix: string;
  readonly #observer: Observer;
  readonly #instruments: SecretInstruments;

  constructor(options: SSMSecretSourceOptions = {}, deps: ObservabilityDeps = {}) {
    this.#prefix = options.prefix ?? "";
    this.#client = options.client ?? new RealSSMAccessor(options);
    this.#observer = deps.observer ?? makeObserver(sourceName, deps);
    this.#instruments = secretInstruments(deps, sourceName);
  }

  get(key: string): Promise<string | undefined> {
    return this.#observer.run("get_secret", async (op) => {
      const start = performance.now();
      const paramName = this.#resolveName(key);
      op.set(NAME_KEY, paramName);
      try {
        const value = await this.#client.get(paramName);
        this.#instruments.lookups.add(1);
        return value;
      } catch (err) {
        this.#instruments.errors.add(1);
        throw op.error(err, `getting parameter ${key}`);
      } finally {
        this.#instruments.latency.record(performance.now() - start);
      }
    });
  }

  getRequired(key: string): Promise<string> {
    return getRequired(this, key);
  }

  // SSM is a managed service with no connection to probe.
  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#client.close?.();
    return Promise.resolve();
  }

  #resolveName(name: string): string {
    if (name.startsWith("/")) {
      return name;
    }
    return this.#prefix === "" ? name : this.#prefix + name;
  }
}
