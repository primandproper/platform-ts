import {
  makeRecordingObserver,
  type Logger,
  type MeterProvider,
  type ObservabilityDeps,
} from "@primandproper/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Aggregator } from "./aggregator.js";
import { InMemorySink } from "./providers/memory.js";
import { CLOSE_ABORTED_CODE, Recorder, type RecorderOptions } from "./recorder.js";
import type { Sink } from "./sink.js";

interface Event {
  route: string;
  ms: number;
}

/** A MeterProvider that records every counter `add`, so tests can assert the instruments fire. */
function countingMeter(): { deps: ObservabilityDeps; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const meter = {
    createCounter: (name: string) => ({
      add: (value: number) => counts.set(name, (counts.get(name) ?? 0) + value),
    }),
    createHistogram: (name: string) => ({
      record: () => counts.set(name, (counts.get(name) ?? 0) + 1),
    }),
    createUpDownCounter: () => ({ add: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  const provider = { getMeter: () => meter } as unknown as MeterProvider;
  return { deps: { metrics: provider }, counts };
}

interface Line {
  level: string;
  message: string;
  err?: unknown;
}

/**
 * A Logger that keeps every line. `RecordingObserver` reports observations but logs to noop, and
 * what matters here is that a failure nobody can see in a return value is at least written down.
 */
function recordingLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const logger: Logger = {
    debug: (message: string) => void lines.push({ level: "debug", message }),
    info: (message: string) => void lines.push({ level: "info", message }),
    warn: (message: string) => void lines.push({ level: "warn", message }),
    error: (message: string, err?: unknown) =>
      void lines.push({ level: "error", message, err }),
    with: () => logger,
    child: () => logger,
    withSpan: () => logger,
  };
  return { logger, lines };
}

/** A sink whose every call fails, for asserting that failures never reach the caller. */
class FailingSink implements Sink {
  writes = 0;
  async write(): Promise<void> {
    this.writes++;
    throw new Error("sink is on fire");
  }
  async flush(): Promise<void> {
    throw new Error("sink is on fire");
  }
  async close(): Promise<void> {
    throw new Error("sink is on fire");
  }
}

/** A sink whose writes hang until released, for exercising the close deadline. */
class HangingSink implements Sink {
  #release: (() => void) | undefined;
  write(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  release(): void {
    this.#release?.();
  }
}

const closers: (() => Promise<void>)[] = [];

/** Tracks recorders so a failing assertion cannot leave a flush interval running. */
function newRecorder<E>(
  sink: Sink,
  options?: RecorderOptions<E>,
  deps?: ObservabilityDeps,
): Recorder<E> {
  const recorder = new Recorder<E>(sink, options, deps);
  closers.push(() => recorder.close());
  return recorder;
}

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  vi.useRealTimers();
});

describe("Recorder", () => {
  it("drains recorded events to the sink", async () => {
    const sink = new InMemorySink();
    const recorder = newRecorder<Event>(sink);

    recorder.record({ route: "/a", ms: 1 });
    recorder.record({ route: "/b", ms: 2 });
    // Nothing is written synchronously: capture is off the hot path by construction.
    expect(sink.records).toHaveLength(0);
    expect(recorder.buffered).toBe(2);

    await recorder.flush();
    expect(sink.records).toEqual([
      { route: "/a", ms: 1 },
      { route: "/b", ms: 2 },
    ]);
    expect(sink.flushes).toBe(1);
  });

  it("drops and counts events instead of blocking when the buffer is full", async () => {
    const { deps, counts } = countingMeter();
    const sink = new InMemorySink();
    const recorder = newRecorder<Event>(sink, { bufferSize: 2 }, deps);

    for (let i = 0; i < 5; i++) {
      recorder.record({ route: "/a", ms: i });
    }
    expect(recorder.dropped).toBe(3);

    await recorder.flush();
    expect(sink.records).toHaveLength(2);
    expect(counts.get("eventcapture.records.dropped")).toBe(3);
    expect(counts.get("eventcapture.records.written")).toBe(2);
  });

  it("reports only new drops on each flush", async () => {
    const { deps, counts } = countingMeter();
    const recorder = newRecorder<Event>(new InMemorySink(), { bufferSize: 1 }, deps);

    recorder.record({ route: "/a", ms: 0 });
    recorder.record({ route: "/a", ms: 1 });
    await recorder.flush();
    expect(counts.get("eventcapture.records.dropped")).toBe(1);

    await recorder.flush();
    // The high-water mark means a quiet period does not re-report the same drop forever.
    expect(counts.get("eventcapture.records.dropped")).toBe(1);
  });

  it("never surfaces sink failures to the caller, but counts and logs them", async () => {
    const { deps, counts } = countingMeter();
    const { logger, lines } = recordingLogger();
    const recorder = newRecorder<Event>(new FailingSink(), {}, { ...deps, logger });

    expect(() => {
      recorder.record({ route: "/a", ms: 1 });
    }).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();
    await expect(recorder.close()).resolves.toBeUndefined();

    expect(counts.get("eventcapture.sink.errors")).toBe(4);
    expect(counts.get("eventcapture.records.written")).toBeUndefined();
    // The instruments are one half of the only signal capture has broken; the log line naming
    // what failed is the other.
    expect(lines).toContainEqual(
      expect.objectContaining({ level: "error", message: "writing captured event" }),
    );
  });

  it("counts sink failures by stage", async () => {
    const stages: string[] = [];
    const meter = {
      createCounter: (name: string) => ({
        add: (_value: number, attributes?: Record<string, unknown>) => {
          if (name === "eventcapture.sink.errors") {
            stages.push(String(attributes?.stage));
          }
        },
      }),
      createHistogram: () => ({ record: () => undefined }),
      createUpDownCounter: () => ({ add: () => undefined }),
      createGauge: () => ({ record: () => undefined }),
    };
    const deps: ObservabilityDeps = {
      metrics: { getMeter: () => meter } as unknown as MeterProvider,
    };
    const recorder = newRecorder<Event>(new FailingSink(), {}, deps);

    recorder.record({ route: "/a", ms: 1 });
    await recorder.close();

    expect(stages).toEqual(["write", "flush", "close"]);
  });

  it("keeps draining after a sink failure", async () => {
    const sink = new FailingSink();
    const recorder = newRecorder<Event>(sink);

    recorder.record({ route: "/a", ms: 1 });
    await recorder.flush();
    recorder.record({ route: "/b", ms: 2 });
    await recorder.flush();

    expect(sink.writes).toBe(2);
  });

  it("writes the transform's projection instead of the raw event", async () => {
    const sink = new InMemorySink();
    const recorder = newRecorder<Event>(sink, {
      transform: (event) => ({ r: event.route }),
    });

    recorder.record({ route: "/a", ms: 1 });
    await recorder.flush();

    expect(sink.records).toEqual([{ r: "/a" }]);
  });

  it("skips the write when the transform yields nothing", async () => {
    const sink = new InMemorySink();
    const recorder = newRecorder<Event>(sink, {
      transform: (event) => (event.ms > 1 ? event : undefined),
    });

    recorder.record({ route: "/a", ms: 1 });
    recorder.record({ route: "/b", ms: 2 });
    await recorder.flush();

    expect(sink.records).toEqual([{ route: "/b", ms: 2 }]);
  });

  it("runs the observe hook for every event, and survives one that throws", async () => {
    const seen: string[] = [];
    const sink = new InMemorySink();
    const recorder = newRecorder<Event>(sink, {
      observe: (event) => {
        seen.push(event.route);
        if (event.route === "/boom") {
          throw new Error("hook is on fire");
        }
      },
    });

    recorder.record({ route: "/boom", ms: 1 });
    recorder.record({ route: "/a", ms: 2 });
    await recorder.flush();

    expect(seen).toEqual(["/boom", "/a"]);
    expect(sink.records).toHaveLength(2);
  });

  it("writes no raw records when they are turned off, but still observes", async () => {
    const seen: Event[] = [];
    const sink = new InMemorySink();
    const recorder = newRecorder<Event>(sink, {
      rawRecords: false,
      observe: (event) => seen.push(event),
    });

    recorder.record({ route: "/a", ms: 1 });
    await recorder.flush();

    expect(sink.records).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });

  it("writes records emitted by the flush hook", async () => {
    const sink = new InMemorySink();
    const finals: boolean[] = [];
    const recorder = newRecorder<Event>(sink, {
      rawRecords: false,
      now: () => new Date("2026-07-30T12:00:00Z"),
      onFlush: (now, final, emit) => {
        finals.push(final);
        emit({ rollup: now.toISOString(), final });
      },
    });

    await recorder.flush();
    expect(finals).toEqual([false]);

    await recorder.close();
    // The final drain runs the hook once more, with `final` set — a composition's last chance
    // to emit partial buckets before the sink closes.
    expect(finals).toEqual([false, true]);
    expect(sink.records).toEqual([
      { rollup: "2026-07-30T12:00:00.000Z", final: false },
      { rollup: "2026-07-30T12:00:00.000Z", final: true },
    ]);
  });

  it("reports aggregation overflow through the overflow hook", async () => {
    const { deps, counts } = countingMeter();
    let overflow = 7;
    const recorder = newRecorder<Event>(
      new InMemorySink(),
      {
        overflow: () => {
          const taken = overflow;
          overflow = 0;
          return taken;
        },
      },
      deps,
    );

    await recorder.flush();
    expect(counts.get("eventcapture.aggregation.overflow")).toBe(7);

    await recorder.flush();
    expect(counts.get("eventcapture.aggregation.overflow")).toBe(7);
  });

  it("flushes on the configured interval", async () => {
    vi.useFakeTimers();
    const sink = new InMemorySink();
    const recorder = newRecorder<Event>(sink, { flushIntervalMs: 1000 });

    recorder.record({ route: "/a", ms: 1 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(sink.records).toHaveLength(1);
    expect(sink.flushes).toBe(1);
  });

  it("flushes the tail and closes the sink on close", async () => {
    const sink = new InMemorySink();
    const recorder = newRecorder<Event>(sink);

    recorder.record({ route: "/a", ms: 1 });
    await recorder.close();

    expect(sink.records).toHaveLength(1);
    expect(sink.closed).toBe(true);
  });

  it("drops and counts events recorded after close", async () => {
    const sink = new InMemorySink();
    const recorder = newRecorder<Event>(sink);

    await recorder.close();
    recorder.record({ route: "/a", ms: 1 });

    expect(recorder.dropped).toBe(1);
    expect(sink.records).toHaveLength(0);
  });

  it("is safe to close more than once", async () => {
    const sink = new InMemorySink();
    const recorder = newRecorder<Event>(sink);

    await Promise.all([recorder.close(), recorder.close()]);
    await recorder.close();

    // A second close of the InMemorySink would still succeed; what matters is that the sink is
    // closed exactly once and no drain runs twice.
    expect(sink.closed).toBe(true);
    expect(sink.flushes).toBe(1);
  });

  it("rejects with a coded error when close is abandoned mid-drain", async () => {
    const sink = new HangingSink();
    const observer = makeRecordingObserver();
    const recorder = newRecorder<Event>(sink, {}, { observer });
    const controller = new AbortController();

    recorder.record({ route: "/a", ms: 1 });
    const closing = recorder.close(controller.signal);
    controller.abort();

    await expect(closing).rejects.toMatchObject({ code: CLOSE_ABORTED_CODE });
    // Close is the one traced operation in the package precisely so an abandoned drain — which
    // silently loses captured events — shows up in a shutdown trace.
    expect(observer.errors).toContainEqual(
      expect.objectContaining({ description: "draining capture buffer before close" }),
    );
    expect(observer.runs).toContainEqual(
      expect.objectContaining({ operation: "eventcapture.close", outcome: "error" }),
    );
    sink.release();
  });

  it("stops the flush interval on close", async () => {
    vi.useFakeTimers();
    const sink = new InMemorySink();
    const recorder = newRecorder<Event>(sink, { flushIntervalMs: 1000 });

    await recorder.close();
    await vi.advanceTimersByTimeAsync(5000);

    expect(sink.flushes).toBe(1);
  });

  it("composes with an Aggregator to emit rollups instead of raw events", async () => {
    const sink = new InMemorySink();
    const clock = { now: new Date("2026-07-30T12:00:30Z") };
    const aggregator = new Aggregator<string, number>({ bucketMs: 60_000, maxKeys: 2 });
    const recorder = newRecorder<Event>(sink, {
      rawRecords: false,
      now: () => clock.now,
      observe: (event) => {
        aggregator.observe(event.route, clock.now, (current) => (current ?? 0) + 1);
      },
      onFlush: (now, final, emit) => {
        for (const bucket of aggregator.flush(now, final)) {
          emit({
            start: bucket.start.toISOString(),
            key: bucket.key,
            count: bucket.counts,
          });
        }
      },
      overflow: () => aggregator.takeOverflow(),
    });

    recorder.record({ route: "/a", ms: 1 });
    recorder.record({ route: "/a", ms: 2 });
    recorder.record({ route: "/b", ms: 3 });
    recorder.record({ route: "/c", ms: 4 });

    // Mid-window: the bucket has not closed, so nothing is emitted yet.
    await recorder.flush();
    expect(sink.records).toHaveLength(0);

    await recorder.close();
    expect(sink.records).toEqual([
      { start: "2026-07-30T12:00:00.000Z", key: "/a", count: 2 },
      { start: "2026-07-30T12:00:00.000Z", key: "/b", count: 1 },
    ]);
  });
});
