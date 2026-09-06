# Fleet Management Platform

> **Scope of this document.** An architecture write-up expressed in the AWS
> serverless vocabulary used by the reference implementation in this repository.
> The 330,000-driver figure is given; every throughput number derived from it is
> arithmetic on a stated assumption and is marked *(assumption)*. Replace those,
> and any service choice that differs from what was actually built, before using
> this anywhere it will be read as a record.

A real-time operational platform for monitoring and orchestrating **330,000+
drivers** and enterprise fleet operations.

The defining constraint is not complexity — it is **that number, multiplied by a
telemetry interval**. Almost every design decision below follows from arithmetic
that a smaller fleet would let you ignore.

---

## Sizing first, because everything follows from it

*(Assumption: one telemetry ping per driver per 30 seconds.)*

```
330,000 drivers ÷ 30s   ≈  11,000 events/sec  sustained
                            ~950 million events/day
peak (shift change, wave dispatch)  ≈ 3-5× sustained
```

At 10-second intervals that is ~33,000/sec. Three consequences:

1. **Per-event Lambda invocation is the wrong shape.** Batch from a stream.
2. **Every event cannot be a durable write to the operational store.** Separate
   *current position* (overwrite, tiny, hot) from *position history* (append,
   large, cold).
3. **Fan-out to dashboards must be filtered server-side.** A dispatcher watching
   one district must not receive 11,000 events/sec of national traffic.

Anything that looks over-engineered below is usually one of those three.

---

## Architecture

```
  330k driver devices · vehicle telematics · handhelds · sensors
        │                    │                  │          │
        └────────────────────┴────────┬─────────┴──────────┘
                                      │  IoT Core / mobile ingest
                           ┌──────────▼───────────┐
                           │  Kinesis Data Streams │  partitioned by driverId
                           │  (ordered per driver) │  ordering where it matters
                           └──────────┬───────────┘
                                      │
             ┌────────────────────────┼────────────────────────┐
             │                        │                        │
   ┌─────────▼────────┐    ┌──────────▼─────────┐   ┌──────────▼─────────┐
   │  Hot state       │    │  Rules / geofence  │   │  Firehose → S3     │
   │  DynamoDB        │    │  evaluation        │   │  history (parquet) │
   │  current position│    │  (batched Lambda)  │   │  Athena / analytics│
   │  1 item / driver │    └──────────┬─────────┘   └────────────────────┘
   └─────────┬────────┘               │
             │                        │  only EXCEPTIONS become events
             │              ┌─────────▼─────────┐
             │              │   EventBridge     │  geofence breach, harsh
             │              │                   │  braking, route deviation,
             │              └────┬────┬────┬────┘  idle, panic
             │                   │    │    │
             │        safety ────┘    │    └──── dispatch workflow
             │                        │            (Step Functions)
             │              on-call ──┘
             │
   ┌─────────▼──────────────────────────────────────────────────┐
   │  AppSync subscriptions — live dispatch board                │
   │  server-side filter by district / status / exception type   │
   └─────────────────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────────────────┐
   │  Aurora PostGIS — territories, facilities, route corridors,   │
   │  geofence polygons, spatial queries                           │
   └──────────────────────────────────────────────────────────────┘
```

The critical structural decision is visible in the middle of that diagram:
**telemetry does not become events.** Only *exceptions* do. Eleven thousand
position updates per second through an event bus with content filtering would be
both slow and ruinous; eleven thousand position updates per second into a
key-value overwrite plus a batched rules evaluation is routine.

---

## How the reference implementation maps onto this

| Reference file | Fleet equivalent |
|---|---|
| `src/geo/spatial.ts` | In-process geofence checks — bbox pre-filter then exact, avoiding a DB round trip per ping. |
| `src/geo/postgis-queries.ts` | Territory containment, nearest-facility, route-corridor adherence. |
| `src/geo/mapbox.ts` | The dispatch map: data-driven styling by driver status, isochrones for reassignment. |
| `src/geo/topojson.ts` | District and territory polygons, served once and cached hard. |
| `src/api/subscriptions.ts` | The live board, with the server-side filter that makes it affordable. |
| `src/aws/dynamodb.ts` | Single-table hot state + GSI1 to flip driver→district. |
| `src/pipeline/steps.ts` (`detectIncidents`) | Exception corroboration — two independent signals before alerting. |
| `src/integrations/connector.ts` | Telematics vendor adapters, one `normalise()` each. |
| `src/platform/tenancy.ts` | Region / district scoping, using the same `Principal` discipline. |
| `src/ai/agent-core.ts` | "Why is this route behind, and what are my options?" |

