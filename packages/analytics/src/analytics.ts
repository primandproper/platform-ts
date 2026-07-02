/** Free-form properties or traits attached to an analytics call. */
export type EventProperties = Record<string, unknown>;

/**
 * Ambient context for a call — who/where/what session it happened in. All fields optional;
 * providers attach what they understand and ignore the rest. Mirrors the common
 * Segment/PostHog/Rudderstack "context" envelope without coupling to any one SDK.
 */
export interface EventContext {
  /** The acting user, when known. Anonymous events omit this. */
  userId?: string;
  /** A stable anonymous/device identifier for pre-login events. */
  anonymousId?: string;
  /** Groups events into a session for funnel analysis. */
  sessionId?: string;
  /** Arbitrary additional context (page, campaign, locale, …). */
  extra?: EventProperties;
}

/**
 * The universal analytics contract. Every provider implements exactly this, so call-site
 * code is identical regardless of where it runs.
 *
 * Reporting is async-safe and best-effort: a dropped event must never throw. Providers log
 * failures via the injected logger rather than propagating them — analytics is observation,
 * not a transaction, and must never take down the calling path.
 */
export interface EventReporter {
  /** Records that something happened. */
  track(event: string, properties?: EventProperties, context?: EventContext): void;
  /** Associates a user with their traits. */
  identify(userId: string, traits?: EventProperties): void;
  /** Records a web page view. Optional — not every provider models pages. */
  page?(name: string, properties?: EventProperties, context?: EventContext): void;
  /** Records a mobile/app screen view. Optional — the native analogue of {@link page}. */
  screen?(name: string, properties?: EventProperties, context?: EventContext): void;
  /** Flushes any buffered events to the backing store. Never throws. */
  flush(): Promise<void>;
  /** Flushes and releases resources. The reporter is unusable afterwards. Never throws. */
  shutdown(): Promise<void>;
}
