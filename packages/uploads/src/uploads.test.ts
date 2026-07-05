import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FilesystemBucket } from "./providers/filesystem.js";
import { MemoryBucket } from "./providers/memory.js";
import { NoopUploadManager } from "./providers/noop.js";
import { S3Bucket } from "./providers/s3.js";
import { bytesToStream, collectStream } from "./stream.js";

import {
  BlobNotFoundError,
  PrefixedBucket,
  SigningUnsupportedError,
  isAttributer,
  isLister,
  isRangeReader,
  isURLSigner,
  listAll,
  provideUploads,
  readFile,
  saveFile,
  UploadsConfigSchema,
  type Attributer,
  type Bucket,
  type Lister,
  type UploadManager,
  type URLSigner,
} from "./index.js";

const bytes = (...n: number[]): Uint8Array => new Uint8Array(n);

async function read(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return collectStream(stream);
}

/**
 * Provider-agnostic conformance suite over the {@link Bucket} seam. Running the same assertions
 * against memory + filesystem proves the interface is implementation-independent.
 */
function bucketConformance(name: string, make: () => Bucket): void {
  describe(name, () => {
    it("rejects opening an unknown key", async () => {
      await expect(make().openRange("missing", 0, -1)).rejects.toBeInstanceOf(
        BlobNotFoundError,
      );
    });

    it("round-trips bytes through write then open", async () => {
      const b = make();
      await b.write("a", bytes(1, 2, 3, 4));
      expect(await read(await b.openRange("a", 0, -1))).toEqual(bytes(1, 2, 3, 4));
    });

    it("writes from a stream body", async () => {
      const b = make();
      await b.write("s", bytesToStream(bytes(9, 8, 7)));
      expect(await read(await b.openRange("s", 0, -1))).toEqual(bytes(9, 8, 7));
    });

    it("reads a byte range", async () => {
      const b = make();
      await b.write("r", bytes(0, 1, 2, 3, 4, 5));
      expect(await read(await b.openRange("r", 2, 3))).toEqual(bytes(2, 3, 4));
    });

    it("reads to the end with a negative length", async () => {
      const b = make();
      await b.write("r", bytes(0, 1, 2, 3, 4, 5));
      expect(await read(await b.openRange("r", 4, -1))).toEqual(bytes(4, 5));
    });

    it("reflects state through exists", async () => {
      const b = make();
      expect(await b.exists("a")).toBe(false);
      await b.write("a", bytes(1));
      expect(await b.exists("a")).toBe(true);
    });

    it("removes an object through delete", async () => {
      const b = make();
      await b.write("a", bytes(1));
      await b.delete("a");
      expect(await b.exists("a")).toBe(false);
    });

    it("delete is a no-op on an absent key", async () => {
      await expect(make().delete("nope")).resolves.toBeUndefined();
    });

    it("stores and reports attributes", async () => {
      const b = make();
      await b.write("a", bytes(1, 2, 3), {
        contentType: "text/plain",
        cacheControl: "max-age=60",
      });
      const attrs = await b.attributes("a");
      expect(attrs.size).toBe(3);
      expect(attrs.contentType).toBe("text/plain");
      expect(attrs.cacheControl).toBe("max-age=60");
    });

    it("rejects attributes on an absent key", async () => {
      await expect(make().attributes("missing")).rejects.toBeInstanceOf(
        BlobNotFoundError,
      );
    });

    it("lists objects under a prefix", async () => {
      const b = make();
      await b.write("data/a.txt", bytes(1));
      await b.write("data/b.txt", bytes(2));
      await b.write("other/c.txt", bytes(3));
      const paths: string[] = [];
      for await (const obj of b.list("data/")) {
        paths.push(obj.path);
      }
      expect(paths.sort()).toEqual(["data/a.txt", "data/b.txt"]);
    });

    it("does not support signing", async () => {
      await expect(make().signedURL("a")).rejects.toBeInstanceOf(SigningUnsupportedError);
    });
  });
}

bucketConformance("MemoryBucket", () => new MemoryBucket());

