import {
  makeMetrics,
  type Metrics,
  type ObservabilityDeps,
} from "@primandproper/observability";

/** The meter every provider registers its instruments under. */
export const o11yName = "secrets";

type Counter = ReturnType<Metrics["counter"]>;
type Histogram = ReturnType<Metrics["histogram"]>;

/**
 * Span/log attribute keys, mirroring the literals each Go secret source observes. Only lookup
 * identifiers are ever attached — a secret's value is never observed.
 */
export const NAME_KEY = "name"; // keys.NameKey — gcp/ssm
export const SECRET_KEY = "secret_key"; // env
export const PROJECT_ID_KEY = "project.id"; // gcp
export const SECRET_NAME_KEY = "secret.name"; // kubectl
export const SECRET_DATA_KEY = "secret.key"; // kubectl

/**
 * The per-source instruments every Go secret source mints in its constructor:
 * `{name}_lookups`, `{name}_errors`, and the `{name}_latency_ms` histogram.
 */
export interface SecretInstruments {
  lookups: Counter;
  errors: Counter;
  latency: Histogram;
}

/** Builds the lookups/errors/latency instruments for a source named `name`. */
export function secretInstruments(
  deps: ObservabilityDeps | undefined,
  name: string,
): SecretInstruments {
  const metrics = makeMetrics(o11yName, deps?.metrics);
  return {
    lookups: metrics.counter(`${name}_lookups`),
    errors: metrics.counter(`${name}_errors`),
    latency: metrics.histogram(`${name}_latency_ms`, { unit: "ms" }),
  };
}
