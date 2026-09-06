# Migration plan: NetPulse → Fleet Management Platform

Turning this repository from a JD-shaped reference implementation into an
MVP-scale reference slice of the fleet management platform described in
[`../portfolio/03-fleet-management-platform.md`](../portfolio/03-fleet-management-platform.md).

## Why

The current framing is the weakness, not the code. `README.md` opens with *"a
reference implementation of every technology named in the job description"* and
carries a table titled *"Where each JD requirement lives."* A reader correctly
discounts that: it is a checklist, so of course it checks every box.

Re-grounding the same stack in a platform architecture removes that discount
without losing a single technology.

## Honesty constraint

The moment the README states 330,000 drivers, that is a claim. The honest form
is *"architecture sized for 330k drivers; this MVP runs a 60-driver synthetic
fixture set offline."* Keep the `(assumption)` markers the write-up already
carries.

All data in this repository is **synthetic and generated** — see Phase 4. That
is not only a convenience: real driver telemetry is a location trace of an
identifiable person, and a portfolio repository is the last place it belongs.
Worth stating in the README rather than leaving implied.

This repository is a **reference slice of an architecture**, runnable offline —
not a copy of a production system. That distinction is what stops it reading as
too-good-to-be-true, which is the whole point of the exercise.

---

## Decisions

Settled up front so no phase stalls on them. Each is threaded into the phase it
affects; this table is the index.

| # | Decision | Rationale | Phase |
|---|---|---|---|
| 1 | Product **Meridian**, repo **`meridian-fleet`** | Geographic root suits a territory/geofence platform; the suffix makes it scannable in a repo list | 0 |
| 2 | **Never deploy the Terraform** | `infra/` is read-only demonstration material. Nothing in this plan needs a live account, and the cost risk drops to zero. Stated in the README as a choice, not an omission | 10 |
| 3 | **Unpublished until Phase 12, then squash and publish** | NetPulse cannot be removed from history while it is still the code. Migrate first, squash the pre-migration run into one commit, publish from there. Real history accumulates after | 12 |
| 4 | **Platform primitives are injected** — clock, crypto, runbook loading | One pattern fixes determinism *and* unblocks the in-browser frontend. See below | 1 |
| 5 | **No basemap** — dark canvas, polygons, pins | Fully offline, no key, no attribution, no tile blob in the repo. A dark ops console is also the better look | 9 |
| 6 | **Aurora pgvector**, not OpenSearch Serverless | The KB module's own comments already recommend it; removes the largest cost trap even if someone deploys | 10 |
| 7 | **Fixtures modelled from published API references** | Individual developers cannot get Samsara / Motive / Lytx sandbox access. The current header says "capture one true response per vendor" — that instruction cannot be followed and implies it was | 4 |
| 8 | **GPS traces follow hand-drawn polylines** | 3–4 per district, interpolated along. Removes the "drivers crossing rivers" tell anyone with fleet experience spots instantly | 4 |
| 9 | **Frontend steps 1–2 in scope, step 3 optional** | Board is the portfolio screenshot; the agent-trace panel is the differentiator. Time controls are droppable polish | 9 |

### Decision 4, in full — injected platform primitives

Three problems share one solution:

```
src/platform/
├── clock.ts            now()              → Node: Date  │ Browser: Date
│                                            demos + tests: fixed epoch
├── crypto.ts           sha256(), uuid()   → Node: node:crypto
│                                            Browser: bundled sync sha256
│                                                    + crypto.randomUUID()
└── runbook-loader.ts   load()             → Node: node:fs
                                             Browser: Vite raw glob
```

What this buys:

- **Determinism.** 20 `new Date()` / `Date.now()` calls currently make every run
  produce different output — unnarratable, unscreenshottable, and unassertable
  in the Phase 11 scenario tests.
