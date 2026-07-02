import { z } from "zod";

/**
 * Event-stream config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`.
 * The transports are identical across Node and the browser — only the default underlying
 * constructor differs — so a single universal schema serves both factories.
 */
export const EventStreamConfigSchema = z
  .object({
    transport: z.enum(["sse", "websocket", "noop"]).default("noop"),
    /** The endpoint URL. Required for the `sse` and `websocket` transports. */
    url: z.string().url().optional(),
    /** SSE-only: named events to subscribe to so {@link EventStream.on} receives them. */
    events: z.array(z.string()).default([]),
    /** WebSocket-only: subprotocol(s) passed through to the constructor. */
    protocols: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.transport !== "noop" && cfg.url === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: `url is required when transport is '${cfg.transport}'`,
      });
    }
  });

export type EventStreamConfig = z.infer<typeof EventStreamConfigSchema>;
export type EventStreamConfigInput = z.input<typeof EventStreamConfigSchema>;
