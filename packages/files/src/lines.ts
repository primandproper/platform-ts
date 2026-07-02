import {
  NegativeCountError,
  NegativeOffsetError,
  NonPositiveChunkSizeError,
  OffsetBeyondEofError,
} from "./errors.js";

/**
 * Splits text into lines, stripping the line terminator (`\n` or `\r\n`). A trailing newline does
 * not produce an empty final line, but an unterminated final line is kept — matching platform-go's
 * `Lines`. Empty input yields an empty array.
 */
export function splitLines(content: string): string[] {
  if (content === "") return [];
  const parts = content.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Groups `lines` into slices of up to `size`; the final slice may be shorter. */
export function chunkLines(lines: readonly string[], size: number): string[][] {
  if (size <= 0) throw new NonPositiveChunkSizeError();
  const chunks: string[][] = [];
  for (let i = 0; i < lines.length; i += size) {
    chunks.push(lines.slice(i, i + size));
  }
  return chunks;
}

/**
 * Skips `offset` lines and returns up to `count` of the rest. `count` of `0` returns an empty array;
 * an `offset` at or past the end throws {@link OffsetBeyondEofError}; fewer than `count` remaining
 * returns a shorter array. Mirrors platform-go's `SliceLines`.
 */
export function sliceLinesFrom(content: string, offset: number, count: number): string[] {
  if (offset < 0) throw new NegativeOffsetError();
  if (count < 0) throw new NegativeCountError();
  if (count === 0) return [];
  const lines = splitLines(content);
  if (offset >= lines.length) throw new OffsetBeyondEofError();
  return lines.slice(offset, offset + count);
}
