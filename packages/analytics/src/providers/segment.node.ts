import type { ObservabilityDeps } from "@primandproper/observability";
import { Analytics } from "@segment/analytics-node";

import type { EventContext, EventReporter } from "../analytics.js";
import type { SegmentConfig } from "../config.js";

import { VendorReporter } from "./vendor.js";

/** Segment requires an identifier on every event; used when the caller supplies neither. */
const FALLBACK_ANONYMOUS_ID = "anonymous";

/** Resolves the Segment identity fields from call context (Segment requires one of the two). */
function identity(context: EventContext | undefined): { userId: string } | { anonymousId: string } {
  if (context?.userId) {
    return { userId: context.userId };
  }
  return { anonymousId: context?.anonymousId ?? FALLBACK_ANONYMOUS_ID };
}

/**
 * Builds a Segment-backed reporter over `@segment/analytics-node`. Each event carries the caller's
 * `userId` or `anonymousId` from context (a synthetic anonymous id is used when neither is present).
 * `flush()` drains the buffer without closing; `shutdown()` closes and flushes. Mirrors the Go
 * platform's Segment provider.
 */
export function provideSegment(config: SegmentConfig, deps: ObservabilityDeps = {}): EventReporter {
  const analytics = new Analytics({ writeKey: config.writeKey });
  return new VendorReporter(
    "segment",
    {
      track(event, properties, context) {
        analytics.track({ event, ...(properties ? { properties } : {}), ...identity(context) });
      },
      identify(userId, traits) {
        analytics.identify({ userId, ...(traits ? { traits } : {}) });
      },
      page(name, properties, context) {
        analytics.page({ name, ...(properties ? { properties } : {}), ...identity(context) });
      },
      screen(name, properties, context) {
        analytics.screen({ name, ...(properties ? { properties } : {}), ...identity(context) });
      },
      flush: () => analytics.flush(),
      shutdown: () => analytics.closeAndFlush(),
    },
    deps,
  );
}
