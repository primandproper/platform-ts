import { messageOf } from "./message.js";

/** Wraps any thrown value in an Error prefixed with context, preserving the original as `cause`. */
export function wrap(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${messageOf(err)}`, { cause: err });
}
