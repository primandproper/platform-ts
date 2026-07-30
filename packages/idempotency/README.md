# @primandproper/idempotency

Runs work at most once per client-supplied key — the TypeScript port of platform-go's
`idempotency`.

It exists for the case where a client sends a request, never sees the response, retries, and the
work in between spent real money. Without a key the server cannot tell that second request apart
from a deliberate second purchase, so it charges the card twice.

## The client mints the key

This is the part most often read backwards. **The server never issues a key.** The client
generates one before its first attempt and reuses that same value on every retry of the same
logical operation:

```ts
import { idempotentFetch } from "@primandproper/idempotency";

const send = idempotentFetch(); // mints ONE key, OUTSIDE the retry loop

await policy.run(() => send("/charges", { method: "POST", body }));
```

The wrapper _is_ the key — that shape is deliberate. A key minted inside the retry loop is a new
key per attempt, which looks like protection and provides none; nothing on the server can detect
the mistake, because a retry and a deliberate duplicate are byte-identical. Making the key belong
to a wrapper you construct means the mistake is at least visible: the construction is what moved.

There is no round trip to acquire a key, because a request that times out never returns anything.

## What it guarantees

At-most-once **effect**, not exactly-once. The gap is worth naming:

- a recorded result is **replayed** instead of re-run;
- work that started and has not reported back is **refused**, because "did it happen?" is
  unanswerable and running it again is the worse guess;
- a key reused for a _different_ request is reported as a **mismatch** rather than answered with
  the earlier result.

What it cannot promise: work that has its effect and _then_ fails. The charge landed, the error
came back, nothing was recorded, and the retry charges again. Recording failures instead would be
worse — a transient error would be pinned for the whole TTL and the client could never succeed.
That is what `recordable` is for: a caller can say "that failure was ours, not theirs".

## Server side

```ts
import { provideCache } from "@primandproper/cache";
import { provideDistributedLock } from "@primandproper/distributedlock";
import {
  fingerprintRequest,
  parseIdempotencyKey,
  provideIdempotencyManager,
  IDEMPOTENCY_KEY_HEADER,
  type IdempotencyRecord,
} from "@primandproper/idempotency";

interface Receipt {
  chargeId: string;
  charged: boolean;
}

const manager = provideIdempotencyManager<Receipt>(
  { inFlightTtlMs: 120_000, ttlMs: 86_400_000 },
  {
    store: provideCache<IdempotencyRecord<Receipt>>({
      provider: "redis",
      redis: { url },
    }),
    lock: provideDistributedLock({ provider: "redis", redis: { url } }),
    recordable: (receipt) => receipt.charged,
    logger,
  },
);

const key = parseIdempotencyKey(req.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "");
const fingerprint = await fingerprintRequest({
  method: req.method,
  url: req.url,
  principal: user.id,
  body,
});

const result = await manager.run(key, fingerprint, () => charge(body));
switch (result.status) {
  case "executed":
  case "replayed":
    return json(result.value);
  case "in-flight":
    return status(409); // retry later; the answer is not knowable yet
  case "fingerprint-mismatch":
    return status(422); // a client bug, not a retry
}
```

The four outcomes are **returned, not thrown**: they are expected control flow, and the
discriminated union fits this repo's optional-over-sentinels stance better than Go's error
sentinels. Thrown `PlatformError`s (`idempotency/*` codes) are reserved for genuine failures — an
unusable key, an empty fingerprint, an unreachable record store under `fail-closed`.

## The claim protocol

1. read the record — replay, refuse, or continue;
2. lock → **re-read** → write an in-flight claim → unlock;
3. run the work **outside** the lock;
4. record the result, or release the claim.

The re-read inside the lock is what makes it correct: two callers that both missed the pre-lock
read would otherwise both claim, and the second would overwrite the first.

The obvious alternative — hold the lock for the whole execution and let the lock itself mean "in
flight" — is wrong for reasons that survive the port from Go:

- **A held lock is a held resource.** The postgres lock provider runs inside a transaction;
  holding it for the duration of the work means an open transaction per in-flight request — pool
  exhaustion, blocked vacuums, replication lag.
- **Lock keys can collide.** Postgres advisory locks fold a key into an int64, so unrelated keys
  can contend. Under a held lock a collision answers a legitimate request with a refusal; under a
  short one it costs a sub-millisecond wait (`lockWaitMs`).
- **Lock TTLs are shorter than real work.** Any work slower than the lease loses mutual exclusion
  _while still running_ — precisely the failure this package exists to prevent.
- **A lock leaves no evidence.** Kill a process mid-execution and the lock evaporates, so the
  retry runs the work again. A _record_ with its own TTL survives, and the retry is correctly
  refused until it expires.

