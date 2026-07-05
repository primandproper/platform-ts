import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { BlobNotFoundError, SigningUnsupportedError, type Bucket } from "../bucket.js";
import type { Attributes, ObjectInfo } from "../capabilities.js";
import { bytesToStream, type BlobBody } from "../stream.js";
import type { SaveOptions } from "../uploads.js";

/** Suffix of the sidecar file that carries an object's metadata, mirroring gocloud's `fileblob`. */
const ATTRS_SUFFIX = ".attrs";

interface SidecarAttrs {
  contentType: string | undefined;
  cacheControl: string | undefined;
}

/**
 * A {@link Bucket} that writes blobs under a root directory — the port of gocloud's `fileblob`
 * with `CreateDir: true`. Keys are resolved against the root and rejected if they escape it, so a
 * key can never traverse outside; intermediate directories are created on write.
 *
 * As gocloud does, per-object metadata (content type, cache control) is persisted in a sibling
 * `<key>.attrs` JSON sidecar; those files are excluded from listings. Signing is unsupported (Go
 * opens the bucket with a nil `URLSigner`).
 */
export class FilesystemBucket implements Bucket {
  readonly #root: string;

  constructor(rootDirectory: string) {
    this.#root = resolve(rootDirectory);
  }

  async write(key: string, body: BlobBody, opts?: SaveOptions): Promise<void> {
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });

    // Write to a temp sibling then atomically rename into place, so a crash mid-write never leaves
    // a partial/corrupt object at `path` (gocloud fileblob semantics). Stream the body so a large
    // payload isn't buffered whole. On any failure the temp file is cleaned up.
    const tmp = `${path}.${randomUUID()}.tmp`;
    const source = body instanceof Uint8Array ? bytesToStream(body) : body;
    try {
      await pipeline(Readable.fromWeb(source), createWriteStream(tmp));
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }

    const attrs: SidecarAttrs = {
      contentType: opts?.contentType,
      cacheControl: opts?.cacheControl,
    };
    if (attrs.contentType !== undefined || attrs.cacheControl !== undefined) {
      await writeFile(path + ATTRS_SUFFIX, JSON.stringify(attrs));
    } else {
      await rm(path + ATTRS_SUFFIX, { force: true });
    }
  }

  async openRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<ReadableStream<Uint8Array>> {
    const path = this.#pathFor(key);
    // stat first so an absent object rejects up front rather than erroring mid-stream.
    try {
      await stat(path);
    } catch (err) {
      if (isNotFound(err)) {
        throw new BlobNotFoundError(key);
      }
      throw err;
    }
    const end = length < 0 ? undefined : offset + length - 1;
    const nodeStream = createReadStream(path, { start: offset, end });
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  }

  async delete(key: string): Promise<void> {
    const path = this.#pathFor(key);
    await rm(path, { force: true });
    await rm(path + ATTRS_SUFFIX, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.#pathFor(key));
      return true;
    } catch (err) {
      if (isNotFound(err)) {
        return false;
      }
      throw err;
    }
  }

  async attributes(key: string): Promise<Attributes> {
    const path = this.#pathFor(key);
    let info;
    try {
      info = await stat(path);
    } catch (err) {
      if (isNotFound(err)) {
        throw new BlobNotFoundError(key);
      }
      throw err;
    }
    const sidecar = await this.#readSidecar(path);
    return {
      size: info.size,
      modTime: info.mtime,
      ...(sidecar.contentType !== undefined && { contentType: sidecar.contentType }),
      ...(sidecar.cacheControl !== undefined && { cacheControl: sidecar.cacheControl }),
    };
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    // Walk the whole tree, then filter by prefix — gocloud's fileblob lists the same way.
    for await (const relPath of this.#walk(this.#root)) {
      if (relPath.endsWith(ATTRS_SUFFIX) || !relPath.startsWith(prefix)) {
        continue;
      }
      const info = await stat(join(this.#root, relPath));
      yield {
        path: relPath,
        size: info.size,
        modTime: info.mtime,
        isDir: false,
      };
    }
  }

  signedURL(): Promise<string> {
    return Promise.reject(new SigningUnsupportedError("filesystem"));
  }

  async *#walk(dir: string): AsyncIterable<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.#walk(abs);
      } else {
        // Keys are always reported with forward slashes, regardless of platform separator.
        yield abs
          .slice(this.#root.length + 1)
          .split(sep)
          .join(posix.sep);
      }
    }
  }

  async #readSidecar(path: string): Promise<SidecarAttrs> {
    try {
      return JSON.parse(await readFile(path + ATTRS_SUFFIX, "utf8")) as SidecarAttrs;
    } catch (err) {
      if (isNotFound(err)) {
        return { contentType: undefined, cacheControl: undefined };
      }
      throw err;
    }
  }

  #pathFor(key: string): string {
    if (key.length === 0 || isAbsolute(key) || key.split(/[/\\]/).includes("..")) {
      throw new Error(`invalid blob key: ${key}`);
    }
    const path = resolve(join(this.#root, key));
    if (path !== this.#root && !path.startsWith(this.#root + sep)) {
      throw new Error(`invalid blob key: ${key}`);
    }
    return path;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
