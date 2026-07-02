import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { DEFAULT_CONTENT_TYPE, decode, type ContentType } from "@primandproper/encoding";
import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import {
  EmptyInputError,
  NegativeCountError,
  NegativeOffsetError,
  NonPositiveChunkSizeError,
  OffsetBeyondEofError,
} from "./errors.js";
import { splitLines } from "./lines.js";

const o11yName = "files";

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Reads text files line-by-line. Lazy line/chunk iteration streams via `readline` (constant memory,
 * the caller's `break` closes the file); eager and decode operations open an observability span.
 * Mirrors platform-go's `files.Reader` plus its package-level convenience functions.
 */
export class Files {
  readonly #observer: Observer;

  constructor(deps: ObservabilityDeps = {}) {
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
  }

  /** Streams the file's lines, each with its terminator stripped. Closes the file when iteration ends. */
  async *lines(path: string): AsyncGenerator<string> {
    const stream = createReadStream(path, { encoding: "utf8" });
    try {
      const reader = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of reader) {
        yield line;
      }
    } finally {
      stream.close();
    }
  }

  /** Streams the file's lines in groups of up to `size`; the final group may be shorter. */
  async *chunks(path: string, size: number): AsyncGenerator<string[]> {
    if (size <= 0) throw new NonPositiveChunkSizeError();
    let buffer: string[] = [];
    for await (const line of this.lines(path)) {
      buffer.push(line);
      if (buffer.length === size) {
        yield buffer;
        buffer = [];
      }
    }
    if (buffer.length > 0) yield buffer;
  }

  /** Reads the whole file and returns all its lines. */
  async allLines(path: string): Promise<string[]> {
    const op = this.#observer.begin(`${o11yName}.allLines`);
    try {
      op.set("file.path", path);
      const content = await readFile(path, "utf8");
      const lines = splitLines(content);
      op.set("file.lines", lines.length).logger().debug("read lines");
      return lines;
    } catch (error) {
      const err = wrap(`reading ${path}`, error);
      op.error(err, err.message);
      throw err;
    } finally {
      op.end();
    }
  }

  /**
   * Skips `offset` lines and returns up to `count` of the rest, reading no further than needed.
   * `count` of `0` returns an empty array; an `offset` at or past EOF throws {@link OffsetBeyondEofError}.
   */
  async sliceLines(path: string, offset: number, count: number): Promise<string[]> {
    if (offset < 0) throw new NegativeOffsetError();
    if (count < 0) throw new NegativeCountError();
    const op = this.#observer.begin(`${o11yName}.sliceLines`);
    try {
      op.set("file.path", path).set("offset", offset).set("count", count);
      if (count === 0) return [];
      const result: string[] = [];
      let index = 0;
      for await (const line of this.lines(path)) {
        if (index >= offset) {
          result.push(line);
          if (result.length === count) break;
        }
        index += 1;
      }
      if (result.length === 0) throw new OffsetBeyondEofError();
      return result;
    } catch (error) {
      op.error(toError(error), "slicing lines failed");
      throw error;
    } finally {
      op.end();
    }
  }

  /** Reads and decodes the file as `contentType` (default JSON). Empty files throw {@link EmptyInputError}. */
  async decode<T>(
    path: string,
    contentType: ContentType = DEFAULT_CONTENT_TYPE,
  ): Promise<T> {
    const op = this.#observer.begin(`${o11yName}.decode`);
    try {
      op.set("file.path", path).set("content_type", contentType);
      const bytes = await readFile(path);
      if (bytes.byteLength === 0) throw new EmptyInputError();
      return decode(new Uint8Array(bytes), contentType) as T;
    } catch (error) {
      op.error(toError(error), "decoding file failed");
      throw error;
    } finally {
      op.end();
    }
  }
}

/**
 * A handle rooted at an absolute directory. Method names are resolved relative to the base, so a
 * `Dir` is a convenient scope for reading a set of related files. Mirrors platform-go's `files.Dir`.
 */
export class Dir {
  readonly #base: string;
  readonly #files: Files;

  private constructor(base: string, files: Files) {
    this.#base = base;
    this.#files = files;
  }

  /** Opens `path` as a directory handle, verifying it exists and is a directory. */
  static async open(path: string, deps?: ObservabilityDeps): Promise<Dir> {
    const base = resolve(path);
    const info = await stat(base);
    if (!info.isDirectory()) {
      throw new Error(`${base} is not a directory`);
    }
    return new Dir(base, new Files(deps));
  }

  /** The absolute base directory. */
  path(): string {
    return this.#base;
  }

  /** Resolves `name` against the base directory. */
  resolve(name: string): string {
    return join(this.#base, name);
  }

  /** Opens a subdirectory as a new handle, sharing this one's observability. */
  sub(rel: string): Promise<Dir> {
    return Dir.open(this.resolve(rel));
  }

  lines(name: string): AsyncGenerator<string> {
    return this.#files.lines(this.resolve(name));
  }

  chunks(name: string, size: number): AsyncGenerator<string[]> {
    return this.#files.chunks(this.resolve(name), size);
  }

  allLines(name: string): Promise<string[]> {
    return this.#files.allLines(this.resolve(name));
  }

  sliceLines(name: string, offset: number, count: number): Promise<string[]> {
    return this.#files.sliceLines(this.resolve(name), offset, count);
  }

  decode<T>(name: string, contentType?: ContentType): Promise<T> {
    return this.#files.decode<T>(this.resolve(name), contentType);
  }
}

// Package-level convenience functions backed by a shared, observability-free reader — the analogue
// of platform-go's package-level helpers over its `defaultReader`.
const defaultFiles = new Files();

/** Streams a file's lines using the default reader. */
export function lines(path: string): AsyncGenerator<string> {
  return defaultFiles.lines(path);
}

/** Streams a file's lines in chunks of up to `size` using the default reader. */
export function chunks(path: string, size: number): AsyncGenerator<string[]> {
  return defaultFiles.chunks(path, size);
}

/** Reads all of a file's lines using the default reader. */
export function allLines(path: string): Promise<string[]> {
  return defaultFiles.allLines(path);
}

/** Slices a file's lines using the default reader. */
export function sliceLines(
  path: string,
  offset: number,
  count: number,
): Promise<string[]> {
  return defaultFiles.sliceLines(path, offset, count);
}

/** Reads and decodes a file using the default reader. */
export function decodeFile<T>(path: string, contentType?: ContentType): Promise<T> {
  return defaultFiles.decode<T>(path, contentType);
}
