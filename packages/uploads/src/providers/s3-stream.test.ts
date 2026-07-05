import { Readable } from "node:stream";

import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { bytesToStream } from "../stream.js";

import { S3Bucket } from "./s3.js";

// Capture how S3Bucket drives lib-storage's Upload without exercising the real SDK internals
// (endpoint resolution, request handler), which a hand-rolled fake client can't satisfy.
const h = vi.hoisted(() => ({
  calls: [] as { params: Record<string, unknown> }[],
}));

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(opts: { params: Record<string, unknown> }) {
      h.calls.push({ params: opts.params });
    }
    done(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

describe("S3Bucket stream write routing (UP-1)", () => {
  it("streams an unknown-length body through Upload rather than buffering it", async () => {
    h.calls.length = 0;
    // A client that would throw if `send` (the single-PutObject path) were used for a stream.
    const client = {
      send: () => Promise.reject(new Error("stream body must not use PutObject")),
    } as unknown as S3Client;

    const bucket = new S3Bucket(client, "bucket");
    await bucket.write("big.bin", bytesToStream(new Uint8Array([1, 2, 3])), {
      contentType: "application/octet-stream",
    });

    expect(h.calls).toHaveLength(1);
    const params = h.calls[0]?.params;
    expect(params?.Bucket).toBe("bucket");
    expect(params?.Key).toBe("big.bin");
    expect(params?.ContentType).toBe("application/octet-stream");
    // The body handed to Upload is a Node stream, not a buffered Uint8Array.
    expect(params?.Body).toBeInstanceOf(Readable);
  });
});
