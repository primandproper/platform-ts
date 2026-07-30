import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provideCaptureSink, provideEventRecorder } from "./index.node.js";
import { JsonlSink } from "./providers/jsonl.node.js";
import { InMemorySink } from "./providers/memory.js";
import { NoopSink } from "./providers/noop.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eventcapture-factory-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("provideCaptureSink", () => {
  it("defaults to the noop sink, so capture can be wired but disabled", () => {
    expect(provideCaptureSink()).toBeInstanceOf(NoopSink);
  });

  it("builds the configured provider", () => {
    expect(provideCaptureSink({ provider: "memory" })).toBeInstanceOf(InMemorySink);
    expect(
      provideCaptureSink({ provider: "jsonl", jsonl: { path: join(dir, "c.jsonl") } }),
    ).toBeInstanceOf(JsonlSink);
  });

  it("rejects a jsonl provider with no jsonl config", () => {
    expect(() => provideCaptureSink({ provider: "jsonl" })).toThrow(
      /jsonl config is required/,
    );
  });
});

describe("provideEventRecorder", () => {
  interface Event {
    route: string;
  }

  it("wires the config knobs into the recorder", async () => {
    const recorder = provideEventRecorder<Event>({ provider: "memory", bufferSize: 1 });
    recorder.record({ route: "/a" });
    recorder.record({ route: "/b" });

    expect(recorder.dropped).toBe(1);
    await recorder.close();
  });

  it("captures through to a JSONL file end to end", async () => {
    const path = join(dir, "capture.jsonl");
    const recorder = provideEventRecorder<Event>(
      { provider: "jsonl", jsonl: { path }, flushIntervalMs: 60_000 },
      undefined,
      { transform: (event) => ({ r: event.route }) },
    );

    recorder.record({ route: "/a" });
    recorder.record({ route: "/b" });
    // Nothing has reached the file yet — the flush tick is a minute out, and close is what
    // guarantees the tail lands.
    await recorder.close();

    expect(await readFile(path, "utf8")).toBe('{"r":"/a"}\n{"r":"/b"}\n');
  });

  it("keeps hooks inferring from the event type without a second type argument", async () => {
    const seen: string[] = [];
    const recorder = provideEventRecorder<Event>({ provider: "memory" }, undefined, {
      observe: (event) => seen.push(event.route),
    });

    recorder.record({ route: "/a" });
    await recorder.close();

    expect(seen).toEqual(["/a"]);
  });
});
