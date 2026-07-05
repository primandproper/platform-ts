import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeRecordingObserver } from "@primandproper/observability";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Dir,
  EmptyInputError,
  Files,
  NonPositiveChunkSizeError,
  OffsetBeyondEofError,
  PathEscapesBaseError,
  allLines,
  chunkLines,
  decodeFile,
  sliceLines,
  sliceLinesFrom,
  splitLines,
} from "./index.js";

describe("splitLines", () => {
  it("returns an empty array for empty input", () => {
    expect(splitLines("")).toStrictEqual([]);
  });

  it("drops a trailing newline but keeps interior empty lines", () => {
    expect(splitLines("a\n\nb\n")).toStrictEqual(["a", "", "b"]);
  });

  it("strips CRLF terminators", () => {
    expect(splitLines("a\r\nb\r\n")).toStrictEqual(["a", "b"]);
  });

  it("keeps an unterminated final line", () => {
    expect(splitLines("a\nb")).toStrictEqual(["a", "b"]);
  });
});

describe("chunkLines", () => {
  it("groups lines, leaving a short final chunk", () => {
    expect(chunkLines(["a", "b", "c", "d", "e"], 2)).toStrictEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
  });

  it("rejects a non-positive size", () => {
    expect(() => chunkLines(["a"], 0)).toThrow(NonPositiveChunkSizeError);
  });
});

describe("sliceLinesFrom", () => {
  it("skips offset and returns up to count", () => {
    expect(sliceLinesFrom("a\nb\nc\nd", 1, 2)).toStrictEqual(["b", "c"]);
  });

  it("returns a short slice when fewer than count remain", () => {
    expect(sliceLinesFrom("a\nb\nc", 2, 5)).toStrictEqual(["c"]);
  });

  it("returns empty for a zero count", () => {
    expect(sliceLinesFrom("a\nb", 0, 0)).toStrictEqual([]);
  });

  it("throws when the offset is at or beyond EOF", () => {
    expect(() => sliceLinesFrom("a\nb", 2, 1)).toThrow(OffsetBeyondEofError);
  });
});

describe("file operations", () => {
  let dir: string;
  let textPath: string;
  let jsonPath: string;
  const files = new Files();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "platform-files-"));
    textPath = join(dir, "lines.txt");
    jsonPath = join(dir, "data.json");
    await writeFile(textPath, "alpha\nbravo\ncharlie\ndelta\necho\n");
    await writeFile(jsonPath, JSON.stringify({ a: 1, b: "two" }));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads all lines", async () => {
    expect(await allLines(textPath)).toStrictEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
    ]);
  });

  it("streams lines lazily", async () => {
    const collected: string[] = [];
    for await (const line of files.lines(textPath)) collected.push(line);
    expect(collected).toStrictEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
  });

  it("streams chunks", async () => {
    const collected: string[][] = [];
    for await (const chunk of files.chunks(textPath, 2)) collected.push(chunk);
    expect(collected).toStrictEqual([["alpha", "bravo"], ["charlie", "delta"], ["echo"]]);
  });

  it("rejects a non-positive chunk size before reading", async () => {
    await expect(files.chunks(textPath, 0).next()).rejects.toBeInstanceOf(
      NonPositiveChunkSizeError,
    );
  });

  it("slices file lines without reading to the end", async () => {
    expect(await sliceLines(textPath, 1, 2)).toStrictEqual(["bravo", "charlie"]);
  });

  it("throws OffsetBeyondEofError past the end of the file", async () => {
    await expect(sliceLines(textPath, 99, 1)).rejects.toBeInstanceOf(
      OffsetBeyondEofError,
    );
  });

  it("decodes a JSON file", async () => {
    expect(await decodeFile(jsonPath)).toStrictEqual({ a: 1, b: "two" });
  });

  it("rejects decoding an empty file", async () => {
    const emptyPath = join(dir, "empty.json");
    await writeFile(emptyPath, "");
    await expect(files.decode(emptyPath)).rejects.toBeInstanceOf(EmptyInputError);
  });

  it("reads through a Dir handle", async () => {
    const handle = await Dir.open(dir);
    expect(handle.path()).toBe(dir);
    expect(await handle.allLines("lines.txt")).toHaveLength(5);
    await expect(handle.decode("data.json")).resolves.toStrictEqual({ a: 1, b: "two" });
  });

  it("rejects a name that escapes the base directory", async () => {
    const handle = await Dir.open(dir);
    expect(() => handle.resolve("../escape.txt")).toThrow(PathEscapesBaseError);
    expect(() => handle.resolve("nested/../../escape.txt")).toThrow(PathEscapesBaseError);
    // every method routes through resolve(), so it is guarded too (fails fast).
    expect(() => handle.allLines("../escape.txt")).toThrow(PathEscapesBaseError);
    // a name that stays within the base still resolves.
    expect(handle.resolve("lines.txt")).toBe(join(dir, "lines.txt"));
  });

  it("shares the parent's observability with a sub() handle", async () => {
    const sub = join(dir, "nested");
    await mkdir(sub);
    await writeFile(join(sub, "data.json"), JSON.stringify({ ok: true }));

    const observer = makeRecordingObserver();
    const parent = await Dir.open(dir, { observer });
    const child = await parent.sub("nested");
    await child.decode("data.json");

    // sub() reuses the parent's Files (and thus its observer); on the old behavior the child
    // built a fresh, deps-free Files and this observation would never land.
    expect(observer.observed("file.path")).toBe(true);
    expect(String(observer.data()["file.path"])).toContain("data.json");
  });
});