- **The browser transport.** Five files import Node builtins
  (`knowledge-base.ts`, `cognito-jwt-verifier.ts`, `aws/bedrock.ts`, `aws/s3.ts`,
  `platform/ids.ts`). None of them exist in a browser, which would otherwise
  block Phase 9 outright. The nasty specific: `createHash` is **synchronous**
  and the browser's SubtleCrypto is **async-only**, so naively porting it would
  force `signalId = sha256(...)` async and ripple through the entire pipeline.
  A bundled sync sha256 (~40 lines) avoids that. Worth writing properly rather
  than substituting a cheaper hash — content-hash idempotency is one of the
  repo's headline arguments.
- **An honest architectural claim.** *Platform primitives are injected, so the
  same domain code runs on Lambda and in a browser.* `src/platform/` already
  exists as exactly this boundary, so this is consistent with the design rather
  than a workaround bolted on to make a demo run.

Lands in **Phase 1**, while `types.ts` is being rewritten anyway. Retrofitting it
at Phase 11 means touching every file a second time.

---

## The domain spine

Already the right shape. This is a rename, not a restructure:

```
BEFORE
   RawRecord ──▶ Signal ──────────────▶ Incident ──▶ Agent answer
                   │                       │
                   │                       └── correlated across sites
                   └── 8 vendors → one canonical shape

AFTER
   RawRecord ──▶ Telemetry ──▶ Exception ──▶ Incident ──▶ Agent answer
                   │             │             │
                   │             │             └── corroborated + merged
                   │             └── one driver, rules-detected
                   └── 8 telematics vendors → one canonical shape
```

The only genuine addition is splitting `Incident` into two levels: a per-driver
`Exception`, and the corroborated/merged `Incident` that actually pages a human.
The write-up's §6 argues for exactly this, and `detectIncidents` already
implements the merge — it just currently does it in one step.

---

## Target architecture

```
   Browser — dispatch board (React + MapLibre)              [Phase 9, NEW]
        │  GraphQL query + filtered subscription
        │
  ┌─────▼─────────────────────────────────────────────────────┐
  │ AppSync — server-side filter by district / status / type   │
  └─────▲─────────────────────────────────────────────────────┘
        │
  ┌─────┴───────┐            ONLY EXCEPTIONS BECOME EVENTS
  │ Hot state   │           ┌───────────────────┐
  │ DynamoDB    │◀──────────│   EventBridge     │  geofence breach, harsh
  │ 1 item per  │           │  custom event bus │  braking, route deviation,
  │ driver,     │           └───┬────┬──────┬───┘  idle, panic
  │ overwritten │               │    │      └──── dispatch / reassignment
  └─────▲───────┘       safety ─┘    └─ on-call        (Step Functions saga)
        │                             ▲
        │                             │
        │                   ┌─────────┴─────────┐
        │                   │ Rules + geofence  │  bbox ─▶ exact,
        │                   │ evaluation        │  in-process, cached
        │                   └─────────▲─────────┘
        │                             │
        └──────────────┬──────────────┴──────────────┐
                       │  BATCHED — never one invocation per event
            ┌──────────┴───────────┐        ┌────────▼─────────┐
            │ Kinesis Data Streams │        │ Firehose ──▶ S3  │
            │ (ordered per driver) │        │ history (parquet)│
            └──────────▲───────────┘        │ Athena           │
                       │                    └──────────────────┘
        ┌──────────────┴──────────────┐
        │  8 vendor adapters,         │
        │  one normalise() each       │
        └──────────────▲──────────────┘
                       │
  Driver app · vehicle telematics · ELD · dashcam · sensors

  ┌───────────────────────────────────────────────────────────┐
  │ Aurora PostGIS — territories, facilities, route corridors, │
  │ geofence polygons, spatial queries                         │
  ├───────────────────────────────────────────────────────────┤
  │ Cognito — dispatchers via SAML/OIDC · drivers device-bound │
  │ token carries district scope; nothing accepts a bare id    │
  └───────────────────────────────────────────────────────────┘
```

The load-bearing decision is in the middle: **telemetry does not become events —
only exceptions do.** Eleven thousand position updates per second through a
content-filtered event bus would be both slow and ruinous. The same volume into
a key-value overwrite plus a batched rules pass is routine.

