import type { Logger, MeterProvider } from "@primandproper/observability";
import { describe, expect, it } from "vitest";

import { CircuitBreakerConfigSchema } from "./config.js";
import { NoopCircuitBreaker } from "./providers/noop.js";
import { PartitionedCircuitBreaker } from "./providers/partitioned.js";

import { provideCircuitBreaker } from "./index.js";

/** A controllable clock for deterministic state-machine tests. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

interface RecordedMetric {
  name: string;
  value: number;
  attrs: Record<string, unknown> | undefined;
}

/** A meter provider that captures every counter `add` and gauge `record` for assertions. */
function recordingMeter(): {
  provider: MeterProvider;
  counters: RecordedMetric[];
  gauges: RecordedMetric[];
} {
  const counters: RecordedMetric[] = [];
  const gauges: RecordedMetric[] = [];
  const provider = {
    getMeter: () => ({
      createCounter: (name: string) => ({
        add: (value: number, attrs?: Record<string, unknown>) =>
          counters.push({ name, value, attrs }),
      }),
      createGauge: (name: string) => ({
        record: (value: number, attrs?: Record<string, unknown>) =>
          gauges.push({ name, value, attrs }),
      }),
      createUpDownCounter: () => ({ add: () => undefined }),
      createHistogram: () => ({ record: () => undefined }),
    }),
  } as unknown as MeterProvider;
  return { provider, counters, gauges };
}

/** A logger that captures the level and message of every line for assertions. */
function recordingLogger(): {
  logger: Logger;
  lines: { level: string; message: string }[];
} {
  const lines: { level: string; message: string }[] = [];
  const logger: Logger = {
    debug: (message) => lines.push({ level: "debug", message }),
    info: (message) => lines.push({ level: "info", message }),
    warn: (message) => lines.push({ level: "warn", message }),
    error: (whatWasHappening) =>
      lines.push({ level: "error", message: whatWasHappening }),
    with: () => logger,
    child: () => logger,
    withSpan: () => logger,
  };
  return { logger, lines };
}

const config = CircuitBreakerConfigSchema.parse({
  failureThreshold: 3,
  openDurationMs: 1_000,
  halfOpenMaxAttempts: 1,
});