---

## The design decisions that matter at this scale

### 1. Split hot state from history

Two stores, because they answer different questions and have opposite access
patterns:

| | Hot state | History |
|---|---|---|
| Shape | 1 item per driver, overwritten | Append-only |
| Size | 330k items, small | ~950M rows/day *(assumption)* |
| Store | DynamoDB | S3 (Parquet) via Firehose |
| Question | "Where is everyone right now?" | "What happened on this route last Tuesday?" |
| Cost driver | Write throughput | Storage volume |

Keeping history out of the operational store is what keeps the operational store
fast and affordable. The reference implementation's TTL note applies directly:
set `expiresAt` on anything transient and let DynamoDB delete it free, within
~48h, rather than running a cleanup job.

### 2. Batch from the stream; never invoke per event

A Kinesis event-source mapping with a batch size and a batch window turns 11,000
invocations/sec into a manageable number of invocations processing many records
each. Three settings do the work:

- `BatchSize` / `MaximumBatchingWindowInSeconds` — latency against efficiency.
- `ParallelizationFactor` — more concurrency per shard without more shards.
- `BisectBatchOnFunctionError` + `MaximumRetryAttempts` + an on-failure
  destination — so one poison record cannot stall a shard forever, which is the
  classic Kinesis outage.

That last one is the operational trap: without it, a single unparseable record
blocks its shard and the backlog grows silently until someone notices the lag
metric.

### 3. Avoid the hot partition, deliberately

`PK = DRIVER#<id>` distributes across 330k keys — fine. `PK = DISTRICT#<id>`
does not: a large district concentrates thousands of drivers' writes onto one
partition. Adaptive capacity absorbs a lot, but where a key must absorb
disproportionate write volume, **write-shard** (`DISTRICT#dal#<0-9>`) and
scatter-gather on read.

Know the technique; do not apply it pre-emptively — sharding you did not need is
complexity you will maintain forever.

### 4. Geofencing in-process, not per-ping to the database

11,000 pings/sec each doing a PostGIS round trip is neither fast nor cheap. The
two-phase pattern from the reference implementation applies directly:

```
phase 1  bounding-box test, in memory, against the geofences cached in the
         Lambda's module scope           ← rejects the overwhelming majority
phase 2  exact point-in-polygon, only for the survivors
```

Geofence polygons change rarely, so cache them at module scope and refresh out
of band. PostGIS remains the source of truth and handles the queries that are
genuinely relational — "which territory contains this point", spatial joins,
analytics — not the per-ping hot path.

→ `bboxAround` / `inBBox` / `pointInPolygon` in `src/geo/spatial.ts`

### 5. Server-side subscription filtering is a cost decision, not a feature

The reference implementation makes this point with two watchers where only one
matches. At fleet scale it stops being a nicety:

```
subscription { onDriverException(district: "DAL", severity: CRITICAL) { … } }
```

AppSync evaluates the filter **before** pushing, so a dispatcher watching Dallas
is neither billed for nor woken by national traffic. Without it you are pushing
every event to every connected client and filtering in the browser — which is
slow, expensive, and leaks other districts' data to anyone with dev tools.

Two AppSync limits to design around: **100 subscriptions per connection** and a
**240KB payload cap**. A board watching 40 districts needs one subscription with
a filter, not 40 subscriptions.

### 6. Exception corroboration before alerting

Straight from `detectIncidents` in the reference implementation: require **two
independent signals** before raising, and merge nearby exceptions into one
regional incident rather than paging separately for each.

A GPS drift spike that looks like a route deviation, corroborated by nothing
else, is noise. The same deviation plus a stationary vehicle plus a missed stop
is real. And when a road closure affects fourteen drivers, that is *one*
incident with fourteen affected drivers — not fourteen pages.

Alert fatigue is the actual failure mode here: a dispatcher who has learned to
dismiss the board is worse than no board.

---

## Live dispatch board flow