---

## What actually changes, by file

```
src/
├── platform/
│   ├── types.ts              ██████████  rewritten — the keystone   (Phase 1)
│   ├── clock.ts              ██████████  NEW — injected now()       (Phase 1)
│   ├── crypto.ts             ██████████  NEW — sync sha256 + uuid
│   ├── runbook-loader.ts     ██████████  NEW — absorbs node:fs
│   ├── tenancy.ts            ███░░░░░░░  + scope alongside tenantId
│   └── repository.ts         █████░░░░░  hot-state write path
├── integrations/
│   ├── network/              ████████░░  → telematics/              (Phase 2)
│   ├── contact-center/       ████████░░  → eld-hos/
│   ├── observability/        ████████░░  → video-safety/
│   ├── connector.ts          ░░░░░░░░░░  untouched — retry + breaker generic
│   └── fixtures.ts           ██████████  rendered from scenarios    (Phase 4)
├── pipeline/
│   └── steps.ts              ███████░░░  +200-250 new lines         (Phase 3)
├── data/
│   ├── generate.ts           ██████████  NEW — seeded generator     (Phase 4)
│   ├── scenarios.ts          ██████████  NEW — five scripted situations
│   ├── sites.ts              ██████████  → districts.ts + drivers.ts
│   └── runbooks/             ██████████  four new runbooks          (Phase 8)
├── geo/
│   ├── spatial.ts            ░░░░░░░░░░  untouched — domain-neutral (Phase 5)
│   ├── mapbox.ts             ██░░░░░░░░  style spec reused verbatim by the UI
│   ├── site-repository.ts    ████████░░  splits: driver + territory
│   └── postgis-queries.ts    ██████░░░░  nearest-driver, containment
├── api/
│   ├── schema.graphql        ██████░░░░  renamed types              (Phase 6)
│   ├── appsync-resolvers.ts  █████░░░░░
│   └── subscriptions.ts      ░░░░░░░░░░  untouched — filter engine already right
├── auth/                     ███░░░░░░░  + Principal.scope          (Phase 7)
├── ai/
│   ├── agent-core.ts         ░░░░░░░░░░  untouched                  (Phase 8)
│   ├── guardrails.ts         ░░░░░░░░░░  untouched
│   └── tools.ts              ████████░░  new tools, same contract
└── demo.ts                   ███████░░░  LAST — orchestrates all eight sections

web/                          ██████████  NEW — dispatch board       (Phase 9)
```

Four files come through completely untouched — `spatial.ts`, `subscriptions.ts`,
`agent-core.ts`, `guardrails.ts`. That is the evidence the abstractions were
drawn in the right places, and it is worth saying out loud when presenting this.

---

## Phase 0 — Naming

Blocks everything: every subsequent phase writes the name into comments.

Product **Meridian**; repo **`meridian-fleet`** (Decision 1).

- [ ] Rename the directory `agentic_saas_demo` → `meridian-fleet`
- [ ] `package.json`: `name`, `description`
- [ ] Replace 90 occurrences of `NetPulse` across 37 files
- [ ] **Grep string literals separately.** `tsc --noEmit` does not type-check
      them, so these pass silently while wrong: the EventBridge sources
      (`'netpulse.ingest'`, `'netpulse.detect'`), DynamoDB key prefixes,
      GraphQL field names, Terraform tags and resource names

---

## Phase 1 — Domain model

**`src/platform/types.ts`** (116 lines). The keystone — everything downstream
follows from this file, so it lands first and alone.

