import { IdentifierConfigSchema, type IdentifierConfigInput } from "./config.js";
import type { IdentifierGenerator } from "./generator.js";
import { nanoidGenerator, type NanoidDeps } from "./nanoid.js";
import { ulidGenerator, type UlidDeps } from "./ulid.js";

export * from "./config.js";
export * from "./generator.js";
export * from "./nanoid.js";
export * from "./ulid.js";

/** Injectable randomness/clock for whichever scheme `provideIdentifierGenerator` builds. */
export type IdentifierDeps = NanoidDeps & UlidDeps;

/** Validates config (applying defaults) and returns the configured {@link IdentifierGenerator}. */
export function provideIdentifierGenerator(
  config?: IdentifierConfigInput,
  deps: IdentifierDeps = {},
): IdentifierGenerator {
  const parsed = IdentifierConfigSchema.parse(config ?? {});
  switch (parsed.scheme) {
    case "ulid":
      return ulidGenerator(deps);
    case "nanoid":
      return nanoidGenerator(parsed, deps);
  }
}