Every execution therefore writes twice — a claim, then an outcome — and the claim carries a claim
id so that only its owner may complete or release it. That is what stops an execution which
outlived its claim from overwriting whoever re-claimed the key.

`withLock(lock, key, fn)` is exported for callers that want the acquire/run/release shape without
the manager. `DistributedLock.acquire` reports contention immediately rather than blocking, so it
retries for `waitMs` before reporting `{ acquired: false }`.

## Choosing TTLs

`inFlightTtlMs` is a **deadline for the work**, not a tuning knob. Set it above the worst case,
not the average — every execution slower than it can produce a duplicate. Two minutes suits a
request-shaped workload. It is also how long a client is refused after a process dies
mid-execution; with the outcome unknown, refusing is the conservative answer.

`ttlMs` is how long a client may usefully retry. A day is the common answer and matches what
payment providers publish. Endpoints that disagree do not need a manager each: `run` takes a
per-call `ttlMs`. There is deliberately no per-call `inFlightTtlMs` — it bounds how long a dead
process blocks a retry, which is a property of the deployment rather than of the call.

## Store failure policy

The two answers fail in opposite directions, so the choice belongs to the caller.
`fail-closed` (the default) refuses the request when the record store is unreachable: a brief
outage becomes downtime rather than duplicate charges, which is the right answer wherever the
guarded work costs money. `fail-open` runs the work anyway, trading the guarantee for
availability.

The policy covers **reads, claim writes, and lock failures** alike. (platform-go applies it to
reads only, so a `FailOpen` manager still rejects when the claim write fails; that is a divergence
this port makes deliberately — a policy that only holds for reads is not the promise its name
makes.)

## The locker matters

The noop locker acquires unconditionally. With it, replay still works — which covers the ordinary
timeout-then-retry case — but two genuinely concurrent requests can both claim and both execute.
The `lock` dep is required and has no default so that nobody arrives there by accident.

## Fingerprints

A fingerprint identifies _what_ the operation was, so a key reused for a different request can be
detected. `fingerprintRequest` covers method, path, **sorted** query, principal, and body; parts
are length-prefixed so they cannot run together (`/a` + `bc` must not hash like `/ab` + `c`).

`canonicalJson` is the canonicalisation: object keys sorted recursively, array order preserved,
`toJSON` honoured, `NaN`/`Infinity` as `null`. It exists because a false mismatch is a _rejected
legitimate retry_ — property order and re-serialisation must not change the answer.

Keys and fingerprints are branded string types. `run` takes one of each, adjacently, and as bare
strings a transposed pair would type-check and silently disable mismatch detection — a security
control failing open with no signal. Convert at the wire boundary with `parseIdempotencyKey`
(which also validates: printable, space-free ASCII, length-capped) and `asFingerprint`.

## Watching it

| Instrument                    | Watch it for                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| `idempotency.claims.lost`     | **The alert.** Work outran `inFlightTtlMs`; the claim was taken  |
| `idempotency.record.failures` | The effect happened, the record did not — a retry will re-run it |
| `idempotency.requests`        | By `outcome`; the four sum to the request total                  |
| `idempotency.store.errors`    | Store health                                                     |
| `idempotency.stale.records`   | Records ignored for another version; one spike per shape change  |

A steady stream of `in_flight` without matching `executed` usually means work is dying
mid-execution. `mismatch` is always a client bug. End-to-end latency comes from observability's
`operation.duration{operation="run"}`, so there is no second histogram here saying the same thing.

## Record versioning

Every record is stamped with `RECORD_VERSION`, and a record written by another version is
**ignored rather than misread** — it reads as a miss and the work re-runs. With a day-long TTL,
treating an unreadable record as an error would turn one bad deploy into a day of failures. Bump
`RECORD_VERSION` when the stored shape changes.

Keep `T` JSON-safe: the redis cache provider serialises with JSON, so `Date`/`Map`/`Set` do not
survive the round trip as themselves.

## The isomorphic split

The split is **asymmetric**, which is the one place this package departs from the usual
"identical factory on both sides" shape:

- `index.browser.ts` — key minting, fingerprints, and the `fetch` wrapper.
- `index.node.ts` — the same client half, plus `provideIdempotencyManager`.

A browser has no record store and no distributed lock, so a manager there could only pretend, and
a noop stand-in would be the worst possible shape: idempotency that looks wired up and guarantees
nothing. Importing `provideIdempotencyManager` from browser-resolved code is therefore a type
error, which is the intended feedback. The client half ships to the browser because that is where
the retrying client lives — which is where "mint outside the retry loop" actually gets broken.

## Not ported

The transport adapters (`idempotency/http`, `idempotency/grpc`) — server middleware, response
capture and replay, and the gRPC interceptors. This package knows nothing about HTTP beyond the
header name and `fingerprintRequest`; wiring it into a router is currently the caller's job.
