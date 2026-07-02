import { describe, expect, it } from "vitest";

import { provideFaker } from "./index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sequence(seed: number, n = 5): string[] {
  const fake = provideFaker({ seed });
  return Array.from({ length: n }, () => fake.fakeName());
}

describe("provideFaker", () => {
  it("defaults the locale and produces values", () => {
    const fake = provideFaker();
    expect(fake.fakeName()).toBeTypeOf("string");
    expect(fake.fakeName().length).toBeGreaterThan(0);
  });

  it("exposes the full underlying faker surface", () => {
    const fake = provideFaker({ seed: 1 });
    expect(fake.faker.number.int({ min: 1, max: 1 })).toBe(1);
    expect(fake.faker.color.rgb()).toBeTypeOf("string");
  });
});

describe("determinism", () => {
  it("yields an identical sequence for the same seed", () => {
    expect(sequence(42)).toStrictEqual(sequence(42));
  });

  it("yields (very likely) different sequences for different seeds", () => {
    expect(sequence(42)).not.toStrictEqual(sequence(43));
  });

  it("re-seeding resets the stream to a reproducible point", () => {
    const fake = provideFaker({ seed: 7 });
    const first = fake.fakeName();
    fake.seed(7);
    expect(fake.fakeName()).toBe(first);
  });

  it("matches a fresh seeded instance across all convenience generators", () => {
    const a = provideFaker({ seed: 99 });
    const b = provideFaker({ seed: 99 });
    expect(a.fakeId()).toBe(b.fakeId());
    expect(a.fakeUuid()).toBe(b.fakeUuid());
    expect(a.fakeEmail()).toBe(b.fakeEmail());
    expect(a.fakeName()).toBe(b.fakeName());
    expect(a.fakeUrl()).toBe(b.fakeUrl());
  });
});

describe("convenience generators", () => {
  const fake = provideFaker({ seed: 123 });

  it("fakeUuid returns a UUID", () => {
    expect(fake.fakeUuid()).toMatch(UUID_RE);
  });

  it("fakeEmail returns an address with an @", () => {
    expect(fake.fakeEmail()).toContain("@");
  });

  it("fakeUrl returns an http(s) URL", () => {
    expect(fake.fakeUrl()).toMatch(/^https?:\/\//);
  });

  it("fakeName returns a non-empty string", () => {
    expect(fake.fakeName().length).toBeGreaterThan(0);
  });

  it("fakeId returns a non-empty string", () => {
    expect(fake.fakeId().length).toBeGreaterThan(0);
  });
});
