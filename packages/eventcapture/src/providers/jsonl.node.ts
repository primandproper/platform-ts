import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { PlatformError, wrap } from "@primandproper/errors";
import {
  ensureLogger,
  type Logger,
  type ObservabilityDeps,
} from "@primandproper/observability";

import {
  JsonlSinkConfigSchema,
  type JsonlSinkConfig,
  type JsonlSinkConfigInput,
} from "../config.js";
import type { Sink } from "../sink.js";

/** Raised when a record arrives after `close`. */
export const SINK_CLOSED_CODE = "eventcapture/sink-closed";
/** Raised when a record cannot be turned into a JSON line. */
export const UNSERIALIZABLE_RECORD_CODE = "eventcapture/unserializable-record";

/**
 * Pending bytes that force a write to disk without waiting for the next flush tick. Mirrors a
 * `bufio.Writer`: batching is the point, but an unbounded line buffer would just move the
 * memory problem from the recorder into the sink.
 */
const BUFFER_BYTES = 64 * 1024;

/** Extra knobs the schema does not carry. */
export interface JsonlSinkOptions {
  /** Clock stamping rotated files. Injectable so rotation tests are deterministic. */
  now?: () => Date;
}

/**
 * An append-only, size-rotated, newline-delimited JSON file.
 *
 * Each record is `JSON.stringify`-ed as one line, so the record's own shape defines the wire
 * format and the sink prescribes nothing about content. Rotated files are renamed
 * `path.<timestamp>` with a fixed-width stamp whose lexical order is chronological order, and
 * the oldest are pruned so at most `maxFiles` rotated siblings are retained beside the live one.
 *
 * The file is opened lazily on the first flush, which keeps construction synchronous and means
 * a capture pipeline that never records anything never creates a file.
 */
export class JsonlSink implements Sink {
  readonly #config: JsonlSinkConfig;
  readonly #path: string;
  readonly #logger: Logger;
  readonly #now: () => Date;

  #handle: FileHandle | undefined;
  #writtenBytes = 0;
  #pending: string[] = [];
  #pendingBytes = 0;
  #closed = false;

  constructor(
    config: JsonlSinkConfigInput,
    deps?: ObservabilityDeps,
    options: JsonlSinkOptions = {},
  ) {
    this.#config = JsonlSinkConfigSchema.parse(config);
    this.#path = resolve(this.#config.path);
    this.#logger = ensureLogger(deps?.logger).child("jsonl_capture_sink");
    this.#now = options.now ?? ((): Date => new Date());
  }

  /** The absolute path of the live file. */
  get path(): string {
    return this.#path;
  }

  async write(record: unknown): Promise<void> {
    if (this.#closed) {
      throw new PlatformError(SINK_CLOSED_CODE, "jsonl capture sink is closed");
    }

    // Checked up front rather than after the fact: `JSON.stringify` is typed as returning
    // `string` but yields `undefined` for exactly these three, which would append a literal
    // "undefined" line to a file whose whole promise is that every line parses.
    if (
      record === undefined ||
      typeof record === "function" ||
      typeof record === "symbol"
    ) {
      throw new PlatformError(
        UNSERIALIZABLE_RECORD_CODE,
        "record has no JSON representation",
      );
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(record);
    } catch (err) {
      throw wrap("marshaling record", err);
    }

    const line = `${serialized}\n`;
    this.#pending.push(line);
    this.#pendingBytes += Buffer.byteLength(line);
    if (this.#pendingBytes >= BUFFER_BYTES) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.#pending.length === 0) {
      return;
    }
    const chunk = this.#pending.join("");
    const bytes = this.#pendingBytes;
    this.#pending = [];
    this.#pendingBytes = 0;

    await this.#ensureOpen();
    // A chunk larger than maxBytes on its own is still written — to a fresh file — rather than
    // lost, so an oversized record cannot wedge the pipeline.
    if (this.#writtenBytes > 0 && this.#writtenBytes + bytes > this.#config.maxBytes) {
      await this.#rotate();
    }

    const handle = this.#handle;
    if (handle === undefined) {
      throw new PlatformError(SINK_CLOSED_CODE, "jsonl capture sink is closed");
    }
    try {
      await handle.write(chunk);
    } catch (err) {
      throw wrap("writing records", err);
    }
    this.#writtenBytes += bytes;
  }

  /** Flushes and closes the live file. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    try {
      await this.flush();
    } finally {
      this.#closed = true;
      const handle = this.#handle;
      this.#handle = undefined;
      if (handle !== undefined) {
        await handle.close();
      }
    }
  }

  /**
   * Opens the live file for appending, creating parent directories as needed, and resumes the
   * byte count from its current size so rotation thresholds survive a restart.
   */
  async #ensureOpen(): Promise<void> {
    if (this.#handle !== undefined) {
      return;
    }
    if (this.#closed) {
      throw new PlatformError(SINK_CLOSED_CODE, "jsonl capture sink is closed");
    }
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      const handle = await open(this.#path, "a");
      const info = await handle.stat();
      this.#handle = handle;
      this.#writtenBytes = info.size;
    } catch (err) {
      throw wrap("opening capture file", err);
    }
  }

  /**
   * Closes the live file, renames it aside with a timestamp, reopens a fresh one, and prunes
   * the oldest rotated siblings beyond `maxFiles`.
   */
  async #rotate(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    if (handle !== undefined) {
      await handle.close();
    }

    const rotated = await this.#rotatedPath();
    try {
      await rename(this.#path, rotated);
    } catch (err) {
      throw wrap("rotating capture file", err);
    }
    this.#logger.info("rotated capture file", {
      rotatedTo: rotated,
      bytes: this.#writtenBytes,
    });

    await this.#ensureOpen();
    await this.#prune();
  }

  /**
   * The name to rotate the live file to. `rename` overwrites silently, so a name already taken
   * — two rotations inside one millisecond — gets a suffix rather than eating the older file.
   */
  async #rotatedPath(): Promise<string> {
    const stamp = this.#now().toISOString().replace(/[-:]/g, "");
    let candidate = `${this.#path}.${stamp}`;
    for (let n = 1; await exists(candidate); n++) {
      candidate = `${this.#path}.${stamp}-${String(n)}`;
    }
    return candidate;
  }

  /**
   * Deletes the oldest rotated files until at most `maxFiles` remain. The stamp is fixed-width,
   * so lexical order is age order. Prune failures do not fail the write — losing old capture
   * files beats failing a write — but they are logged, because a prune that never succeeds is
   * indistinguishable from one that is working right up until the disk fills.
   */
  async #prune(): Promise<void> {
    const dir = dirname(this.#path);
    const prefix = `${basename(this.#path)}.`;
    let rotated: string[];
    try {
      rotated = (await readdir(dir)).filter((name) => name.startsWith(prefix)).sort();
    } catch (err) {
      this.#logger.error("listing rotated capture files for pruning", err);
      return;
    }
    if (rotated.length <= this.#config.maxFiles) {
      return;
    }

    for (const name of rotated.slice(0, rotated.length - this.#config.maxFiles)) {
      try {
        await rm(resolve(dir, name));
      } catch (err) {
        // Best effort; the next rotation retries.
        this.#logger.error("pruning rotated capture file", err, { path: name });
      }
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