```
1. Dispatcher signs in via enterprise SSO. The token carries their district and
   role; nothing downstream accepts a bare district id.

2. Initial load: one GraphQL query returns the district's drivers with current
   position and status, plus the territory polygons as TopoJSON from CloudFront
   (cached, rarely changes).

3. The map renders from GeoJSON properties using data-driven styling — status
   drives colour, exception severity drives radius, computed on the GPU. No
   per-feature JavaScript, no re-render loop.

4. A subscription opens, filtered to the district. Only exceptions arrive, not
   position pings; positions refresh on a poll or a coarse tick, because 11,000
   updates/sec of pin movement is not information a human can use.

5. On an exception the dispatcher can ask the assistant "why is this route
   behind, and what are my options?" — which retrieves the route plan, recent
   telemetry, nearby available drivers (a spatial query) and the relevant
   runbook, then answers with citations.

6. Reassignment runs as a Step Functions workflow: validate, check hours-of-
   service eligibility, notify both drivers, update the plan, emit the event.
   Each step retried independently, with compensation if a later step fails.
```

Step 5 is where the reference implementation's agent maps over almost unchanged
— same loop, same tool-authorisation rule, different tools.

---

## Identity and authorisation

Two very different populations, one model:

| | Drivers | Dispatchers / managers |
|---|---|---|
| Auth | Mobile app, device-bound, offline-tolerant | Enterprise SSO (SAML / OIDC) |
| Scope | Own assignments only | District or region |
| Token lifetime | Long refresh, short access | Short, revocable |

The `Principal` discipline from the reference implementation applies directly:
a verified token yields a `Principal` carrying subject, **scope** (district or
region) and roles, and every data-access function takes that `Principal` and
derives the partition key from it. There is no function that accepts a bare
district id, so there is no code path that can forget the scope.

Same four-layer defence:

| Layer | Mechanism |
|---|---|
| Edge | Token verified before any resolver or handler runs |
| Application | `Principal`-derived keys, enforced by the type system |
| IAM | `dynamodb:LeadingKeys` scoped to the caller's district |
| Database | Postgres row-level security on territory queries |

And for the assistant specifically: **it acts with the dispatcher's authority,
never the platform's.** A tool that reassigns a driver or contacts one is
authorised against the caller's roles in code, not requested in a prompt. The
worst case is a refused tool call and an audit record.

---

## Where AI fits

| Concern | Mechanism | Why |
|---|---|---|
| Is this an exception? | Deterministic rules over corroborated signals | Must be identical every time and explainable to the person it paged |
| Optimal route / assignment | Optimisation solver | Constraint satisfaction, not language |
| *Why* is this behind, and what are my options? | LLM agent over telemetry, plan and runbooks | Synthesis, grounded and cited |
| Shift summaries, exception narratives | LLM | Compression of things a human would otherwise read |

The division is the same one the reference implementation argues for: rules
decide what is true, the model explains it. Detection that pages a human at 4am
has to be auditable in a way a model output is not.

---

## Cost notes

The failure mode at this scale is that a small per-event cost becomes a large
monthly one without anything looking wrong.

*(All figures below are illustrative — measure against real traffic.)*

| Lever | Effect |
|---|---|
| Batch from the stream rather than per-event invocation | The single largest lever; orders of magnitude on invocation count |
| Position overwrite, not append, in the operational store | Bounds the hot store at ~330k items regardless of ping rate |
| Firehose buffering + Parquet + partitioning | Compresses history and makes Athena scans cheap |
| Only exceptions traverse the event bus | Keeps bus and consumer costs proportional to *incidents*, not to *fleet size* |
| TTL on transient items | Free deletion; no cleanup job |
| Reserved concurrency on stream consumers | Stops a telemetry surge starving the dispatch API |
| Provisioned concurrency only on the auth path and the board's first query | Warmth where p99 is user-visible; nowhere else |
| Aurora Serverless v2 with a reader | Analytics queries cannot slow the operational path |

The metric worth tracking is **cost per driver per day**, because it makes the
effect of a design change legible in a way total spend does not.

---

## Open questions worth flagging

- **Offline tolerance.** Devices buffer and flush; the platform must treat late
  data as normal, ordering on event time rather than arrival. How long a buffer
  is supported is a product decision with real architectural consequence.
- **Telemetry retention.** History is simultaneously an analytics asset, a
  safety-review asset, and a liability. The retention answer is legal before it
  is technical.
- **Driver-facing latency budget.** What the driver app must do when the network
  is gone determines how much logic is on the device rather than the platform —
  and that is the most expensive decision on this list to change later.
- **Real-time definition.** "Real-time" covering a 30-second position refresh and
  "real-time" covering a sub-second panic alert are different systems. Being
  explicit about which paths need which prevents over-engineering the majority
  to serve the exception.
