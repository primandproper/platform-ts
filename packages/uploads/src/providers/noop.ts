import type {
  Attributer,
  Attributes,
  Lister,
  ObjectInfo,
  RangeReader,
  URLSigner,
} from "../capabilities.js";
import { drain, emptyStream, type BlobBody } from "../stream.js";
import type { UploadManager } from "../uploads.js";

/**
 * An {@link UploadManager} that stores nothing — the port of Go's `uploads/noop` package. It
 * implements the full capability surface so it can stand in for any manager: saves drain the
 * body and vanish, reads yield an empty stream, existence is always `false`, listing is empty.
 *
 * Unlike the config-selected providers, noop is constructed directly (Go's objectstorage config
 * has no `noop` provider); reach for it in tests or to disable uploads without changing call sites.
 */
export class NoopUploadManager
  implements UploadManager, RangeReader, URLSigner, Attributer, Lister
{
  save(_path: string, body: BlobBody): Promise<void> {
    return drain(body);
  }

  open(): Promise<ReadableStream<Uint8Array>> {
    return Promise.resolve(emptyStream());
  }

  openRange(): Promise<ReadableStream<Uint8Array>> {
    return Promise.resolve(emptyStream());
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  exists(): Promise<boolean> {
    return Promise.resolve(false);
  }

  attributes(): Promise<Attributes> {
    return Promise.resolve({ size: 0 });
  }

  async *list(): AsyncIterable<ObjectInfo> {
    // Intentionally empty: a noop manager lists no objects.
  }

  signedURL(): Promise<string> {
    return Promise.resolve("");
  }
}
