# @primandproper/analytics

## 0.1.1

### Patch Changes

- a124406: Add an optional `options` argument to `VendorReporter` (with `VendorReporterOptions`, background-error handling, and a default timeout).
- Updated dependencies [a124406]
  - @primandproper/observability@0.1.0

## 0.1.0

### Minor Changes

- db7c3ec: add vendor providers to `@primandproper/analytics`, porting the SDK-backed providers from
  `platform-go/analytics`. Segment and PostHog ship as isomorphic pairs behind an identical
  `provideAnalytics` signature — `@segment/analytics-node`/`posthog-node` on the server and
  `@segment/analytics-next`/`posthog-js` in the browser, resolved by the package's conditional
  `exports` — so call-site code is portable across contexts. Adds a `MultiSourceReporter` that routes
  events to a per-source reporter and stamps the source onto every event (Go's `multisource`), plus a
  `provideMultiSourceAnalytics` builder. Every provider is best-effort: an SDK failure is logged via
  the injected observer and never propagated. Rudderstack was intentionally skipped (its Node SDK has
  no browser sibling and its API duplicates Segment's).
