# @primandproper/files

Server-only filesystem helpers: line iteration, chunking, slicing, streaming, and typed decode.
The TypeScript port of platform-go's `files`.

## Usage

```ts
import {
  allLines,
  chunks,
  sliceLines,
  decodeFile,
  Files,
  Dir,
} from "@primandproper/files";

// Package-level helpers (observability-free).
const lines = await allLines("notes.txt");
const window = await sliceLines("big.log", 100, 20); // skip 100, take 20

for await (const batch of chunks("big.log", 1000)) {
  // process up to 1000 lines at a time, constant memory
}

const config = await decodeFile<Config>("config.yaml", "application/yaml");

// Instrumented reader: pass observability deps to span eager/decode reads.
const files = new Files({ logger });
for await (const line of files.lines("notes.txt")) console.log(line);

// A directory handle scopes reads to a base dir.
const dir = await Dir.open("/etc/app");
const settings = await dir.decode("settings.json");
```

## Behavior

- Line terminators (`\n` / `\r\n`) are stripped; a trailing newline does not yield an empty final
  line, but an unterminated final line is kept.
- `sliceLines` reads no further than needed; an offset at/past EOF throws `OffsetBeyondEofError`.
- Decoding goes through `@primandproper/encoding` (JSON/YAML/XML/TOML); empty files throw
  `EmptyInputError`.
