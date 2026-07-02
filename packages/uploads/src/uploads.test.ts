import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FilesystemBlobStore } from "./providers/filesystem.js";
import { MemoryBlobStore } from "./providers/memory.js";
import { NoopBlobStore } from "./providers/noop.js";
import { S3BlobStore } from "./providers/s3.js";

import { provideUploads, type BlobStore } from "./index.js";

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple
 * providers proves the `BlobStore` interface is implementation-independent.
 */
function conformance(name: string, make: () => BlobStore): void {
  describe(name, () => {
    it("returns undefined for an unknown key", async () => {
      expect(await make().get("missing")).toBeUndefined();
    });

    it("round-trips bytes through put then get", async () => {
      const store = make();
      const body = new Uint8Array([1, 2, 3, 4]);
      await store.put("a", body);
      const blob = await store.get("a");
      expect(blob?.body).toEqual(body);
    });

    it("reflects state through exists", async () => {
      const store = make();
      expect(await store.exists("a")).toBe(false);
      await store.put("a", new Uint8Array([1]));
      expect(await store.exists("a")).toBe(true);
    });

    it("removes a blob through delete", async () => {
      const store = make();
      await store.put("a", new Uint8Array([1]));
      await store.delete("a");
      expect(await store.exists("a")).toBe(false);
      expect(await store.get("a")).toBeUndefined();
    });

    it("preserves contentType", async () => {
      const store = make();
      await store.put("a", new Uint8Array([1]), { contentType: "text/plain" });
      const blob = await store.get("a");
      expect(blob?.contentType).toBe("text/plain");
    });

    it("pings without throwing", async () => {
      await expect(make().ping()).resolves.toBeUndefined();
    });
  });
}

conformance("MemoryBlobStore", () => new MemoryBlobStore());

describe("FilesystemBlobStore", () => {
  let root: string;
  let dir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "uploads-fs-"));
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(root, "case-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  conformance("conformance", () => new FilesystemBlobStore({ dir }));

  describe("key sanitization", () => {
    it("rejects a traversal key on put", async () => {
      const store = new FilesystemBlobStore({ dir });
      await expect(store.put("../escape", new Uint8Array([1]))).rejects.toThrow();
    });

    it("rejects a traversal key on get", async () => {
      const store = new FilesystemBlobStore({ dir });
      await expect(store.get("../../etc/passwd")).rejects.toThrow();
    });

    it("rejects an absolute key", async () => {
      const store = new FilesystemBlobStore({ dir });
      await expect(store.put("/etc/passwd", new Uint8Array([1]))).rejects.toThrow();
    });
  });
});