describe("FilesystemBucket", () => {
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

  bucketConformance("conformance", () => new FilesystemBucket(dir));

  describe("key sanitization", () => {
    it("rejects a traversal key on write", async () => {
      await expect(
        new FilesystemBucket(dir).write("../escape", bytes(1)),
      ).rejects.toThrow();
    });

    it("rejects an absolute key", async () => {
      await expect(
        new FilesystemBucket(dir).write("/etc/passwd", bytes(1)),
      ).rejects.toThrow();
    });
  });

  it("does not surface .attrs sidecars in listings", async () => {
    const b = new FilesystemBucket(dir);
    await b.write("note.txt", bytes(1), { contentType: "text/plain" });
    const paths = (await listAll(b, "")).map((o) => o.path);
    expect(paths).toEqual(["note.txt"]);
  });

  // UP-2: the atomic temp+rename write must leave no partial/temp residue behind.
  it("leaves no temp file after an atomic write", async () => {
    const b = new FilesystemBucket(dir);
    await b.write("data/blob.bin", bytesToStream(bytes(1, 2, 3, 4)));
    expect(await read(await b.openRange("data/blob.bin", 0, -1))).toEqual(
      bytes(1, 2, 3, 4),
    );
    const entries = await readdir(join(dir, "data"));
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});

describe("MemoryBucket copies bytes", () => {
  it("does not store a reference to the caller's buffer", async () => {
    const b = new MemoryBucket();
    const body = bytes(1, 2, 3);
    await b.write("a", body);
    body[0] = 99;
    expect(await read(await b.openRange("a", 0, -1))).toEqual(bytes(1, 2, 3));
  });
});

describe("PrefixedBucket", () => {
  it("prefixes keys and strips the prefix from listings", async () => {
    const inner = new MemoryBucket();
    const b = new PrefixedBucket(inner, "tenant-1/");

    await b.write("a.txt", bytes(1));
    expect(await inner.exists("tenant-1/a.txt")).toBe(true);
    expect(await read(await b.openRange("a.txt", 0, -1))).toEqual(bytes(1));

    const paths = (await listAll(b, "")).map((o) => o.path);
    expect(paths).toEqual(["a.txt"]);
  });
});

describe("provideUploads (instrumented Uploader over memory)", () => {
  it("round-trips through the byte helpers", async () => {
    const m = provideUploads({ bucketName: "test" });
    await saveFile(m, "note.txt", new TextEncoder().encode("hi"), {
      contentType: "text/plain",
    });
    expect(new TextDecoder().decode(await readFile(m, "note.txt"))).toBe("hi");
  });

  it("rejects reading an absent object", async () => {
    const m = provideUploads({ bucketName: "test" });
    await expect(m.open("missing")).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("exposes the optional capabilities", async () => {
    const m = provideUploads({ bucketName: "test" });
    expect(isRangeReader(m)).toBe(true);
    expect(isURLSigner(m)).toBe(true);
    expect(isAttributer(m)).toBe(true);
    expect(isLister(m)).toBe(true);
  });

  it("lists via the Lister capability", async () => {
    const m = provideUploads({ bucketName: "test" });
    await saveFile(m, "a.txt", bytes(1));
    await saveFile(m, "b.txt", bytes(2));
    if (!isLister(m)) throw new Error("expected a Lister");
    const paths = (await listAll(m, "")).map((o) => o.path);
    expect(paths.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("honors bucketPrefix transparently", async () => {
    const m = provideUploads({ bucketName: "test", bucketPrefix: "p/" });
    await saveFile(m, "a.txt", bytes(1));
    if (!isLister(m)) throw new Error("expected a Lister");
    expect((await listAll(m, "")).map((o) => o.path)).toEqual(["a.txt"]);
  });
});

describe("NoopUploadManager", () => {
  it("discards writes and reads back nothing", async () => {
    const m: UploadManager = new NoopUploadManager();
    await m.save("a", bytes(1));
    await m.save("s", bytesToStream(bytes(1, 2)));
    expect(await read(await m.open("a"))).toEqual(bytes());
    expect(await m.exists("a")).toBe(false);
    await expect(m.delete("a")).resolves.toBeUndefined();
  });

  it("lists nothing and rejects signing (a noop can't mint a real URL)", async () => {
    const m: Attributer & Lister & URLSigner = new NoopUploadManager();
    expect(await listAll(m, "")).toEqual([]);
    await expect(m.signedURL("a")).rejects.toBeInstanceOf(SigningUnsupportedError);
    expect((await m.attributes("a")).size).toBe(0);
  });
});

describe("maxSizeBytes backstop", () => {
  it("rejects a byte body over the limit before writing", async () => {
    const m = provideUploads({ bucketName: "b", provider: "memory", maxSizeBytes: 4 });
    await expect(m.save("a", bytes(1, 2, 3, 4, 5))).rejects.toMatchObject({
      code: "uploads/file-too-large",
    });
    // a body within the limit still writes.
    await expect(m.save("a", bytes(1, 2, 3, 4))).resolves.toBeUndefined();
  });

  it("rejects a stream body once it crosses the limit", async () => {
    const m = provideUploads({ bucketName: "b", provider: "memory", maxSizeBytes: 4 });
    const oversized = bytesToStream(bytes(1, 2, 3, 4, 5, 6));
    await expect(m.save("s", oversized)).rejects.toMatchObject({
      code: "uploads/file-too-large",
    });
  });

  it("is disabled by default (maxSizeBytes 0)", async () => {
    const m = provideUploads({ bucketName: "b", provider: "memory" });
    await expect(m.save("a", bytes(1, 2, 3, 4, 5, 6, 7, 8))).resolves.toBeUndefined();
  });
});

describe("UploadsConfigSchema", () => {
  it("defaults to the memory provider", () => {
    expect(UploadsConfigSchema.parse({ bucketName: "b" }).provider).toBe("memory");
  });

  it("requires bucketName", () => {
    expect(() => UploadsConfigSchema.parse({})).toThrow();
  });

  it("requires the filesystem sub-config for the filesystem provider", () => {
    expect(() =>
      UploadsConfigSchema.parse({ bucketName: "b", provider: "filesystem" }),
    ).toThrow();
    expect(() =>
      UploadsConfigSchema.parse({
        bucketName: "b",
        provider: "filesystem",
        filesystem: { rootDirectory: "/tmp/x" },
      }),
    ).not.toThrow();
  });

  it("requires r2 credentials for the r2 provider", () => {
    expect(() =>
      UploadsConfigSchema.parse({ bucketName: "b", provider: "r2" }),
    ).toThrow();
  });
});

/**
 * S3Bucket against a fake `send` that dispatches on command name over an in-memory map — exercises
 * the S3/R2/Backblaze code path (range headers, list, not-found normalization) without a network.
 */
describe("S3Bucket (fake client)", () => {
  class NotFound extends Error {
    override name = "NoSuchKey";
  }

  function fakeClient(): S3Client {
    const store = new Map<string, Uint8Array>();
    const send = (command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => {
      const { name } = command.constructor;
      const key = command.input.Key as string;
      switch (name) {
        case "PutObjectCommand":
          store.set(key, command.input.Body as Uint8Array);
          return Promise.resolve({});
        case "GetObjectCommand": {
          const value = store.get(key);
          if (value === undefined) return Promise.reject(new NotFound());
          const range = command.input.Range as string | undefined;
          let slice = value;
          if (range) {
            const [start, end] = range.replace("bytes=", "").split("-");
            slice = value.slice(Number(start), end === "" ? undefined : Number(end) + 1);
          }
          return Promise.resolve({
            Body: { transformToWebStream: () => bytesToStream(slice) },
          });
        }
        case "HeadObjectCommand": {
          const value = store.get(key);
          if (value === undefined) return Promise.reject(new NotFound());
          return Promise.resolve({
            ContentLength: value.length,
            ContentType: "text/plain",
          });
        }
        case "DeleteObjectCommand":
          store.delete(key);
          return Promise.resolve({});
        case "ListObjectsV2Command": {
          const prefix = (command.input.Prefix as string | undefined) ?? "";
          const Contents = [...store.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .map(([k, v]) => ({ Key: k, Size: v.length }));
          return Promise.resolve({ Contents, IsTruncated: false });
        }
        default:
          return Promise.reject(new Error(`unexpected command ${name}`));
      }
    };
    return { send } as unknown as S3Client;
  }

  it("round-trips, ranges, heads, lists, and deletes", async () => {
    const b = new S3Bucket(fakeClient(), "bucket");
    await b.write("a.txt", bytes(0, 1, 2, 3, 4), { contentType: "text/plain" });

    expect(await read(await b.openRange("a.txt", 0, -1))).toEqual(bytes(0, 1, 2, 3, 4));
    expect(await read(await b.openRange("a.txt", 1, 2))).toEqual(bytes(1, 2));
    expect(await read(await b.openRange("a.txt", 3, -1))).toEqual(bytes(3, 4));

    expect(await b.exists("a.txt")).toBe(true);
    expect(await b.exists("missing")).toBe(false);
    expect((await b.attributes("a.txt")).size).toBe(5);
    expect((await listAll(b, "")).map((o) => o.path)).toEqual(["a.txt"]);

    await b.delete("a.txt");
    expect(await b.exists("a.txt")).toBe(false);
  });

  it("normalizes a missing object to BlobNotFoundError", async () => {
    const b = new S3Bucket(fakeClient(), "bucket");
    await expect(b.openRange("gone", 0, -1)).rejects.toBeInstanceOf(BlobNotFoundError);
    await expect(b.attributes("gone")).rejects.toBeInstanceOf(BlobNotFoundError);
  });
});
