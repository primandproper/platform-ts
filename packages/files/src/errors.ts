import { PlatformError } from "@primandproper/errors";

/** Thrown when a chunk size is zero or negative. */
export class NonPositiveChunkSizeError extends PlatformError {
  constructor() {
    super("files/non-positive-chunk-size", "chunk size must be greater than zero");
    this.name = "NonPositiveChunkSizeError";
  }
}

/** Thrown when a line offset is negative. */
export class NegativeOffsetError extends PlatformError {
  constructor() {
    super("files/negative-offset", "offset must not be negative");
    this.name = "NegativeOffsetError";
  }
}

/** Thrown when a line count is negative. */
export class NegativeCountError extends PlatformError {
  constructor() {
    super("files/negative-count", "count must not be negative");
    this.name = "NegativeCountError";
  }
}

/** Thrown when a slice offset lands at or past the end of the input. */
export class OffsetBeyondEofError extends PlatformError {
  constructor() {
    super("files/offset-beyond-eof", "offset is at or beyond end of input");
    this.name = "OffsetBeyondEofError";
  }
}

/** Thrown by {@link Files.decode} when the file is empty. */
export class EmptyInputError extends PlatformError {
  constructor() {
    super("files/empty-input", "cannot decode empty input");
    this.name = "EmptyInputError";
  }
}

/** Thrown when a name resolves outside its {@link Dir} base (e.g. via `..` or an absolute path). */
export class PathEscapesBaseError extends PlatformError {
  constructor(name: string) {
    super("files/path-escapes-base", `name escapes directory base: ${name}`);
    this.name = "PathEscapesBaseError";
  }
}
