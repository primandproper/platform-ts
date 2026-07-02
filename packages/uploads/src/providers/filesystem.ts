import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { Blob, BlobStore, PutOptions } from "../uploads.js";

const o11yName = "uploads";

export interface FilesystemBlobStoreOptions {
  /** The base directory under which blobs are written. */
  dir: string;
}

interface Sidecar {
  contentType?: string;
}

/**
 * A {@link BlobStore} that writes blobs under a base directory. Each blob's `contentType`
 * is persisted alongside it in a `<path>.meta.json` sidecar. Keys are resolved against the
 * base directory and rejected if they escape it, so a key can never traverse outside.
 */
export class FilesystemBlobStore implements BlobStore {
  readonly #dir: string;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: FilesystemBlobStoreOptions, deps: ObservabilityDeps = {}) {
    this.#dir = resolve(options.dir);
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<void> {
    const path = this.#pathFor(key);
    await mkdir(this.#dir, { recursive: true });
    await writeFile(path, body);
    const sidecar: Sidecar =
      opts.contentType === undefined ? {} : { contentType: opts.contentType };
    await writeFile(this.#metaPath(path), JSON.stringify(sidecar));
  }

  async get(key: string): Promise<Blob | undefined> {
    const path = this.#pathFor(key);
    let body: Buffer;
    try {
      body = await readFile(path);
    } catch (error) {
      if (isNotFound(error)) {
        this.#logger.debug("blob not found");
        return undefined;
      }
      throw error;
    }
    const contentType = await this.#readContentType(path);
    return contentType === undefined
      ? { body: new Uint8Array(body) }
      : { body: new Uint8Array(body), contentType };
  }

  async delete(key: string): Promise<void> {
    const path = this.#pathFor(key);
    await rm(path, { force: true });
    await rm(this.#metaPath(path), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const path = this.#pathFor(key);
    try {
      await readFile(path);
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  async #readContentType(path: string): Promise<string | undefined> {
    try {
      const raw = await readFile(this.#metaPath(path), "utf8");
      const sidecar = JSON.parse(raw) as Sidecar;
      return sidecar.contentType;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  #metaPath(path: string): string {
    return `${path}.meta.json`;
  }

  #pathFor(key: string): string {
    if (key.length === 0 || isAbsolute(key) || key.split(/[/\\]/).includes("..")) {
      throw new Error(`invalid blob key: ${key}`);
    }
    const path = resolve(join(this.#dir, key));
    if (path !== this.#dir && !path.startsWith(this.#dir + sep)) {
      throw new Error(`invalid blob key: ${key}`);
    }
    return path;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