describe("MemoryBlobStore copies bytes", () => {
  it("does not store a reference to the caller's buffer", async () => {
    const store = new MemoryBlobStore();
    const body = new Uint8Array([1, 2, 3]);
    await store.put("a", body);
    body[0] = 99;
    const blob = await store.get("a");
    expect(blob?.body).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("NoopBlobStore", () => {
  it("discards writes and reads back nothing", async () => {
    const store: BlobStore = new NoopBlobStore();
    await store.put("a", new Uint8Array([1]));
    expect(await store.get("a")).toBeUndefined();
    expect(await store.exists("a")).toBe(false);
    await expect(store.delete("a")).resolves.toBeUndefined();
    await expect(store.ping()).resolves.toBeUndefined();
  });
});

/**
 * An in-memory stand-in for the AWS S3 client. It speaks the same command/response shapes
 * the provider relies on so the conformance suite can run offline; absent objects throw the
 * SDK's `NoSuchKey`/`NotFound` errors with a 404 in `$metadata`, exactly like the real client.
 */
function fakeS3Client(): S3Client {
  const objects = new Map<string, { body: Uint8Array; contentType?: string }>();

  const notFound = (name: string): Error => {
    const error = new Error(name) as Error & {
      name: string;
      $metadata: { httpStatusCode: number };
    };
    error.name = name;
    error.$metadata = { httpStatusCode: 404 };
    return error;
  };

  const send = (command: {
    constructor: { name: string };
    input: { Key?: string; Body?: Uint8Array; ContentType?: string };
  }): Promise<unknown> => {
    const { Key } = command.input;
    switch (command.constructor.name) {
      case "PutObjectCommand": {
        const stored: { body: Uint8Array; contentType?: string } = {
          body: (command.input.Body ?? new Uint8Array()).slice(),
        };
        if (command.input.ContentType !== undefined) {
          stored.contentType = command.input.ContentType;
        }
        objects.set(Key ?? "", stored);
        return Promise.resolve({});
      }
      case "GetObjectCommand": {
        const stored = objects.get(Key ?? "");
        if (stored === undefined) {
          return Promise.reject(notFound("NoSuchKey"));
        }
        return Promise.resolve({
          ContentType: stored.contentType,
          Body: { transformToByteArray: () => Promise.resolve(stored.body.slice()) },
        });
      }
      case "HeadObjectCommand": {
        if (!objects.has(Key ?? "")) {
          return Promise.reject(notFound("NotFound"));
        }
        return Promise.resolve({});
      }
      case "DeleteObjectCommand": {
        objects.delete(Key ?? "");
        return Promise.resolve({});
      }
      case "HeadBucketCommand":
        return Promise.resolve({});
      default:
        return Promise.reject(
          new Error(`unexpected command ${command.constructor.name}`),
        );
    }
  };

  // The provider only ever calls `send`; the fake satisfies the rest of the type by cast.
  return { send } as unknown as S3Client;
}

conformance(
  "S3BlobStore (fake client)",
  () => new S3BlobStore({ bucket: "test", region: "us-east-1", client: fakeS3Client() }),
);

describe("S3BlobStore", () => {
  it("wraps non-404 SDK errors with operation context", async () => {
    const boom = { send: () => Promise.reject(new Error("boom")) } as unknown as S3Client;
    const store = new S3BlobStore({ bucket: "test", region: "us-east-1", client: boom });
    await expect(store.put("k", new Uint8Array([1]))).rejects.toThrow(/s3 put failed/);
  });
});

/**
 * Live integration suite. Gated behind `UPLOADS_S3_TEST_ENDPOINT` (e.g. a MinIO/LocalStack
 * URL) so the default offline run stays green; `UPLOADS_S3_TEST_BUCKET` must already exist.
 */
const liveEndpoint = process.env.UPLOADS_S3_TEST_ENDPOINT;
const liveSuite = liveEndpoint === undefined ? describe.skip : describe;
liveSuite("S3BlobStore (live)", () => {
  const bucket = process.env.UPLOADS_S3_TEST_BUCKET ?? "uploads-test";
  conformance(
    "conformance",
    () =>
      new S3BlobStore({
        bucket,
        region: process.env.UPLOADS_S3_TEST_REGION ?? "us-east-1",
        endpoint: liveEndpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.UPLOADS_S3_TEST_ACCESS_KEY ?? "minioadmin",
          secretAccessKey: process.env.UPLOADS_S3_TEST_SECRET_KEY ?? "minioadmin",
        },
      }),
  );
});

describe("provideUploads", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "uploads-provide-"));
  });

  afterEach(async () => {
    await rm(join(dir, "k"), { force: true });
    await rm(join(dir, "k.meta.json"), { force: true });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to the memory provider", () => {
    expect(provideUploads(undefined, {})).toBeInstanceOf(MemoryBlobStore);
  });

  it("builds a filesystem store", async () => {
    const store = provideUploads({ provider: "filesystem", filesystem: { dir } });
    await store.put("k", new Uint8Array([7]));
    expect((await store.get("k"))?.body).toEqual(new Uint8Array([7]));
  });

  it("rejects a filesystem provider without config", () => {
    expect(() => provideUploads({ provider: "filesystem" })).toThrow();
  });

  it("builds an s3 store", () => {
    const store = provideUploads({
      provider: "s3",
      s3: { bucket: "b", region: "us-east-1" },
    });
    expect(store).toBeInstanceOf(S3BlobStore);
  });

  it("rejects an s3 provider without config", () => {
    expect(() => provideUploads({ provider: "s3" })).toThrow();
  });
});
