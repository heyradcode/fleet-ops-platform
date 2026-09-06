# Event-Driven Logistics Platform

> **Scope of this document.** An architecture write-up expressed in the AWS
> serverless vocabulary used by the reference implementation in this repository.
> Illustrative sizing assumptions are marked *(assumption)*. Replace those, and
> any service choice that differs from what was actually built, before using
> this anywhere it will be read as a record.

A distributed event-driven platform for real-time optimisation and intelligent
package routing across enterprise logistics infrastructure.

The framing that makes the architecture follow: **a package is not a row that
gets updated — it is a stream of events, and its current state is a projection
of that stream.** Everything else in this document is a consequence of taking
that seriously.

---

## Why event-driven, specifically

Logistics has three properties that make request/response architectures hurt:

1. **Facts arrive out of order and more than once.** A handheld scanner buffers
   offline and flushes an hour later. A sortation belt and a dock scanner both
   report the same movement. A customs event lands before the export scan it
   logically follows.
2. **Consumers multiply.** One "package scanned" fact is interesting to routing,
   customer notification, billing, capacity planning, exception detection and
   analytics. Wiring the producer to six consumers means the producer changes
   every time a seventh appears.
3. **The interesting questions are temporal.** "Where is it now" is easy. "Was
   this misrouted, and where did it diverge from plan" needs history.

Event sourcing answers all three. Ordering is handled by partitioning rather
than by hope; duplicates are handled by idempotent projection; consumers
subscribe rather than being wired in; and history is the substrate, not
something you bolt on later.

---

## Architecture

```
  scanners · sortation · vehicles · partner carriers · customs · EDI feeds
        │         │           │            │             │        │
        └─────────┴───────────┴──────┬─────┴─────────────┴────────┘
                                     │  many formats, many vendors
                          ┌──────────▼──────────┐
                          │  Ingest + normalise │  vendor payload → canonical
                          │  (Lambda per source)│  PackageEvent
                          └──────────┬──────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
            ┌───────▼────────┐              ┌─────────▼─────────┐
            │  S3 raw (bronze)│             │  Kinesis / Kafka  │
            │  replay source  │             │  ordered by       │
            │                 │             │  trackingId       │
            └─────────────────┘             └─────────┬─────────┘
                                                      │
                    ┌─────────────────────────────────┼──────────────────┐
                    │                                 │                  │
          ┌─────────▼─────────┐            ┌──────────▼───────┐  ┌───────▼──────┐
          │  State projection │            │  Routing engine  │  │  Exception   │
          │  DynamoDB         │            │  Step Functions  │  │  detection   │
          │  event log + view │            │  + optimisation  │  │              │
          └─────────┬─────────┘            └──────────┬───────┘  └───────┬──────┘
                    │                                 │                  │
                    │        DynamoDB Streams         │                  │
                    │        (transactional outbox)   │                  │
                    └────────────────┬────────────────┴──────────────────┘
                                     │
                          ┌──────────▼──────────┐
                          │     EventBridge     │   content-based routing
                          └──┬────┬────┬────┬───┘
                             │    │    │    │
                  notification│    │    │    └──▶ analytics (Firehose → S3)
                       billing┘    │    └──▶ capacity planning
                                   └──▶ AppSync subscriptions (live tracking)

          ┌──────────────────────────────────────────────────────┐
          │  Aurora PostGIS — service areas, facility geometry,  │
          │  route corridors, geofences, spatial optimisation    │
          └──────────────────────────────────────────────────────┘
```

---

## How the reference implementation maps onto this

| Reference file | Logistics equivalent |
|---|---|
| `src/integrations/connector.ts` | Source adapters — scanners, EDI, partner carriers. One `normalise()` per source, pure and replayable. |
| `src/platform/types.ts` (`Signal`) | The canonical `PackageEvent`. Eight input dialects, one downstream schema. |
| `src/platform/ids.ts` | Content-hash idempotency — the reason duplicate scans are harmless. |
| `src/aws/s3.ts` | The bronze layer. Archive raw before transforming, so a mapping bug is replayable. |
| `src/pipeline/steps.ts` (`detectIncidents`) | Exception detection — corroboration across independent sources before raising. |
| `src/aws/eventbridge.ts` | The fan-out, with per-target retry and DLQs. |
| `src/aws/stepfunctions.ts` | Routing decisions and exception sagas, with per-step retry and compensation. |
| `src/geo/*` + `src/data/schema.sql` | Service areas, geofences, `ST_DWithin` for nearest-facility, TopoJSON for territory polygons. |
| `src/api/subscriptions.ts` | Live tracking pushed to clients, filtered server-side. |