| Now | Becomes | Note |
|---|---|---|
| `Site` | `Driver` (hot state, 1 item each) + `Territory` (PostGIS) | The one type that *splits* — this split is the architecture |
| `SiteId` | `DriverId`, `DistrictId` | |
| `Signal` | `Telemetry` | Same canonical-shape role |
| `SignalKind` | `position`, `speed`, `harsh-brake`, `idle`, `hos-remaining`, `route-adherence`, `geofence-state`, `panic` | Still 8 |
| `Incident` | `Exception` (one driver) → `Incident` (corroborated, merged) | Two levels, per §6 |
| `ProviderDomain` | `telematics` / `eld-hos` / `video-safety` | |
| `ProviderId` | 8 telematics vendors (Phase 2) | |
| `Principal.roles` | `admin` / `dispatcher` / `safety` / `driver` / `viewer` | |
| — | `Principal.scope` (district or region) | **New** |

`Principal.scope` is the only genuinely new field. It is what makes *"no
function accepts a bare district id"* true rather than asserted.

### Also in this phase: the injected platform primitives

Per Decision 4 — cheap now, expensive later, because both `types.ts` and every
call site are already open:

- [ ] `src/platform/clock.ts` — `now()`; fixed epoch for demos and tests.
      Replaces 20 `new Date()` / `Date.now()` calls
- [ ] `src/platform/crypto.ts` — `sha256()` (sync, ~40 lines in the browser
      build) and `uuid()`. Absorbs `platform/ids.ts`, `aws/s3.ts`,
      `aws/bedrock.ts`, `auth/cognito-jwt-verifier.ts`
- [ ] `src/platform/runbook-loader.ts` — absorbs `node:fs` / `node:path` /
      `node:url` out of `ai/knowledge-base.ts`

After this phase, no file outside `src/platform/` imports a `node:` builtin.
That invariant is what makes Phase 9 possible; worth a lint rule or a test.

> **Type-stripping trap.** `node src/demo.ts` runs TypeScript via type-stripping,
> which does not support `enum`, `namespace`, parameter properties or
> decorators. Writing `enum Severity { ... }` here would break `npm start` at
> *runtime* while `tsc --noEmit` stays green. The current union types are correct
> — keep them.

---

## Phase 2 — Connectors

**`src/integrations/`** — 8 connector files + `registry.ts`.

Straight substitution, keeping the 3/3/2 shape:

| Now | Becomes |
|---|---|
| `network/` — Cisco Meraki, Juniper Mist, Aruba Central | `telematics/` — **Samsara**, **Geotab**, **Verizon Connect** |
| `contact-center/` — Genesys, Five9, Amazon Connect | `eld-hos/` — **Motive**, **Omnitracs**, **Platform Science** |
| `observability/` — ThousandEyes, Splunk | `video-safety/` — **Lytx**, **Netradyne** |

Each connector's `normalise()` is rewritten to emit `Telemetry`. The retry,
circuit-breaker and registry scaffolding is untouched.

---

## Phase 3 — Pipeline and the scale mechanisms

**`src/pipeline/`** — `steps.ts`, `ingest-workflow.ts`, `state-machine.asl.json`.

The phase that earns the repo its architecture claim, and the only backend phase
that is more than a reskin:

```
NOW
   collect ──▶ normalise ──▶ enrich ──▶ detect ──▶ publish
      │                                              │
      ▼                                              ├──▶ SignalsNormalized  ◀── every batch
   S3 raw                                            └──▶ IncidentOpened

AFTER
   collect ──▶ normalise ──┬──▶ putCurrentPosition  overwrite, 1/driver  [NEW]
      │                    ├──▶ appendHistory       S3, cold path        [NEW]
      ▼                    │
   S3 raw                  └──▶ evaluate ──▶ detect ──▶ publish
                                    │                      │
                              bbox ─▶ exact,               └──▶ ExceptionRaised  ◀── exceptions only
                              in-process, cached [NEW]          IncidentOpened
```

1. **Hot/cold split** (§1) — `putCurrentPosition()` overwrites one item per
   driver; history appends to the S3 stand-in.
2. **Batched processing** (§2) — `processBatch(records[])` instead of
   per-record, with the poison-record comment naming
   `BisectBatchOnFunctionError`.
