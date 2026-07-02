import type { EventContext, EventProperties, EventReporter } from "../analytics.js";

/** A captured {@link EventReporter.track} call. */
export interface TrackCall {
  event: string;
  properties: EventProperties | undefined;
  context: EventContext | undefined;
}

/** A captured {@link EventReporter.identify} call. */
export interface IdentifyCall {
  userId: string;
  traits: EventProperties | undefined;
}

/** A captured {@link EventReporter.page} or {@link EventReporter.screen} call. */
export interface PageCall {
  name: string;
  properties: EventProperties | undefined;
  context: EventContext | undefined;
}

/**
 * Universal reporter that records every call into public arrays. The default test/conformance
 * double — assert against {@link tracks}, {@link identifies}, {@link pages}, {@link screens},
 * and {@link flushes} instead of mocking an SDK.
 */
export class InMemoryReporter implements EventReporter {
  readonly tracks: TrackCall[] = [];
  readonly identifies: IdentifyCall[] = [];
  readonly pages: PageCall[] = [];
  readonly screens: PageCall[] = [];
  /** Count of {@link flush} calls, including the implicit one in {@link shutdown}. */
  flushes = 0;
  /** Whether {@link shutdown} has been called. */
  isShutdown = false;

  track(event: string, properties?: EventProperties, context?: EventContext): void {
    this.tracks.push({ event, properties, context });
  }

  identify(userId: string, traits?: EventProperties): void {
    this.identifies.push({ userId, traits });
  }

  page(name: string, properties?: EventProperties, context?: EventContext): void {
    this.pages.push({ name, properties, context });
  }

  screen(name: string, properties?: EventProperties, context?: EventContext): void {
    this.screens.push({ name, properties, context });
  }

  flush(): Promise<void> {
    this.flushes += 1;
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    await this.flush();
    this.isShutdown = true;
  }
}
