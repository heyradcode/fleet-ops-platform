# Product architecture write-ups

Three platforms, expressed in the same AWS serverless / Bedrock vocabulary as
the reference implementation in this repository.

| Doc | Platform |
|---|---|
| [`01-enterprise-ai-fabric.md`](01-enterprise-ai-fabric.md) | Enterprise AI gateway and governance — agent ↔ model ↔ tool orchestration, policy, observability, audit |
| [`02-event-driven-logistics-platform.md`](02-event-driven-logistics-platform.md) | Distributed event-driven architecture for real-time optimisation and intelligent package routing |
| [`03-fleet-management-platform.md`](03-fleet-management-platform.md) | Real-time monitoring and orchestration for 330,000+ drivers |

> **Before using these anywhere they will be read as a record:** they are written
> as architecture documents, not as an audit of what shipped. Sizing figures
> derived from the 330k-driver number are marked *(assumption)*, and service
> choices reflect the reference stack rather than verified fact. Replace both
> with what was actually built. There are no outcome metrics in these documents
> on purpose — those are yours to supply, and inventing them is the fastest way
> to lose a room.

---

## The techniques, and where each one lands

This is the table worth having in your head. The same handful of ideas recur
across all three platforms, which is the point — and being able to say *"this is
the same problem as that, with different nouns"* is more convincing than
describing three unrelated systems.

| Technique | AI Fabric | Logistics | Fleet |
|---|---|---|---|
| **Normalise at the edge** — many vendor dialects, one canonical type | Model providers behind one interface | Scanner / EDI / carrier feeds → `PackageEvent` | Telematics vendors → one telemetry shape |
| **Circuit breaker + jittered retry** | Provider health and failover | Partner carrier and customs APIs | Telematics vendor APIs |
| **Content-hash idempotency** | Request dedupe / semantic cache key | Duplicate scans are harmless | Replayed device buffers |
| **Archive raw before transforming** | Immutable audit record | Bronze layer → replay a mapping bug | Telemetry history for safety review |
| **`Principal` carries the scope** | Business unit | Facility / region | District / region |
| **Agent acts with the caller's authority** | The load-bearing rule of the platform | CS agent vs ops lead get different tools | Dispatcher scope enforced in the tool |
| **Deterministic detection, AI explanation** | Policy decisions are code | Exception rules, then agent narrative | Safety rules, then "why is this behind?" |
| **Corroboration before alerting** | Policy violations, not single signals | Two independent sources per exception | Two signals before paging a dispatcher |
| **EventBridge content filtering** | Audit fan-out to many consumers | One scan fact, six consumers | Only *exceptions* traverse the bus |
| **Step Functions sagas** | Human-in-the-loop approval | Reroute with compensation | Reassignment workflow |
| **Transactional outbox** | Audit record cannot diverge from action | State and event in one commit | Exception and notification |
| **DynamoDB single-table + GSI flip** | Audit log, tool registry, per-BU config | Event log + current-state projection | Hot state; GSI driver → district |
| **PostGIS `ST_DWithin` / `ST_Contains`** | — | Nearest facility, service areas | Geofencing, territory containment |
| **GeoJSON / TopoJSON / MapBox** | — | Territory polygons, route rendering | Dispatch board, isochrone reassignment |
| **AppSync server-side subscription filters** | Streaming responses | Live package tracking | The thing that makes a 330k-driver board affordable |
| **Terraform stack module + thin env roots** | Per-BU environments | dev → test → stage → prod | Same |

---

## Three answers worth having ready

**"What's the hardest problem you solved?"** — Pick one per platform and make it
specific:

- *Fabric:* an agent must act with the **caller's** permissions, never the
  platform's, or prompt injection becomes privilege escalation. Authorisation
  lives in the tool, checked against the caller's roles — not in the prompt.
- *Logistics:* every delivery guarantee in the stack is at-least-once, so chasing
  exactly-once *delivery* is a losing game. Make the *effect* idempotent —
  content-hash ids — and the problem dissolves.
- *Fleet:* 330k drivers × a telemetry interval means telemetry cannot become
  events. Only exceptions do. That one decision is why the event bus, the
  dashboard and the bill stay proportional to *incidents* rather than to *fleet
  size*.

**"Where did you decide *not* to use AI?"** — All three, in the same place: the
decision path. Rules decide what is true and what pages a human, because that
must be identical every time and explainable at 4am. The model's job starts
afterwards — synthesis, explanation, citation. Being able to say where you kept
AI out is a stronger signal than listing where you put it in.

**"How do you keep multi-tenancy safe?"** — Four independent layers, each of
which alone prevents the breach: the type system (nothing accepts a bare tenant
id), IAM (`dynamodb:LeadingKeys`), the database (row-level security), and the
retrieval filter on RAG. That last one is the one people forget — a knowledge
base is shared infrastructure, and a missing metadata filter is a cross-tenant
leak with no error message.

---

## Relationship to this repository

The code in `../src` is a small working model of these patterns — runnable
offline, with the trade-offs written into the comments. Where a document above
says *"→ `src/…`"*, that file demonstrates the technique concretely.

`../docs/09-interview-cheatsheet.md` covers the same ground as questions and
answers.
