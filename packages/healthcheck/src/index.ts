import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

/**
 * The health of a single component or of the aggregate. `degraded` means functional but
 * impaired — serve traffic, but page someone. Ordered worst-last for aggregation.
 */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** The outcome of one {@link Checker.check}. */
export interface CheckResult {
  status: HealthStatus;
  /** Human-readable context for a healthy or degraded result. */
  detail?: string;
  /** The error message when the check failed; present only on `unhealthy`. */
  error?: string;
  /** Wall-clock duration of the check, measured with `performance.now()`. */
  durationMs: number;
}

/**
 * Probes one component's health. A package's `ping()` is the natural body of a checker — wrap
 * it with {@link checker} rather than implementing this interface by hand.
 */
export interface Checker {
  readonly name: string;
  check(signal?: AbortSignal): Promise<CheckResult>;
}

/** Options for {@link checker}. */
export interface CheckerOptions {
  /** When set, the check is raced against this deadline and reports `unhealthy` on timeout. */
  timeoutMs?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether an error is an abort (a `DOMException`/`Error` named `AbortError`). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Builds a {@link Checker} from a plain async function. The function reports health by what it
 * returns: a resolved `void` is `healthy`, a {@link CheckResult} partial overrides the
 * defaults, and a thrown error becomes `unhealthy` carrying the message. Duration is always
 * measured, and a `timeoutMs` races the function against a deadline.
 */
export function checker(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a void resolve means "healthy".
  fn: (signal?: AbortSignal) => Promise<void | Partial<CheckResult>>,
  opts: CheckerOptions = {},
): Checker {
  return {
    name,
    async check(signal?: AbortSignal): Promise<CheckResult> {
      const start = performance.now();
      const duration = (): number => performance.now() - start;
      try {
        const partial = await runWithTimeout(fn, signal, opts.timeoutMs);
        return { status: "healthy", durationMs: duration(), ...(partial ?? {}) };
      } catch (err) {
        // A caller-initiated cancellation is not a health signal — propagate it rather than
        // reporting the component `unhealthy`. The `timeoutMs` backstop rejects with a plain
        // (non-AbortError) timeout error, so it still surfaces as unhealthy below.
        if (signal?.aborted && isAbortError(err)) {
          throw err;
        }
        return { status: "unhealthy", error: errorMessage(err), durationMs: duration() };
      }
    },
  };
}

async function runWithTimeout(
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- mirrors checker's fn.
  fn: (signal?: AbortSignal) => Promise<void | Partial<CheckResult>>,
  signal?: AbortSignal,
  timeoutMs?: number,
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- mirrors fn's return.
): Promise<void | Partial<CheckResult>> {
  if (timeoutMs === undefined) {
    return fn(signal);
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return Promise.race([
    fn(merged),
    new Promise<never>((_resolve, reject) => {
      timeout.addEventListener(
        "abort",
        () => {
          reject(new Error(`health check timed out after ${String(timeoutMs)}ms`));
        },
        { once: true },
      );
    }),
  ]);
}

/** A {@link Checker} that is always healthy. A useful default or placeholder. */
export function noopChecker(name: string): Checker {
  return checker(name, () => Promise.resolve());
}

/** The aggregate health of every registered {@link Checker}, keyed by checker name. */
export interface HealthReport {
  status: HealthStatus;
  checks: Record<string, CheckResult>;
}

function aggregate(results: readonly CheckResult[]): HealthStatus {
  if (results.some((r) => r.status === "unhealthy")) {
    return "unhealthy";
  }
  if (results.some((r) => r.status === "degraded")) {
    return "degraded";
  }
  return "healthy";
}

const o11yName = "healthcheck";

/** The registry-wide per-check deadline applied when a checker brings no `timeoutMs` of its own. */
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/** Options for {@link HealthRegistry}. */
export interface HealthRegistryOptions {
  /**
   * Registry-wide deadline (ms) applied to *every* check as a backstop, so a checker built without
   * its own `timeoutMs` can't hang the whole report forever. A check that outlives it reports
   * `unhealthy` with a timeout error. Defaults to {@link DEFAULT_CHECK_TIMEOUT_MS}; set `0` to
   * disable (opt back into unbounded checks).
   */
  checkTimeoutMs?: number;
}

/**
 * Collects {@link Checker}s and runs them concurrently into a single {@link HealthReport}.
 * The aggregate is `unhealthy` if any check is, else `degraded` if any is, else `healthy`;
 * an empty registry is `healthy`. Registration is last-wins: re-registering a name replaces
 * the prior checker.
 */
export class HealthRegistry {
  readonly #checkers = new Map<string, Checker>();
  readonly #observer: Observer;
  readonly #logger: Logger;
  readonly #checkTimeoutMs: number | undefined;

  constructor(deps: ObservabilityDeps = {}, options: HealthRegistryOptions = {}) {
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
    const timeout = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.#checkTimeoutMs = timeout > 0 ? timeout : undefined;
  }

  /** Adds a checker, replacing any existing checker of the same name. */
  register(checker: Checker): void {
    this.#checkers.set(checker.name, checker);
  }

  /** The registered checkers, in registration order. */
  checkers(): readonly Checker[] {
    return [...this.#checkers.values()];
  }

  /** Runs every checker concurrently and aggregates the results. */
  async check(signal?: AbortSignal): Promise<HealthReport> {
    const entries = [...this.#checkers.values()];
    this.#logger.debug("running health checks");
    const results = await Promise.all(
      entries.map(async (c) => [c.name, await this.#runChecker(c, signal)] as const),
    );
    const checks: Record<string, CheckResult> = {};
    for (const [name, result] of results) {
      checks[name] = result;
    }
    return { status: aggregate(results.map(([, result]) => result)), checks };
  }

  /**
   * Runs one checker inside its own span, tagging the span/log with the check name and outcome
   * and surfacing a failing component in the logs: `unhealthy` logs at error, `degraded` at
   * warn, healthy stays quiet. An unhealthy result is a value rather than a throw, so it is
   * logged explicitly instead of routed through `op.error`.
   */
  #runChecker(c: Checker, signal?: AbortSignal): Promise<CheckResult> {
    return this.#observer.run("check", async (op) => {
      op.set("check", c.name);
      const result = await this.#raceDeadline(c, signal);
      op.set("status", result.status);
      if (result.status === "unhealthy") {
        op.logger().error(`health check '${c.name}' is unhealthy`, result.error);
      } else if (result.status === "degraded") {
        op.logger().warn(`health check '${c.name}' is degraded`, {
          detail: result.detail,
        });
      }
      return result;
    });
  }

  /**
   * Runs one checker under the registry deadline. A checker with its own (shorter) `timeoutMs`
   * still resolves first; this only backstops one that would otherwise hang the whole report.
   */
  async #raceDeadline(c: Checker, signal?: AbortSignal): Promise<CheckResult> {
    if (this.#checkTimeoutMs === undefined) {
      return c.check(signal);
    }
    const start = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<CheckResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          status: "unhealthy",
          error: `health check '${c.name}' exceeded the registry deadline of ${String(this.#checkTimeoutMs)}ms`,
          durationMs: performance.now() - start,
        });
      }, this.#checkTimeoutMs);
    });
    try {
      return await Promise.race([c.check(signal), deadline]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