---

## The seven hard parts

### 1. Idempotency — the one that must be right

Every delivery guarantee in the stack is **at-least-once**. Kinesis re-delivers
on a failed checkpoint, Lambda retries, EventBridge retries, a scanner flushes a
buffer twice. Chasing exactly-once *delivery* is a losing game; make the
*effect* idempotent instead.

```
eventId = sha256(source | deviceId | trackingId | eventType | occurredAt)
```

The same physical fact always produces the same id, so a duplicate write
overwrites identical bytes. For projections, a conditional write
(`attribute_not_exists`) or a monotonic sequence check makes reprocessing safe.

The rule: **make writes idempotent, then stop worrying about duplicates.**

→ `src/platform/ids.ts`, and the test proving re-ingestion yields identical ids

### 2. Ordering — partition, don't sequence

Global ordering across a logistics network is neither achievable nor needed.
What matters is ordering **per package**.

Partition the stream by `trackingId`. Within a partition, order is guaranteed;
across partitions, nobody cares. That is also why the hot-partition question
matters — see scale, below.

Even so, **out-of-order still happens** (a buffered scanner flushes late), so
projections carry the event's `occurredAt` and refuse to apply a fact older than
the state they already hold. Last-writer-wins on *arrival* time is a bug;
last-writer-wins on *event* time is a design.

### 3. Event-time vs processing-time

Two different timestamps, and conflating them causes the subtlest bugs in the
system:

| | Meaning | Used for |
|---|---|---|
| `occurredAt` | When the fact happened, per the source | Business logic, ordering, SLA |
| `ingestedAt` | When we learned about it | Lag monitoring, replay windows |

Late data is normal, not exceptional. Analytics windows need a watermark and a
declared lateness tolerance; SLA calculations use event time or they punish the
network for our ingest lag.

### 4. Exactly-once *publishing* — the transactional outbox

There is a race everyone hits: write the state, then publish the event. If the
publish fails, the state moved and nobody heard. If you publish first, a
subscriber can query and get a 404.

The rigorous fix is the **transactional outbox**: write the state change and its
event in the *same* DynamoDB transaction, and let a DynamoDB Streams handler do
the publishing. The write and the announcement can no longer diverge, because
they are one commit.

The reference implementation notes this and takes the pragmatic path
(`putSignals` then `putEvents`, write-before-publish) with a comment explaining
the trade-off. At logistics volume, the outbox earns its complexity.

→ `src/pipeline/steps.ts` (`publish`), `modules/dynamodb` (`stream_enabled`)

### 5. Sagas, not distributed transactions

Rerouting a package touches routing, capacity, customer notification and
billing. There is no two-phase commit across those, and you would not want one.

Step Functions models the saga explicitly: each step has its retry policy, and
each has a **compensating action** on failure. The state machine *is* the
documentation of what happens when step four fails — which is worth more at 3am
than any diagram.

Two ASL features that matter here:

- `Retry` with `JitterStrategy: FULL` — without jitter, every branch throttled
  at the same instant retries at the same instant and recreates the spike.
- `Catch` to a compensation branch, so a partial reroute unwinds instead of
  leaving a package in a state no query understands.

### 6. Schema evolution

Events are immutable and long-lived; your consumers are not. A schema registry
with **compatibility rules enforced in CI** is the difference between a platform
and a minefield:

- Additive changes only within a major version. New fields optional, with
  defaults.
- Never repurpose a field name. A field that changes meaning is a new field.
- Consumers ignore unknown fields rather than rejecting them.
- The version is on the envelope, and replay honours it — a five-year-old event
  must still be readable by today's code, or your bronze layer is decorative.

### 7. Backpressure

A sortation surge is not an outage, but it will find your weakest downstream
dependency. Defences, in order of preference:

- **Reserved concurrency** on consumer Lambdas, so one hot consumer cannot
  consume the account pool and starve customer-facing APIs.
- **Circuit breakers** on partner carrier and customs APIs — when a vendor is
  down, stop calling it; you are burning duration on timeouts and adding load to
  someone else's incident.
- **DLQs everywhere**, with an alarm on depth. EventBridge retries a failing
  target for 24 hours and then drops the event *silently* if no DLQ is attached.
