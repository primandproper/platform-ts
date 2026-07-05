import type { CircuitBreaker } from "@primandproper/circuitbreaking";
import { describe, expect, it, vi } from "vitest";

import { CircuitBrokenError } from "../document-index.js";

import { ElasticsearchDocumentIndex } from "./elasticsearch.node.js";

/**
 * Shared, hoisted mock state for a fake `@elastic/elasticsearch` `Client`. `vi.mock` is hoisted
 * above the imports, so its factory can only close over state created with `vi.hoisted`. Recording
 * the index name passed to each operation lets us assert exists/create/delete all address the
 * same (lowercased) index, and steering `deleteError` exercises the delete-of-missing path — both
 * offline, since the real client opens a live connection.
 */
const mock = vi.hoisted(
  (): {
    existsResult: boolean;
    deleteError: Error | undefined;
    existsIndex: string[];
    createIndex: string[];
    deleteIndex: string[];
  } => ({
    existsResult: false,
    deleteError: undefined,
    existsIndex: [],
    createIndex: [],
    deleteIndex: [],
  }),
);

vi.mock("@elastic/elasticsearch", () => {
  class Client {
    info(): Promise<unknown> {
      return Promise.resolve({});
    }
    indices = {
      exists: ({ index }: { index: string }): Promise<boolean> => {
        mock.existsIndex.push(index);
        return Promise.resolve(mock.existsResult);
      },
      create: ({ index }: { index: string }): Promise<unknown> => {
        mock.createIndex.push(index);
        return Promise.resolve({});
      },
    };
    delete({ index }: { index: string }): Promise<unknown> {
      mock.deleteIndex.push(index);
      if (mock.deleteError !== undefined) {
        return Promise.reject(mock.deleteError);
      }
      return Promise.resolve({});
    }
  }
  return { Client };
});

interface Doc {
  id: string;
  name: string;
}

/** A circuit breaker whose calls are recorded so we can assert the breaker was (not) tripped. */
function fakeBreaker(canProceed: boolean): CircuitBreaker & {
  canProceed: ReturnType<typeof vi.fn>;
  succeeded: ReturnType<typeof vi.fn>;
  failed: ReturnType<typeof vi.fn>;
} {
  return {
    canProceed: vi.fn(() => canProceed),
    succeeded: vi.fn(),
    failed: vi.fn(),
  };
}

/** Builds an Elasticsearch-shaped error carrying an HTTP status code. */
function statusError(statusCode: number): Error {
  return Object.assign(new Error(`elasticsearch responded ${String(statusCode)}`), {
    statusCode,
  });
}

function resetMock(): void {
  mock.existsResult = false;
  mock.deleteError = undefined;
  mock.existsIndex = [];
  mock.createIndex = [];
  mock.deleteIndex = [];
}

// SRCH-2: ES lowercases index names, so exists/create/delete must all address the same normalized
// name (the old code lowercased only on `create`, leaving exists/delete pointed at a phantom index),
// and a 404 on delete-of-missing must be a no-op success rather than tripping the circuit breaker.
describe("ElasticsearchDocumentIndex (SRCH-2, mocked client)", () => {
  it("normalizes the index name so exists/create/delete address the same lowercased index", async () => {
    resetMock();
    mock.existsResult = false; // force the create branch so we observe its index name too
    const index = await ElasticsearchDocumentIndex.create<Doc>(
      { address: "http://es", indexName: "MixedCase-Index", readinessAttempts: 1 },
      fakeBreaker(true),
    );

    await index.delete("doc-1");

    expect(mock.existsIndex).toEqual(["mixedcase-index"]);
    expect(mock.createIndex).toEqual(["mixedcase-index"]);
    expect(mock.deleteIndex).toEqual(["mixedcase-index"]);
  });

  it("treats a 404 on delete as a no-op success without tripping the breaker", async () => {
    resetMock();
    mock.existsResult = true; // index already exists; skip create
    const cb = fakeBreaker(true);
    const index = await ElasticsearchDocumentIndex.create<Doc>(
      { address: "http://es", indexName: "idx", readinessAttempts: 1 },
      cb,
    );
    cb.succeeded.mockClear();
    cb.failed.mockClear();
    mock.deleteError = statusError(404); // a missing document

    await expect(index.delete("missing")).resolves.toBeUndefined();
    expect(cb.failed).not.toHaveBeenCalled(); // a miss is not a failure
    expect(cb.succeeded).toHaveBeenCalled();
  });

  it("still trips the breaker on a non-404 delete failure", async () => {
    resetMock();
    mock.existsResult = true;
    const cb = fakeBreaker(true);
    const index = await ElasticsearchDocumentIndex.create<Doc>(
      { address: "http://es", indexName: "idx", readinessAttempts: 1 },
      cb,
    );
    cb.succeeded.mockClear();
    cb.failed.mockClear();
    mock.deleteError = statusError(500);

    await expect(index.delete("boom")).rejects.toBeDefined();
    expect(cb.failed).toHaveBeenCalled();
  });

  it("rejects delete with CircuitBrokenError when the breaker is open (no SDK call)", async () => {
    resetMock();
    // Construct directly (skip create()'s readiness handshake) with an open breaker.
    const index = new ElasticsearchDocumentIndex<Doc>(
      { address: "http://es", indexName: "idx", readinessAttempts: 1 },
      fakeBreaker(false),
    );
    await expect(index.delete("x")).rejects.toBeInstanceOf(CircuitBrokenError);
    expect(mock.deleteIndex).toEqual([]); // breaker open: the SDK is never reached
  });
});
