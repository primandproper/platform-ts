import { z } from "zod";

import { DEFAULT_BUFFER_SIZE, DEFAULT_FLUSH_INTERVAL_MS } from "./recorder.js";

/** Rotation threshold for the JSONL sink when unset: 64 MiB. */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Retained rotated-file count for the JSONL sink when unset. */
export const DEFAULT_MAX_FILES = 8;
/** Records the beacon sink batches before it POSTs without waiting for a tick. */
export const DEFAULT_MAX_BATCH = 100;

/** The recorder knobs, identical in both environments. */
const BaseCaptureConfigSchema = z.object({
  /** Caps the in-flight event buffer; a full buffer drops (and counts) new events. */
  bufferSize: z.number().int().positive().default(DEFAULT_BUFFER_SIZE),
  /** Flush cadence in milliseconds. */
  flushIntervalMs: z.number().int().positive().default(DEFAULT_FLUSH_INTERVAL_MS),
  /** Whether each consumed event is itself written, or only records emitted on flush. */
  rawRecords: z.boolean().default(true),
});

/** Configures the Node JSONL file sink. */
export const JsonlSinkConfigSchema = z.object({
  /** The live file's location; parent directories are created as needed. */
  path: z.string().min(1),
  /** Size at which the live file rotates aside. */
  maxBytes: z.number().int().positive().default(DEFAULT_MAX_BYTES),
  /** How many rotated files are retained; older ones are pruned. */
  maxFiles: z.number().int().positive().default(DEFAULT_MAX_FILES),
});

export type JsonlSinkConfig = z.infer<typeof JsonlSinkConfigSchema>;
export type JsonlSinkConfigInput = z.input<typeof JsonlSinkConfigSchema>;

/** Configures the browser beacon sink. */
export const BeaconSinkConfigSchema = z.object({
  /** Collection endpoint; each flush POSTs a JSON array of records to it. */
  url: z.string().url(),
  /** Records batched before a POST goes out without waiting for a flush tick. */
  maxBatch: z.number().int().positive().default(DEFAULT_MAX_BATCH),
  /** Extra headers on every POST (auth, tenant, …). */
  headers: z.record(z.string()).default({}),
});

export type BeaconSinkConfig = z.infer<typeof BeaconSinkConfigSchema>;
export type BeaconSinkConfigInput = z.input<typeof BeaconSinkConfigSchema>;

/** Node capture config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`. */
export const NodeEventCaptureConfigSchema = BaseCaptureConfigSchema.extend({
  provider: z.enum(["noop", "memory", "jsonl"]).default("noop"),
  jsonl: JsonlSinkConfigSchema.optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.provider === "jsonl" && cfg.jsonl === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["jsonl"],
      message: "jsonl config is required when provider is 'jsonl'",
    });
  }
});

export type NodeEventCaptureConfig = z.infer<typeof NodeEventCaptureConfigSchema>;
export type NodeEventCaptureConfigInput = z.input<typeof NodeEventCaptureConfigSchema>;

/**
 * Browser capture config. `noop` and `memory` mean the same thing they do on Node; the durable
 * sink is a `fetch` beacon rather than a file, because that is what durability looks like from
 * a browser.
 */
export const BrowserEventCaptureConfigSchema = BaseCaptureConfigSchema.extend({
  provider: z.enum(["noop", "memory", "beacon"]).default("noop"),
  beacon: BeaconSinkConfigSchema.optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.provider === "beacon" && cfg.beacon === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["beacon"],
      message: "beacon config is required when provider is 'beacon'",
    });
  }
});

export type BrowserEventCaptureConfig = z.infer<typeof BrowserEventCaptureConfigSchema>;
export type BrowserEventCaptureConfigInput = z.input<
  typeof BrowserEventCaptureConfigSchema
>;
