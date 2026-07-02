import { describe, expect, it } from "vitest";

import { makeRecordingObserver } from "./recording.js";

describe("RecordingObserver", () => {
  it("records set on the both pillar", () => {
    const obs = makeRecordingObserver();

    obs.begin("doWork").set("user_id", "abc");

    expect(obs.observations).toContainEqual({
      seq: 0,
      operation: "doWork",
      key: "user_id",
      value: "abc",
      pillar: "both",
    });
  });

  it("records spanOnly and logOnly on their respective pillars", () => {
    const obs = makeRecordingObserver();

    const op = obs.begin("doWork");
    op.spanOnly("trace_only", 1);
    op.logOnly("log_only", 2);

    expect(obs.observations.map((o) => [o.key, o.pillar])).toEqual([
      ["trace_only", "span"],
      ["log_only", "log"],
    ]);
  });

  it("fans setValues out to one observation per entry", () => {
    const obs = makeRecordingObserver();

    obs.begin("doWork").setValues({ a: 1, b: true });

    expect(obs.data()).toEqual({ a: 1, b: true });
  });

  it("assigns a globally monotonic seq across operations", () => {
    const obs = makeRecordingObserver();

    obs.begin("first").set("a", 1);
    obs.begin("second").set("b", 2);

    expect(obs.observations.map((o) => o.seq)).toEqual([0, 1]);
    expect(obs.forOperation("second")).toEqual([
      { seq: 1, operation: "second", key: "b", value: 2, pillar: "both" },
    ]);
  });

  it("captures errors routed through error and acknowledge", () => {
    const obs = makeRecordingObserver();
    const boom = new Error("boom");
    const handled = new Error("handled");

    const op = obs.begin("doWork");
    const returned = op.error(boom, "failed");
    op.acknowledge(handled, "recovered");

    expect(returned).toBe(boom);
    expect(obs.errors).toEqual([
      { seq: 0, operation: "doWork", err: boom, description: "failed" },
      { seq: 1, operation: "doWork", err: handled, description: "recovered" },
    ]);
  });

  it("asserts relative key order, ignoring interleaving", () => {
    const obs = makeRecordingObserver();

    const op = obs.begin("doWork");
    op.set("start", 1).set("middle", 2).set("end", 3);

    expect(obs.observedInOrder("start", "end")).toBe(true);
    expect(obs.observedInOrder("end", "start")).toBe(false);
  });

  describe("run", () => {
    it("opens an operation, records through it, and resolves the callback value", async () => {
      const obs = makeRecordingObserver();

      const result = await obs.run("doWork", (op) => {
        op.set("k", "v");
        return 42;
      });

      expect(result).toBe(42);
      expect(obs.observed("k")).toBe(true);
    });

    it("re-throws without swallowing the error", async () => {
      const obs = makeRecordingObserver();
      const boom = new Error("boom");

      await expect(
        obs.run("doWork", () => {
          throw boom;
        }),
      ).rejects.toBe(boom);
    });
  });

  it("reset clears observations, errors, and the seq counter", () => {
    const obs = makeRecordingObserver();
    obs.begin("doWork").set("k", "v");

    obs.reset();
    obs.begin("again").set("k2", "v2");

    expect(obs.observations).toEqual([
      { seq: 0, operation: "again", key: "k2", value: "v2", pillar: "both" },
    ]);
    expect(obs.errors).toHaveLength(0);
  });
});