3. **In-process geofencing** (§4) — wire the existing `bboxAround` /
   `pointInPolygon` from `spatial.ts` into the hot path as a two-phase check,
   module-scope cached. *This code already exists and is already tested; it just
   is not on the ingest path yet.*
4. **Only exceptions publish** — delete the `SignalsNormalized` fan-out.

`detectIncidents` keeps its two-independent-sources rule verbatim — it already
implements §6 exactly, with sites swapped for drivers and the 150km merge
becoming route-corridor proximity.

**~200–250 net new lines.**

---

## Phase 4 — Mock data and scenarios

There is no real fleet data and there should not be. This phase makes synthetic
data a **feature of the demo** rather than an apology for it.

### Deterministic generation

- **Seeded PRNG, never `Math.random()`.** A demo that produces different output
  on each run cannot be narrated, screenshotted, or asserted against in a test.
  A small xorshift/mulberry32 in `src/data/generate.ts`, seeded from a constant.
- Generated **at runtime from the seed**, not committed as a large JSON blob.
  The generator is readable code that demonstrates domain understanding; a
  10,000-line fixture file demonstrates nothing.

### Shape of the world

| Thing | Count | Note |
|---|---|---|
| Districts | 5 | Reuse the existing DAL / AUS / DEN / CHI / PHX coordinates |
| Drivers | ~60 | Board looks real; still small enough to enumerate by hand |
| Territory polygons | 5 | One per district, as GeoJSON rings |
| Geofences | ~12 | Facilities, customer sites, restricted zones |
| Route corridors | ~20 | For the route-adherence rule |
| Telemetry trace | 60 ticks × 60 drivers | 30 minutes at a 30s interval = ~3,600 records |
| Road polylines | 3–4 per district | Decision 8 — see below |

The telemetry trace is what makes the board *move*. A static map is a
screenshot; a replayable trace is a product.

**Drivers move along polylines, not by random walk** (Decision 8). Hand-draw
three or four routes per district and interpolate positions along them. A random
walk sends drivers diagonally across rivers and through airports — invisible at
district zoom, glaring the moment anyone zooms in, and instantly recognisable to
anyone who has worked with fleet data. The cost is an afternoon of clicking
points on a map; the alternative is a demo that looks wrong to exactly the
audience you built it for.

### Scenarios — the part that matters

Five scripted situations, each of which exists to prove one architectural claim.
This is what turns fixture data into an argument:

| Scenario | Proves |
|---|---|
| `road-closure` — 14 DAL drivers deviate together | Spatial merge: **one** incident with 14 affected drivers, not 14 pages |
| `gps-drift` — one driver deviates, nothing corroborates | The two-independent-sources rule: this is **not** an exception |
| `harsh-braking` — telematics and dashcam agree | Cross-vendor corroboration raising a safety exception |
| `hos-risk` — driver approaching hours-of-service limit | The agent + the Step Functions reassignment saga |
| `panic` — driver panic button | "Real-time" means two different things; this path bypasses batching |

`gps-drift` is the most valuable of the five, because it demonstrates the system
**declining** to alert. Anyone can show a dashboard lighting up; showing the
noise filter working is the harder and more convincing thing.

### Vendor rendering

`src/integrations/fixtures.ts` stops being hand-written constants and becomes a
renderer: each scenario is projected into each of the 8 vendors' native payload
shapes. Keep them genuinely different from one another — Samsara's REST JSON,
Geotab's RPC-ish envelope, Motive's HOS log records, Lytx's event payloads.

That difference *is* the justification for the normalisation layer, which is
what the current `fixtures.ts` header comment already says. Same argument,
better data.

### Provenance — fix the comment that cannot be true

`fixtures.ts` currently instructs: *"capture one true response per vendor,
commit it, and assert the Signal it produces."* That is good advice and it
cannot be followed here. Samsara, Motive, Lytx, Netradyne, Omnitracs and
Platform Science all gate API access behind a customer account; an individual
developer will not get a sandbox. Samsara and Geotab publish usable public
references, and Geotab offers a demo database — the rest are documentation only.

