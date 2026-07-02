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
