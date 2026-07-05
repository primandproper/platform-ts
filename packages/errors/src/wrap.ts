import { messageOf } from "./message.js";
import { isPlatformError, PlatformError } from "./platform-error.js";

/**
 * Wraps any thrown value in an Error prefixed with context, preserving the original as `cause`.
 *
 * When the wrapped value is a {@link PlatformError}, the result is itself a `PlatformError`
 * carrying the same `code`, so wrapping at a boundary does not silently break `isPlatformError`
 * matching by code.
 */
export function wrap(prefix: string, err: unknown): Error {
  const message = `${prefix}: ${messageOf(err)}`;
  if (isPlatformError(err)) {
    return new PlatformError(err.code, message, { cause: err });
  }
  return new Error(message, { cause: err });
}