Leaving the comment as-is implies captured data. Replace it with what is true,
and cite the source in each connector's header:

```
Shaped from the published <vendor> API reference (<url>, retrieved <date>).
Not captured from a live account — see docs/migration-plan.md, Decision 7.
```

Same point for the vendor names themselves: listing eight real telematics
vendors implies integration experience with them. The citation line is what
turns *"I integrated Samsara"* into *"I modelled Samsara's documented payload
shape"* — which is both accurate and still demonstrates the skill that matters.

---

## Phase 5 — Geospatial

**`src/geo/`, `src/data/`**

- `spatial.ts` is domain-neutral — **untouched**
- `site-repository.ts` → `driver-repository.ts` + `territory-repository.ts`
- `postgis-queries.ts` — nearest-site becomes nearest-available-driver;
  add territory containment and route-corridor adherence
- `schema.sql` — `drivers`, `territories`, `geofences`, `route_corridors`
- `mapbox.ts` — mostly unchanged; its style-spec output is consumed verbatim by
  the frontend in Phase 9

---

## Phase 6 — API

**`src/api/`** (622 lines including the schema).

`schema.graphql` renames types and adds the filtered subscription the write-up
names explicitly:

```graphql
onDriverException(district: ID, severity: Severity): Exception
```

`subscriptions.ts` needs **no logic change** — its filter engine already does
server-side matching, and `demo.ts` already proves the unmatched watcher is
never woken. That demo moment gets considerably stronger when the filter is a
district rather than a severity, and stronger again when Phase 9 puts it on
screen.

---

## Phase 7 — Auth

**`src/auth/`**

Two populations, one model: dispatchers via enterprise SSO (SAML / OIDC),
drivers device-bound and offline-tolerant. `pre-token-generation.ts` injects
`scope` alongside `tenantId`. Small phase.

---

## Phase 8 — AI

**`src/ai/`, `src/data/runbooks/`**

New tools: `queryDriverTelemetry`, `findNearbyAvailableDrivers` (spatial),
`getRoutePlan`, `reassignDriver` (the write tool the guardrail refuses).

New runbooks: route deviation, harsh-braking review, HOS-violation risk,
vehicle breakdown.

`agent-core.ts` and `guardrails.ts` are **unchanged** — the write-up says the
agent "maps over almost unchanged," and that is accurate.

---

## Phase 9 — Frontend: the dispatch board

The largest phase by a wide margin — realistically larger than Phases 1–8
combined. It is also what turns a backend reading exercise into something a
non-engineer can look at and understand in five seconds. The whole fleet
architecture culminates in a live dispatch board; without one, the best part of
the story is described rather than shown.

### The dependency problem, stated honestly

The backend's current selling point is **zero runtime dependencies** — clone,
`npm start`, done. A React frontend cannot preserve that. The resolution is npm
workspaces:

```
/                 backend — stays dependency-free, `npm start` unchanged
/web              frontend — its own package.json, its own deps
```

The README then says what is true: *the backend demo runs with zero
dependencies; the dispatch board is a separate workspace with its own.* Do not
quietly break the claim — qualify it.

### Stack

| Choice | Why this specifically |
|---|---|
| **Vite + React + TypeScript** | Conventional, fast, shares types with the backend directly via workspace import |
| **MapLibre GL JS** | API-compatible with Mapbox GL JS v1, so it **consumes the style spec `src/geo/mapbox.ts` already emits, unchanged** — and needs no token and no account, which preserves clone-and-run. Swapping to real Mapbox is an import change plus a `pk.*` token |
| **No basemap** (Decision 5) | MapLibre is a *renderer*, not a data source — it draws nothing without tiles. Rather than a key (breaks clone-and-run) or a self-hosted PMTiles extract (a large binary in the repo), render territory polygons and driver pins on a dark canvas. Fully offline, and a dark ops console is the better look regardless |
| **Tailwind** | Dark ops-console styling without a component library to explain |
| No GraphQL client library | The transport boundary below is ~50 lines; Apollo would be more machinery than the MVP needs |

