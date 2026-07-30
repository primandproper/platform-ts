import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Recorder } from "../recorder.js";
import type { Sink } from "../sink.js";

import { JsonlSink } from "./jsonl.node.js";
import { InMemorySink } from "./memory.js";
import { NoopSink } from "./noop.js";

/**
 * The provider-agnostic {@link Sink} contract, run against every implementation. What is being
 * proved is that the recorder's guarantees are the interface's, not one provider's: whichever
 * sink is configured, a caller sees the same non-blocking, never-throwing capture.
 */
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "eventcapture-conformance-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const providers: { name: string; make: () => Sink }[] = [
  { name: "noop", make: () => new NoopSink() },
  { name: "memory", make: () => new InMemorySink() },
  { name: "jsonl", make: () => new JsonlSink({ path: join(dir, "conformance.jsonl") }) },
];

describe.each(providers)("$name sink", ({ make }) => {
  it("accepts writes, flushes, and closes", async () => {
    const sink = make();
    await sink.write({ hello: "world" });
    await sink.flush();
    await sink.close();
  });

  it("tolerates a flush with nothing pending", async () => {
    const sink = make();
    await sink.flush();
    await sink.flush();
    await sink.close();
  });

  it("tolerates being closed twice", async () => {
    const sink = make();
    await sink.write({ hello: "world" });
    await sink.close();
    await expect(sink.close()).resolves.toBeUndefined();
  });

  it("carries a recorder's full lifecycle without surfacing an error", async () => {
    const recorder = new Recorder<{ n: number }>(make(), { flushIntervalMs: 50 });
    for (let n = 0; n < 10; n++) {
      recorder.record({ n });
    }
    await recorder.flush();
    await expect(recorder.close()).resolves.toBeUndefined();
    expect(recorder.dropped).toBe(0);
  });
});
