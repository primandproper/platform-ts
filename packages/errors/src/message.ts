/** Extracts a human-readable message from an unknown thrown value. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  // A thrown plain object (e.g. `{ message: "..." }` from a non-Error reject) would otherwise
  // stringify to "[object Object]", poisoning every wrap prefix and span status built from it.
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}
