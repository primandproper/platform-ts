# @primandproper/eventcapture

Isomorphic high-volume event capture — the TypeScript port of platform-go's `eventcapture`.

Records operational events for offline analysis (model training data, usage matrices,
replayable traces) **without ever slowing or breaking the thing being measured**. It is
distinct from `@primandproper/analytics` (low-volume product events to PostHog/Segment) and
heavier than logging: the write path here is designed for one event per served request.

## The contract

- `record(event)` is a **non-blocking bounded-buffer push**. It never blocks, never awaits, and
  never throws. A full buffer **drops the event and counts it** rather than growing without
  bound or making a caller wait.
- A single drain chain consumes the buffer off the hot path and writes through a pluggable
  `Sink`.
- **Sink failures are never surfaced to the caller** — the caller did not ask for a write to
  succeed, it asked to record something.

Both of those mean the instruments are the only way to learn the pipeline has broken. Without
them, a silently broken capture pipeline looks exactly like a quiet one.

| Instrument                          | Watch it for                                        |
| ----------------------------------- | --------------------------------------------------- |
| `eventcapture.records.written`      | Throughput actually reaching the sink               |
| `eventcapture.records.dropped`      | Producers outrunning the drain — raise `bufferSize` |
| `eventcapture.sink.errors`          | The sink is rejecting records (tagged `stage`)      |
| `eventcapture.aggregation.overflow` | A composition hit its key bound                     |
| `eventcapture.hook.errors`          | A `transform`/`observe`/`onFlush` hook threw        |
| `eventcapture.flush.latency`        | How long a flush takes                              |

Drops are counted with a plain increment on the hot path and reported to the instrument at
flush time, so `record` never pays for an instrument call. Flushes are **not** traced — a root
span every few seconds parented to nothing is noise — but `close` is, since abandoning a drain
at shutdown loses captured events.

## Usage

```ts
import { provideEventRecorder } from "@primandproper/eventcapture";

interface RequestEvent {
  route: string;
  ms: number;
}

const recorder = provideEventRecorder<RequestEvent>(
  { provider: "jsonl", jsonl: { path: "/var/log/capture/requests.jsonl" } },
  { logger, metrics },
  { transform: (e) => ({ r: e.route, d: e.ms }) },
);

// …on the hot path, one event per served request:
recorder.record({ route: "/checkout", ms: 12 });

// …after the server has stopped serving. Close drains the tail, runs a final flush, and closes
// the sink — losing the tail on shutdown defeats the point.
await recorder.close();
```

`close` takes an optional `AbortSignal` as its deadline; abandoning the drain rejects with a
`PlatformError` coded `eventcapture/close-aborted`, so a shutdown that gave up on captured
events says so.

## Aggregation

`Aggregator` folds events into per-(key, time-bucket) counters for consumers that want densities
instead of (or alongside) raw events. The cell map is **bounded**, and observations dropped at
the bound are counted — a capture pipeline that quietly discards data because a map filled up is
the failure mode this is shaped to make visible.

Compose it through the three hooks that run on the drain chain, so it needs no locking of its
own. Turn `rawRecords` off when only the rollups matter — the difference between a usable
aggregation and one that doubles your write volume.

```ts
const hits = new Aggregator<string, number>({ bucketMs: 60_000, maxKeys: 10_000 });

const recorder = provideEventRecorder<RequestEvent>(
  { provider: "jsonl", jsonl: { path } },
  deps,
  {
    observe: (e) => hits.observe(e.route, new Date(), (c) => (c ?? 0) + 1),
    onFlush: (now, final, emit) => {
      for (const b of hits.flush(now, final)) {
        emit({ start: b.start.toISOString(), route: b.key, hits: b.counts });
      }
    },
    overflow: () => hits.takeOverflow(),
  },
);
```

## Modality: isomorphic

The Go package is server-only, but the pattern — bounded buffer, drop on full, background
flush, never throw at the caller — is exactly what frontend telemetry batching needs. So the
recorder, the aggregator, and the `noop`/`memory` sinks are universal, and the durable sink is
per-environment behind an identical factory signature:

| Environment | Providers                  | Durable sink                                                |
| ----------- | -------------------------- | ----------------------------------------------------------- |
| Node        | `noop`, `memory`, `jsonl`  | Append-only, size-rotated newline-delimited JSON file       |
| Browser     | `noop`, `memory`, `beacon` | Batched `fetch` POSTs, `sendBeacon` for the tail on `close` |

Both default to `noop`, so capture can be wired everywhere and enabled where it earns its keep.

## Divergences from platform-go

- **One options bag.** Go splits "generic option" from "option that needs the event type"
  because it cannot infer a type argument from a call's result type. TypeScript can, so
  `transform`/`observe` are ordinary fields that infer from the recorder's event type — and a
  mismatched hook is a compile error rather than the runtime `ErrEventTypeMismatch` Go needs.
- **No `Run` loop.** Go's flusher is a goroutine the owner starts. Here the drain is a promise
  chain scheduled by `record` plus a flush timer, so there is nothing to start — construct and
  record. The timer is `unref`'d on Node: a capture pipeline must not be the reason a process
  refuses to exit.
- **`Aggregator` keys are `string | number`.** Go's `comparable` covers structs; a JS `Map`
  keyed by object compares by reference, so a struct key would silently never coalesce. Project
  a composite key into a string instead.
- **`observe` folds by return value** (`(current: C | undefined) => C`) rather than mutating a
  zero value, because TypeScript has no `new(C)`.
- **Sinks are async.** Every I/O path in JavaScript is; the recorder awaits them on the drain
  chain, one at a time, so implementations still need no internal locking.
