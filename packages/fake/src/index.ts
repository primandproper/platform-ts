import { FakeConfigSchema, type FakeConfigInput } from "./config.js";
import { newFake, type Fake } from "./fake.js";

export * from "./config.js";
export * from "./fake.js";

/** Validates config (applying defaults) and returns a configured, optionally seeded {@link Fake}. */
export function provideFaker(config?: FakeConfigInput): Fake {
  return newFake(FakeConfigSchema.parse(config ?? {}));
}
