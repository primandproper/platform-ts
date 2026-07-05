import type { ObservabilityDeps } from "@primandproper/observability";
import { AnalyticsBrowser } from "@segment/analytics-next";

import type { EventProperties, EventReporter } from "../analytics.js";
import type { SegmentConfig } from "../config.js";

import { VendorReporter } from "./vendor.js";

/**
 * The slice of the buffered `analytics-next` client the adapter calls. The SDK exposes these
 * through variadic overloads; narrowing to the concrete calls we make keeps the adapter readable.
 */
interface SegmentBrowserClient {
  track(event: string, properties?: EventProperties): unknown;
  identify(userId: string, traits?: EventProperties): unknown;
  page(name: string, properties?: EventProperties): unknown;
  screen(name: string, properties?: EventProperties): unknown;
}

/**
 * Builds a Segment-backed reporter over `@segment/analytics-next`. The browser SDK manages
 * anonymous identity itself (cookie/localStorage) and dispatches events as they occur, so per-event
 * ids are left to `identify()` and `flush`/`shutdown` are no-ops. Same factory signature as the Node
 * provider, so call-site code is portable across contexts.
 */
export function provideSegment(
  config: SegmentConfig,
  deps: ObservabilityDeps = {},
): EventReporter {
  const analytics = AnalyticsBrowser.load({
    writeKey: config.writeKey,
  }) as unknown as SegmentBrowserClient;
  return new VendorReporter(
    "segment",
    {
      track: (event, properties) => void analytics.track(event, properties),
      identify: (userId, traits) => void analytics.identify(userId, traits),
      page: (name, properties) => void analytics.page(name, properties),
      screen: (name, properties) => void analytics.screen(name, properties),
      flush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    deps,
  );
}
