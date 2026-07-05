/**
 * Small byte-stream helpers shared across providers and the byte-oriented convenience helpers.
 * The port keeps the manager streaming (Go's `io.Reader`/`io.ReadCloser`) while still offering a
 * `Uint8Array` path, so these convert between the two representations.
 */

/** A blob payload: raw bytes, or a stream of byte chunks for content that shouldn't be buffered. */
export type BlobBody = Uint8Array | ReadableStream<Uint8Array>;

/** Wraps a byte slice in a single-chunk {@link ReadableStream}. */
export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A stream that yields no bytes — the analogue of Go noop's empty `io.ReadCloser`. */
export function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** Reads a byte stream to completion, concatenating every chunk into one `Uint8Array`. */
export async function collectStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Normalizes a {@link BlobBody} to bytes, draining a stream when necessary. */
export function toBytes(body: BlobBody): Promise<Uint8Array> {
  return body instanceof Uint8Array ? Promise.resolve(body) : collectStream(body);
}

/**
 * Wraps a byte stream so it errors once the cumulative byte count exceeds `maxBytes`, without
 * buffering the whole payload. `onExceeded` supplies the error to fail the stream with — the
 * caller owns the error type. Bytes up to the limit still flow to the consumer before the error.
 */
export function limitStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceeded: (limit: number) => Error,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        reader.releaseLock();
        return;
      }
      total += value.length;
      if (total > maxBytes) {
        const err = onExceeded(maxBytes);
        controller.error(err);
        await reader.cancel(err);
        reader.releaseLock();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
}

/** Discards a body's bytes — used by the noop manager to honor the read of a passed stream. */
export async function drain(body: BlobBody): Promise<void> {
  if (body instanceof Uint8Array) {
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
