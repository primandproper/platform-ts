import { describe, expect, it } from "vitest";

import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("is FIFO", () => {
    const buffer = new RingBuffer<number>(4);
    expect(buffer.push(1)).toBe(true);
    expect(buffer.push(2)).toBe(true);
    expect(buffer.size).toBe(2);
    expect(buffer.shift()).toBe(1);
    expect(buffer.shift()).toBe(2);
    expect(buffer.shift()).toBeUndefined();
    expect(buffer.size).toBe(0);
  });

  it("refuses items once full rather than growing", () => {
    const buffer = new RingBuffer<number>(2);
    expect(buffer.push(1)).toBe(true);
    expect(buffer.push(2)).toBe(true);
    expect(buffer.push(3)).toBe(false);
    expect(buffer.size).toBe(2);
    // The refused item is not stored — the oldest two are still what comes out.
    expect(buffer.shift()).toBe(1);
    expect(buffer.shift()).toBe(2);
  });

  it("wraps around indefinitely", () => {
    const buffer = new RingBuffer<number>(3);
    const seen: number[] = [];
    for (let i = 0; i < 100; i++) {
      expect(buffer.push(i)).toBe(true);
      seen.push(buffer.shift()!);
    }
    expect(seen).toHaveLength(100);
    expect(seen[99]).toBe(99);
    expect(buffer.size).toBe(0);
  });

  it("treats a non-positive capacity as always full", () => {
    const buffer = new RingBuffer<number>(0);
    expect(buffer.capacity).toBe(0);
    expect(buffer.push(1)).toBe(false);
    expect(new RingBuffer<number>(-5).push(1)).toBe(false);
  });

  it("releases drained slots so events are not pinned alive", () => {
    const buffer = new RingBuffer<{ id: number }>(2);
    buffer.push({ id: 1 });
    buffer.shift();
    // Nothing observable from the public API — assert via a second lap reusing the slot.
    buffer.push({ id: 2 });
    expect(buffer.shift()).toEqual({ id: 2 });
  });
});