describe("PartitionedCircuitBreaker", () => {
  it("starts closed and lets callers proceed", () => {
    const cb = new PartitionedCircuitBreaker(config);
    expect(cb.canProceed()).toBe(true);
  });

  it("opens after the failure threshold and rejects callers", () => {
    const clock = fakeClock();
    const cb = new PartitionedCircuitBreaker(config, { now: clock.now });

    cb.failed();
    cb.failed();
    expect(cb.canProceed()).toBe(true);

    cb.failed(); // third failure trips it
    expect(cb.canProceed()).toBe(false);
  });

  it("resets the failure count on success while closed", () => {
    const cb = new PartitionedCircuitBreaker(config);
    cb.failed();
    cb.failed();
    cb.succeeded();
    cb.failed();
    cb.failed();
    expect(cb.canProceed()).toBe(true); // count was reset, so only 2 since
  });

  it("stays open until the cooldown elapses, then goes half-open", () => {
    const clock = fakeClock();
    const cb = new PartitionedCircuitBreaker(config, { now: clock.now });

    cb.failed();
    cb.failed();
    cb.failed();
    expect(cb.canProceed()).toBe(false);

    clock.advance(999);
    expect(cb.canProceed()).toBe(false);

    clock.advance(1); // total 1000ms == openDurationMs
    expect(cb.canProceed()).toBe(true); // half-open probe allowed
  });

  it("allows only halfOpenMaxAttempts probes while half-open", () => {
    const clock = fakeClock();
    const cb = new PartitionedCircuitBreaker(config, { now: clock.now });

    cb.failed();
    cb.failed();
    cb.failed();
    clock.advance(1_000);

    expect(cb.canProceed()).toBe(true); // first probe
    expect(cb.canProceed()).toBe(false); // second probe blocked
  });

  it("closes when a half-open probe succeeds", () => {
    const clock = fakeClock();
    const cb = new PartitionedCircuitBreaker(config, { now: clock.now });

    cb.failed();
    cb.failed();
    cb.failed();
    clock.advance(1_000);

    expect(cb.canProceed()).toBe(true);
    cb.succeeded();
    expect(cb.canProceed()).toBe(true); // back to closed, unlimited
    expect(cb.canProceed()).toBe(true);
  });

  it("re-opens when a half-open probe fails", () => {
    const clock = fakeClock();
    const cb = new PartitionedCircuitBreaker(config, { now: clock.now });

    cb.failed();
    cb.failed();
    cb.failed();
    clock.advance(1_000);

    expect(cb.canProceed()).toBe(true); // half-open probe
    cb.failed(); // probe fails -> re-open

    expect(cb.canProceed()).toBe(false);

    clock.advance(999);
    expect(cb.canProceed()).toBe(false); // cooldown restarts from the re-open

    clock.advance(1);
    expect(cb.canProceed()).toBe(true);
  });

  it("forces back open when a half-open probe never resolves (no permanent wedge)", () => {
    const clock = fakeClock();
    const cb = new PartitionedCircuitBreaker(config, { now: clock.now });

    cb.failed();
    cb.failed();
    cb.failed();
    clock.advance(1_000); // cooldown elapsed -> half-open

    expect(cb.canProceed()).toBe(true); // sole probe handed out...
    expect(cb.canProceed()).toBe(false); // ...and never resolved (no succeeded/failed)

    // Before the fix the circuit stayed half-open forever. After a full cooldown with no probe
    // result it forces back open (still rejecting), then mints a fresh probe once the restarted
    // cooldown elapses.
    clock.advance(1_000);
    expect(cb.canProceed()).toBe(false); // stalled -> forced back open, cooldown restarts

    clock.advance(1_000);
    expect(cb.canProceed()).toBe(true); // fresh probe available again
  });

  it("isolates partitions: tripping one key leaves another closed", () => {
    const clock = fakeClock();
    const cb = new PartitionedCircuitBreaker(config, { now: clock.now });
    const a = cb.forPartition("host-a");
    const b = cb.forPartition("host-b");

    a.failed();
    a.failed();
    a.failed();

    expect(a.canProceed()).toBe(false);
    expect(b.canProceed()).toBe(true);
  });

  it("returns the same breaker instance for a repeated partition key", () => {
    const cb = new PartitionedCircuitBreaker(config);
    expect(cb.forPartition("x")).toBe(cb.forPartition("x"));
  });

  it("keeps the default-partition delegation independent from named partitions", () => {
    const cb = new PartitionedCircuitBreaker(config);

    cb.failed(); // default partition
    cb.failed();
    cb.failed();

    expect(cb.canProceed()).toBe(false); // default tripped
    expect(cb.forPartition("other").canProceed()).toBe(true);
  });

  it("counts state transitions and records the state gauge on each change", () => {
    const clock = fakeClock();
    const meter = recordingMeter();
    const cb = new PartitionedCircuitBreaker(config, {
      now: clock.now,
      metrics: meter.provider,
    });

    cb.failed();
    cb.failed();
    cb.failed(); // trips open

    const opened = meter.counters.filter(
      (m) => m.name === "circuitbreaking.transitions" && m.attrs?.to === "open",
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]?.value).toBe(1);
    expect(opened[0]?.attrs?.from).toBe("closed");

    const openGauge = meter.gauges.filter(
      (m) => m.name === "circuitbreaking.state" && m.value === 2,
    );
    expect(openGauge).toHaveLength(1);

    clock.advance(1_000);
    expect(cb.canProceed()).toBe(true); // half-open probe
    cb.succeeded(); // recovers to closed

    const recovered = meter.counters.filter(
      (m) => m.name === "circuitbreaking.transitions" && m.attrs?.to === "closed",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.attrs?.from).toBe("half-open");
    expect(
      meter.gauges.some((m) => m.name === "circuitbreaking.state" && m.value === 0),
    ).toBe(true);
  });

  it("logs recovery to closed at info, not debug, and opening at warn", () => {
    const clock = fakeClock();
    const { logger, lines } = recordingLogger();
    const cb = new PartitionedCircuitBreaker(config, { now: clock.now, logger });

    cb.failed();
    cb.failed();
    cb.failed(); // opens

    clock.advance(1_000);
    expect(cb.canProceed()).toBe(true); // half-open probe
    cb.succeeded(); // recovers to closed

    const opened = lines.find((l) => l.message.includes("opened"));
    expect(opened?.level).toBe("warn");

    const recovered = lines.find((l) => l.message.includes("recovered to closed"));
    expect(recovered?.level).toBe("info");
    expect(lines.some((l) => l.level === "debug")).toBe(false);
  });

  it("counts a rejection each time canProceed denies an attempt", () => {
    const clock = fakeClock();
    const meter = recordingMeter();
    const cb = new PartitionedCircuitBreaker(config, {
      now: clock.now,
      metrics: meter.provider,
    });

    cb.failed();
    cb.failed();
    cb.failed(); // open

    const rejectionsOf = () =>
      meter.counters.filter((m) => m.name === "circuitbreaking.rejections").length;

    expect(cb.canProceed()).toBe(false); // rejected while open
    expect(rejectionsOf()).toBe(1);

    clock.advance(1_000);
    expect(cb.canProceed()).toBe(true); // sole half-open probe (not a rejection)
    expect(rejectionsOf()).toBe(1);

    expect(cb.canProceed()).toBe(false); // probe slot exhausted
    expect(rejectionsOf()).toBe(2);
  });
});

describe("NoopCircuitBreaker", () => {
  it("always allows callers to proceed", () => {
    const cb = new NoopCircuitBreaker();
    cb.failed();
    cb.failed();
    cb.failed();
    cb.failed();
    expect(cb.canProceed()).toBe(true);
  });
});

describe("provideCircuitBreaker", () => {
  it("defaults to a partitioned breaker", () => {
    const cb = provideCircuitBreaker();
    expect(cb).toBeInstanceOf(PartitionedCircuitBreaker);
  });

  it("builds a noop breaker when requested", () => {
    const cb = provideCircuitBreaker({ provider: "noop" });
    expect(cb).toBeInstanceOf(NoopCircuitBreaker);
  });

  it("applies the default failureThreshold of 5", () => {
    const clock = fakeClock();
    const cb = provideCircuitBreaker({ openDurationMs: 1_000 }, { now: clock.now });

    for (let i = 0; i < 4; i += 1) {
      cb.failed();
    }
    expect(cb.canProceed()).toBe(true); // 4 < 5

    cb.failed();
    expect(cb.canProceed()).toBe(false); // 5th trips it
  });
});
