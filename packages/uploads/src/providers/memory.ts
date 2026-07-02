import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { Blob, BlobStore, PutOptions } from "../uploads.js";

const o11yName = "uploads";

interface StoredBlob {
  body: Uint8Array;
  contentType?: string;
}

/** A {@link BlobStore} backed by an in-process `Map`. The default provider. */
export class MemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, StoredBlob>();
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(deps: ObservabilityDeps = {}) {
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<void> {
    const stored: StoredBlob =
      opts.contentType === undefined
        ? { body: body.slice() }
        : { body: body.slice(), contentType: opts.contentType };
    this.#blobs.set(key, stored);
    return Promise.resolve();
  }

  get(key: string): Promise<Blob | undefined> {
    const stored = this.#blobs.get(key);
    if (stored === undefined) {
      this.#logger.debug("blob not found");
      return Promise.resolve(undefined);
    }
    const blob: Blob =
      stored.contentType === undefined
        ? { body: stored.body.slice() }
        : { body: stored.body.slice(), contentType: stored.contentType };
    return Promise.resolve(blob);
  }

  delete(key: string): Promise<void> {
    this.#blobs.delete(key);
    return Promise.resolve();
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.#blobs.has(key));
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
