import type { Logger } from "@primandproper/observability";
import { describe, expect, it } from "vitest";

import { MultiSourceReporter, provideMultiSourceAnalytics } from "./index.node.js";

/** A logger that records error lines so the degrade path can be asserted. */
function recordingLogger(): {
  logger: Logger;
  errors: { msg: string; values?: unknown }[];
} {
  const errors: { msg: string; values?: unknown }[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg, _err, values) => errors.push({ msg, values }),
    with: () => logger,
    child: () => logger,
    withSpan: () => logger,
  };
  return { logger, errors };
}

/** A meter provider whose counter records every add(), for asserting the degrade counter. */
function recordingMetrics(): {
  metrics: never;
  adds: { value: number; attrs?: unknown }[];
} {
  const adds: { value: number; attrs?: unknown }[] = [];
  const counter = {
    add: (value: number, attrs?: unknown) => adds.push({ value, attrs }),
  };
  const meter = {
    createCounter: () => counter,
    createUpDownCounter: () => counter,
    createHistogram: () => ({ record: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  return { metrics: { getMeter: () => meter } as unknown as never, adds };
}

describe("provideMultiSourceAnalytics degrade visibility (AN-1)", () => {
  it("logs and counts a source that fails to construct, without failing the build", () => {
    const { logger, errors } = recordingLogger();
    const { metrics, adds } = recordingMetrics();

    const reporter = provideMultiSourceAnalytics(
      {
        good: { provider: "memory" },
        // Missing the required `segment` block: construction throws and must degrade loudly.
        bad: { provider: "segment" },
      },
      { logger, metrics },
    );

    expect(reporter).toBeInstanceOf(MultiSourceReporter);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.values).toStrictEqual({ source: "bad" });
    expect(adds).toStrictEqual([{ value: 1, attrs: { source: "bad" } }]);
  });

  it("stays quiet when every source constructs", () => {
    const { logger, errors } = recordingLogger();
    const { metrics, adds } = recordingMetrics();

    provideMultiSourceAnalytics(
      { a: { provider: "memory" }, b: { provider: "noop" } },
      { logger, metrics },
    );

    expect(errors).toHaveLength(0);
    expect(adds).toHaveLength(0);
  });
});