### The transport boundary — the interesting decision

`web/transport/` is one interface with two implementations:

```
   ┌──────────────────────────────────────────────┐
   │  web/  — queries, subscriptions, components   │
   └────────────────────┬─────────────────────────┘
                        │  depends only on this interface
             ┌──────────▼──────────┐
             │  Transport          │
             │  query / subscribe  │
             └──────┬───────┬──────┘
                    │       │
      ┌─────────────▼──┐ ┌──▼──────────────────┐
      │ in-process.ts  │ │ appsync.ts          │
      │ calls the      │ │ real endpoint + WS  │
      │ resolvers      │ │ (unused in MVP,     │
      │ directly       │ │  present to show    │
      │ — no server    │ │  the swap)          │
      └────────────────┘ └─────────────────────┘
```

The in-process implementation works because `src/aws/` is *already* a set of
local stand-ins — the entire backend runs in the browser with no server at all.
That is not a hack to hide the lack of infrastructure; it makes "the client
depends on the API contract, not the API implementation" a demonstrated fact
rather than a claim. Say so in the README.

**It only works if Phase 1 landed properly.** Node builtins do not exist in a
browser, so the "no `node:` import outside `src/platform/`" invariant from
Decision 4 is the precondition for this entire phase. Verify it before starting
here, not after.

One more piece of friction to expect on day one: the backend imports use
explicit `.ts` extensions (`from '../platform/types.ts'`), which Node's
type-stripping requires and bundlers do not expect. Set
`allowImportingTsExtensions` in the web tsconfig.

### Views

| View | Contents | Why it earns its place |
|---|---|---|
| **Dispatch board** | MapLibre map, driver pins, district filter, live exception feed | The centrepiece. Data-driven styling: status → colour, severity → radius, computed on the GPU, no per-feature JS |
| **Driver detail** | Telemetry timeline, HOS clock, current assignment | Where the canonical `Telemetry` shape becomes visible |
| **Incident detail + assistant** | The agent's tool-call trace, live, with citations | **Highest-value screen in the repo.** It makes the agent loop visible instead of asserted — most AI portfolio pieces show only the final answer |
| **Subscription inspector** | What the district filter delivered, and what it withheld | Puts the repo's best cost argument on screen. `demo.ts` already proves this in the terminal; showing it is better |
| **Time controls** | Play / pause / scrub the replayed trace | What makes it read as an ops product rather than a static mock |

### Staging

This phase can ship incrementally, and should:

1. Board + map + district filter — the screenshot that goes in the portfolio
2. Incident detail + agent trace panel — the differentiator
3. Time controls + subscription inspector — the polish

**Steps 1 and 2 are in scope; step 3 is optional** (Decision 9). Stop after
step 1 and you still have a portfolio piece. Stop after step 2 and you have the
best version of it.

The failure mode here is not difficulty, it is abandonment — a half-built board
is worse than no board, because it is the first thing a visitor clicks. Each
step must be shippable on its own.

---

## Phase 10 — Infra, Python, CI

**This infrastructure is never deployed** (Decision 2). It is read-only
demonstration material: the resource definitions, IAM policies and module
structure are the artefact, not a running stack. Nothing else in this plan needs
a live AWS account, and saying so in the README makes it a stated choice rather
than a gap someone has to notice.

- Terraform: rename tags and resources; add `kinesis` + `firehose` modules so
  the stream-batching argument has something concrete to point at
- **Switch the Bedrock KB module's default vector store to Aurora pgvector**
  (Decision 6), demoting the OpenSearch Serverless block to a commented
  alternative. The module's own comments already recommend this, and it currently
  carries a `REPLACE_ME` collection ARN so it is not deployable as written
- `python/` handlers reskin
- `.github/workflows/` — name changes, plus a `web` build job once Phase 9 lands

Independent of Phases 1–9; can run at any point after Phase 0.

