# Other platforms

Architecture write-ups for two systems that are **not** in this repository,
kept here because they share most of their mechanics with Meridian and the
comparison is the interesting part.

| Doc | System |
|---|---|
| [`ai-fabric.md`](ai-fabric.md) | An enterprise AI gateway — agent ↔ model ↔ tool orchestration, policy, cost attribution, audit |
| [`event-driven-logistics.md`](event-driven-logistics.md) | Event-sourced package routing across logistics infrastructure |

> These are architecture documents, not records of what shipped. Sizing figures
> are marked *(assumption)*, and there are deliberately no outcome metrics —
> inventing those is the fastest way to lose a room.

## The same ideas, different nouns

This is the table worth having in your head. Being able to say *"that is the
same problem as this, with different nouns"* is a stronger signal than
describing three unrelated systems.

| Technique | Meridian (this repo) | AI Fabric | Logistics |
|---|---|---|---|
| **Normalise at the edge** | 8 telematics dialects → one `Telemetry` | Model providers behind one interface | Scanner / EDI feeds → `PackageEvent` |
| **Circuit breaker + jittered retry** | Per-vendor, so one dead dashcam feed does not stop GPS | Provider health and failover | Partner carrier and customs APIs |
| **Content-hash idempotency** | `sha256(provider\|ref\|observedAt)` — replayed device buffers | Request dedupe / semantic cache key | Duplicate scans are harmless |
| **Archive raw before transforming** | S3 bronze, so a mapping bug is replayable | Immutable audit record | Bronze layer → replay a mapping bug |
| **`Principal` carries the scope** | District, signed into the token | Business unit | Facility / region |
| **Agent acts with the caller's authority** | Refused tool calls render on the board | The load-bearing rule of that platform | CS agent vs ops lead get different tools |
| **Deterministic detection, AI explanation** | Rules decide; the model explains | Policy decisions are code | Exception rules, then agent narrative |
| **Corroboration before alerting** | Two independent *signals*, not two vendors | Policy violations, not single signals | Two sources per exception |
| **Only exceptions traverse the bus** | 11,000 readings/sec never reach EventBridge | Audit fan-out to many consumers | One scan fact, six consumers |
| **Batch from the stream** | 500 records/invocation, bisect on error | Batched embedding and eval runs | Kinesis ordered by trackingId |
| **Step Functions sagas** | Reassignment, with compensation | Human-in-the-loop approval | Reroute with compensation |
| **Single-table + GSI flip** | Driver → district for the board | Audit log, tool registry, per-BU config | Event log + current-state projection |
| **PostGIS `ST_DWithin` / `ST_Contains`** | Nearest available driver, territory containment | — | Nearest facility, service areas |
| **Server-side subscription filters** | What makes a 330k-driver board affordable | Streaming responses | Live package tracking |

## Where they differ, and why

- **AI Fabric has no geography.** Everything spatial in Meridian — corridors,
  geofences, nearest-driver — has no counterpart there, and the storage split
  changes accordingly: no Aurora, no PostGIS.
- **Logistics is event-sourced; Meridian is not.** A package's current state is
  a projection of its event stream, because the interesting questions are
  historical: *where did this diverge from plan?* A driver's current position
  is a single overwritten value, because the interesting question is *where are
  they now?* Same domain vocabulary, opposite storage decision.
- **Corroboration is broadest here.** Meridian had to widen the rule from "two
  vendors" to "two independent signals" precisely because a truck carries one
  GPS unit. The other two platforms genuinely do have multiple independent
  reporters for the same fact, so the narrower rule works.