- **Shed load deliberately** rather than accidentally: shrink the batch window
  and let the stream buffer, instead of letting timeouts pick which events die.

---

## Geospatial

Where the reference implementation's `src/geo/` maps almost directly:

| Question | Mechanism |
|---|---|
| Which facility is nearest this address? | `ST_DWithin` + KNN `<->` ordering on a GiST index |
| Is this vehicle inside the service area? | `ST_Contains` against a territory polygon |
| Has the driver breached a geofence? | Point-in-polygon, in-process for speed, PostGIS for truth |
| Which stops are reachable within the SLA? | Isochrones — the thing PostGIS cannot do and MapBox can |
| Render territories to a browser | TopoJSON from S3 + CloudFront, cached hard |

Three things that are easy to get wrong and expensive to find:

- **`[longitude, latitude]`.** GeoJSON, PostGIS and MapBox use x-then-y; humans
  and consumer map apps say the opposite. A swap does not throw — it silently
  relocates a facility. Range-check at every boundary.
- **`ST_DWithin`, never `ST_Distance(...) < n`.** The first is index-assisted;
  the second computes a spherical distance for every row. Same answer, roughly
  two orders of magnitude apart. `EXPLAIN ANALYZE` and look for the index scan.
- **`geography`, not `geometry`, for distances.** With SRID 4326, `geometry`
  distances are in *degrees*, which is meaningless for "within 5km".

TopoJSON is worth the extra decode step precisely here: territory and service-area
polygons share thousands of borders, and storing each shared edge once — plus
quantisation and delta encoding — is routinely an 80–90% reduction. The
reference implementation measures 76% on a single 600-vertex polygon with
quantisation alone.

---

## Where AI fits

Deliberately **not** in the decision path for routing correctness.

| Concern | Mechanism | Why |
|---|---|---|
| Is this an exception? | Deterministic rules over corroborating events | Must be testable, explainable and identical every time |
| What is the optimal route? | Optimisation solver / heuristics | Constraint satisfaction, not language |
| *Why* is this package late, and what should we do? | LLM agent over the event history and runbooks | Synthesis and explanation, grounded and cited |
| Draft the customer notification | LLM, template-constrained | Tone, not truth |

The reference implementation makes the same split on purpose: correlation rules
decide what is real, and the model's job starts afterwards. A rule that pages a
human has to be explainable to the person it woke up.

The agent's tool set here is the interesting part — `getPackageHistory`,
`findNearbyFacilities`, `searchRunbooks`, `getRouteplan` — each authorised
against the **caller's** permissions, so a customer-service agent and an
operations lead get genuinely different capability from the same assistant.

---

## Scale and cost notes

*(Sizing below is illustrative — substitute real figures.)*

- **Hot partitions.** Partitioning by `trackingId` distributes well; partitioning
  by facility or by day does not. Where a single key must absorb disproportionate
  write volume, write-shard (`FACILITY#x#<0-9>`) and scatter-gather on read.
  Know the technique; do not apply it pre-emptively.
- **TTL on raw telemetry.** Set `expiresAt` and DynamoDB deletes items free,
  within ~48h. Far cheaper than a cleanup job, and it keeps hot partitions small.
  The durable history lives in S3, not in the operational store.
- **Tiered storage.** Standard → Standard-IA at 30 days → Glacier IR at 90.
  Add `noncurrent_version_expiration` and `abort_incomplete_multipart_upload`,
  or versioning quietly bills you forever for data nobody can see.
- **Kinesis vs EventBridge.** Kinesis for the high-volume ordered ingest stream
  (ordering, replay, per-shard throughput); EventBridge for the low-volume,
  high-fan-out business events (content filtering, many independent consumers).
  Using either for the other's job is the mistake.
- **Express Step Functions** for per-package workflows at volume; Standard for
  long-running sagas that need full execution history.

---

## Replay: the capability that pays for the whole design

Because raw payloads land in S3 before transformation and `normalise()` is a
pure function, a mapping bug is a **replay**, not a data-loss incident. The same
mechanism supports:

- Backfilling a new consumer with historical events rather than starting it
  blind.
- Rebuilding a corrupted projection from the log.
- Answering a "what did we know, and when did we know it" question from an
  auditor or a customer dispute.

This is the argument for archiving before transforming, and it is worth making
explicitly because the cost — an extra S3 write on every event — looks like pure
overhead until the first time you need it.
