import { describe, expect, it } from "vitest";

import {
  BrowserEventCaptureConfigSchema,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  NodeEventCaptureConfigSchema,
} from "./config.js";
import { DEFAULT_BUFFER_SIZE, DEFAULT_FLUSH_INTERVAL_MS } from "./recorder.js";

describe("capture config", () => {
  it("defaults to a disabled pipeline with the standard knobs", () => {
    const cfg = NodeEventCaptureConfigSchema.parse({});
    expect(cfg).toEqual({
      provider: "noop",
      bufferSize: DEFAULT_BUFFER_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      rawRecords: true,
    });
  });

  it("shares its knobs across environments, so a config is portable", () => {
    const node = NodeEventCaptureConfigSchema.parse({
      bufferSize: 8,
      flushIntervalMs: 100,
    });
    const browser = BrowserEventCaptureConfigSchema.parse({
      bufferSize: 8,
      flushIntervalMs: 100,
    });
    expect(browser.bufferSize).toBe(node.bufferSize);
    expect(browser.flushIntervalMs).toBe(node.flushIntervalMs);
    expect(browser.rawRecords).toBe(node.rawRecords);
  });

  it("requires the jsonl block when the jsonl provider is selected", () => {
    expect(() => NodeEventCaptureConfigSchema.parse({ provider: "jsonl" })).toThrow(
      /jsonl config is required/,
    );
    const cfg = NodeEventCaptureConfigSchema.parse({
      provider: "jsonl",
      jsonl: { path: "/tmp/capture.jsonl" },
    });
    expect(cfg.jsonl).toEqual({
      path: "/tmp/capture.jsonl",
      maxBytes: DEFAULT_MAX_BYTES,
      maxFiles: DEFAULT_MAX_FILES,
    });
  });

  it("requires the beacon block when the beacon provider is selected", () => {
    expect(() => BrowserEventCaptureConfigSchema.parse({ provider: "beacon" })).toThrow(
      /beacon config is required/,
    );
    const cfg = BrowserEventCaptureConfigSchema.parse({
      provider: "beacon",
      beacon: { url: "https://collect.example/capture" },
    });
    expect(cfg.beacon?.maxBatch).toBe(100);
    expect(cfg.beacon?.headers).toEqual({});
  });

  it("rejects knobs that would make the pipeline nonsensical", () => {
    expect(() => NodeEventCaptureConfigSchema.parse({ bufferSize: 0 })).toThrow();
    expect(() => NodeEventCaptureConfigSchema.parse({ flushIntervalMs: -1 })).toThrow();
    expect(() =>
      NodeEventCaptureConfigSchema.parse({ provider: "jsonl", jsonl: { path: "" } }),
    ).toThrow();
    expect(() =>
      BrowserEventCaptureConfigSchema.parse({
        provider: "beacon",
        beacon: { url: "nope" },
      }),
    ).toThrow();
  });

  it("does not offer the other environment's provider", () => {
    expect(() => NodeEventCaptureConfigSchema.parse({ provider: "beacon" })).toThrow();
    expect(() => BrowserEventCaptureConfigSchema.parse({ provider: "jsonl" })).toThrow();
  });
});
