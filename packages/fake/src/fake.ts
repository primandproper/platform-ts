import { Faker, en, en_GB, en_US, type LocaleDefinition } from "@faker-js/faker";

import type { FakeConfig, FakeLocale } from "./config.js";

export { Faker } from "@faker-js/faker";

const LOCALE_DEFINITIONS: Record<FakeLocale, LocaleDefinition> = {
  en,
  en_US,
  en_GB,
};

/**
 * A configured faker plus a small curated face of convenience generators.
 * `faker` exposes the full underlying surface; the `fake*` helpers mirror common
 * platform needs.
 */
export interface Fake {
  /** The underlying faker instance — full `@faker-js/faker` surface. */
  readonly faker: Faker;
  /** Re-seed the instance; same seed always yields the same subsequent sequence. */
  seed(seed: number): void;
  fakeId(): string;
  fakeUuid(): string;
  fakeEmail(): string;
  fakeName(): string;
  fakeUrl(): string;
}

class FakeImpl implements Fake {
  readonly faker: Faker;

  constructor(faker: Faker) {
    this.faker = faker;
  }

  seed(seed: number): void {
    this.faker.seed(seed);
  }

  fakeId(): string {
    return this.faker.string.nanoid();
  }

  fakeUuid(): string {
    return this.faker.string.uuid();
  }

  fakeEmail(): string {
    return this.faker.internet.email();
  }

  fakeName(): string {
    return this.faker.person.fullName();
  }

  fakeUrl(): string {
    return this.faker.internet.url();
  }
}

/** Builds a {@link Fake} from validated config. The analogue of Go's seeded `gofakeit`. */
export function newFake(config: FakeConfig): Fake {
  const faker = new Faker({ locale: [LOCALE_DEFINITIONS[config.locale]] });
  if (config.seed !== undefined) {
    faker.seed(config.seed);
  }
  return new FakeImpl(faker);
}
