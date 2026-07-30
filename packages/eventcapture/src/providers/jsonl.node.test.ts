import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonlSink, SINK_CLOSED_CODE, UNSERIALIZABLE_RECORD_CODE } from "./jsonl.node.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eventcapture-jsonl-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Rotated siblings of the live file, oldest first. */
async function rotated(path: string): Promise<string[]> {
  const names = await readdir(dir);
  const prefix = `${basename(path)}.`;
  return names.filter((name) => name.startsWith(prefix)).sort();
}

describe("JsonlSink", () => {
  it("writes one JSON line per record", async () => {
    const path = join(dir, "capture.jsonl");
    const sink = new JsonlSink({ path });

    await sink.write({ a: 1 });
    await sink.write({ b: [2, 3] });
    await sink.close();

    expect(await readFile(path, "utf8")).toBe('{"a":1}\n{"b":[2,3]}\n');
  });

  it("creates parent directories, but only once something is written", async () => {
    const path = join(dir, "nested", "deeper", "capture.jsonl");
    const sink = new JsonlSink({ path });

    await sink.flush();
    await expect(readdir(dir)).resolves.toEqual([]);

    await sink.write({ a: 1 });
    await sink.close();
    expect(await readFile(path, "utf8")).toBe('{"a":1}\n');
  });

  it("appends to an existing file rather than truncating it", async () => {
    const path = join(dir, "capture.jsonl");
    await writeFile(path, '{"old":true}\n');

    const sink = new JsonlSink({ path });
    await sink.write({ new: true });
    await sink.close();

    expect(await readFile(path, "utf8")).toBe('{"old":true}\n{"new":true}\n');
  });

  it("refuses records after close", async () => {
    const sink = new JsonlSink({ path: join(dir, "capture.jsonl") });
    await sink.close();

    await expect(sink.write({ a: 1 })).rejects.toMatchObject({ code: SINK_CLOSED_CODE });
  });

  it("reports a record with no JSON representation", async () => {
    const sink = new JsonlSink({ path: join(dir, "capture.jsonl") });

    await expect(sink.write(undefined)).rejects.toMatchObject({
      code: UNSERIALIZABLE_RECORD_CODE,
    });
    // A circular record is the sink's problem to report, not the recorder's to crash on.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(sink.write(circular)).rejects.toThrow(/marshaling record/);

    await sink.close();
  });

  it("rotates the live file once it passes maxBytes", async () => {
    const path = join(dir, "capture.jsonl");
    const sink = new JsonlSink({ path, maxBytes: 40, maxFiles: 8 });

    for (let i = 0; i < 6; i++) {
      await sink.write({ i });
      await sink.flush();
    }
    await sink.close();

    const siblings = await rotated(path);
    expect(siblings.length).toBeGreaterThan(0);
    // Every record survives the rotation — they are spread across the live file and its
    // siblings, never dropped.
    const contents = await Promise.all(
      [path, ...siblings.map((name) => join(dir, name))].map((p) => readFile(p, "utf8")),
    );
    const lines = contents.join("").trim().split("\n").sort();
    expect(lines).toEqual([0, 1, 2, 3, 4, 5].map((i) => JSON.stringify({ i })).sort());
  });

  it("prunes the oldest rotated files beyond maxFiles", async () => {
    const path = join(dir, "capture.jsonl");
    let tick = 0;
    const sink = new JsonlSink({ path, maxBytes: 10, maxFiles: 2 }, undefined, {
      // A stamp per rotation, so the fixed-width names sort chronologically without relying on
      // the wall clock ticking between two rotations in the same millisecond.
      now: () => new Date(Date.UTC(2026, 6, 30, 12, 0, tick++)),
    });

    for (let i = 0; i < 6; i++) {
      await sink.write({ i });
      await sink.flush();
    }
    await sink.close();

    const siblings = await rotated(path);
    expect(siblings).toHaveLength(2);
    // The survivors are the newest two: pruning takes from the front of the lexical order.
    expect(siblings[0]).toContain("20260730T120003");
    expect(siblings[1]).toContain("20260730T120004");
  });

  it("does not overwrite a rotated file whose stamp it already used", async () => {
    const path = join(dir, "capture.jsonl");
    const sink = new JsonlSink({ path, maxBytes: 10, maxFiles: 8 }, undefined, {
      now: () => new Date("2026-07-30T12:00:00Z"),
    });

    for (let i = 0; i < 4; i++) {
      await sink.write({ i });
      await sink.flush();
    }
    await sink.close();

    const siblings = await rotated(path);
    expect(new Set(siblings).size).toBe(siblings.length);
    expect(siblings.length).toBeGreaterThan(1);
  });

  it("resumes the byte count from an existing file, so a restart still rotates", async () => {
    const path = join(dir, "capture.jsonl");
    await writeFile(path, `${"x".repeat(100)}\n`);

    const sink = new JsonlSink({ path, maxBytes: 50 });
    await sink.write({ a: 1 });
    await sink.flush();
    await sink.close();

    expect(await rotated(path)).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe('{"a":1}\n');
  });
});