> **If you ever do decide to deploy**, the costs that bill you are idle
> infrastructure, not traffic: OpenSearch Serverless (~$175–700/mo), Aurora
> Serverless v2 (~$88/mo per environment, and this module provisions a writer
> *and* a reader at `min_capacity = 0.5`), and an idle Kinesis stream (~$29/mo).
> Deploy `dev` only, set an AWS Budgets alert first, and `terraform destroy` the
> same day. Aurora Data API is already the right call here — it is HTTP, so no
> VPC and therefore no NAT Gateway. Figures are approximate us-east-1; verify
> before relying on them.

---

## Phase 11 — Tests

40 tests. The four behaviours they pin — idempotent ingest, cross-tenant
denial, the lon/lat swap, an agent refused a write tool — all survive the
rename with new nouns.

Add three:

- **Telemetry does not reach the event bus; only exceptions do.** The
  architecture's load-bearing claim; it should fail loudly if broken.
- **`gps-drift` raises nothing.** The noise filter, pinned.
- **`road-closure` raises exactly one incident** with 14 affected drivers.

The scenarios from Phase 4 make these assertions trivial to write, which is a
large part of why scenarios are worth building.

---

## Phase 12 — Docs and framing

The structural move: **`portfolio/03-fleet-management-platform.md` stops being a
portfolio write-up and becomes the repo's `docs/01-architecture.md`.** It is
already better than the current architecture doc.

That leaves `portfolio/01` (AI fabric) and `portfolio/02` (logistics) as
write-ups of *other* systems — either a `docs/other-platforms/` folder, or
dropped from the repo.

- [ ] `README.md` rewritten around the product; the *"Where each JD requirement
      lives"* table — the thing that makes it read as JD-shaped — goes away
- [ ] README states plainly: synthetic data, offline stand-ins, zero-dependency
      backend + separate frontend workspace
- [ ] Screenshot or GIF of the dispatch board at the top of the README —
      for a product repo this does more than the first three paragraphs
- [ ] `docs/00-start-here.md` reframed from interview prep to project orientation
- [ ] `docs/09-interview-cheatsheet.md` leaves the repo, or loses its "on the
      day" voice
- [ ] The nine primers keep their content, lose the JD framing — they become
      "how this stack works," which is portfolio-appropriate
- [ ] This file is deleted once the migration lands

### Publication — squash, then push (Decision 3)

The repository stays **unpublished until this phase**. Git history is permanent
and public: `docs/09-interview-cheatsheet.md`, the package name
`netpulse-agentic-saas-demo` and the *"Where each JD requirement lives"* table
all live in commit `d21085d`, and deleting the files later does not remove them.

NetPulse cannot be stripped from history while it is still the code, so the
sequencing is: migrate everything, then squash the entire pre-publication run
into one commit, then push. Genuine incremental history accumulates from that
point forward.

- [ ] Squash to a single initial commit under the new name
- [ ] Confirm no remote was added before this point
- [ ] Decide the `Co-Authored-By` trailer policy for the commits that follow

---

## Execution notes

**Ordering:** types → leaves → `demo.ts` last. `demo.ts` is 703 lines
orchestrating all eight sections; touching it early means rewriting it twice.

**Safety net:** run `npm run typecheck` after every phase. With a rename this
wide, the compiler is what catches the misses. `npm test` after phases 3, 6
and 8.

```
        ┌─▶ 2 ──▶ 3 ──▶ 4 ─┐
        │                  │
        ├─▶ 5 ─────────────┤
   0 ──▶ 1 ─┤                  ├──▶ demo.ts ──▶ 9 ──▶ 11 ──▶ 12
        ├─▶ 6 ─────────────┤       (backend)   (web)
        │                  │
        ├─▶ 7 ─────────────┤
        │                  │
        └─▶ 8 ─────────────┘

   10 ──── independent, any point after 0
```

Phase 4 (mock data) gates Phase 9 (frontend) in practice — a board with nothing
moving on it is not worth building twice.
