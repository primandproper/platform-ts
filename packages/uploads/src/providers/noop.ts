import type { Blob, BlobStore } from "../uploads.js";

/** A {@link BlobStore} that stores nothing; every read is a miss. */
export class NoopBlobStore implements BlobStore {
  put(): Promise<void> {
    return Promise.resolve();
  }

  get(): Promise<Blob | undefined> {
    return Promise.resolve(undefined);
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  exists(): Promise<boolean> {
    return Promise.resolve(false);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
