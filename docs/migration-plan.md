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
| 10 | **Tests move with their phase, not at the end** | The 40 existing tests import `Signal`, `Incident`, `detectIncidents`. Phase 1 breaks all of them on contact. A test suite that is red from Phase 1 to Phase 11 is not a safety net — it is decoration | all |
| 11 | **The demo tenant uses 3 vendors, not 8** | A carrier runs one GPS unit, one ELD and one dashcam per truck — Samsara + Motive + Lytx is realistic; all eight is not. Other tenants use different subsets, which is what makes per-tenant connector config a real code path rather than a claim | 2, 4 |
| 12 | **Add `src/aws/kinesis.ts`** | Phase 3's entire batching argument has nothing to point at: `src/aws/` stands in for DynamoDB, S3, EventBridge, Step Functions and Bedrock, but there is no stream. Without it, "batch from the stream" is a comment, not code | 3 |

### Decision 4, in full — injected platform primitives

Three problems share one solution:

```
src/platform/
├── clock.ts            now(), setTo(),    → Node: Date  │ Browser: Date
│                       advance()            demos + tests: fixed epoch
│                                            trace replay + UI: advanced
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

`clock.ts` must be **advanceable, not merely fixed** — `now()`, `setTo(t)` and
`advance(ms)`. A constant epoch serves the tests; the replayable telemetry trace
and the frontend's time controls both need to drive the clock forward. Building
it as a constant means rewriting it in Phase 9.

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
                   └── 8 vendor adapters, 3 per tenant → one canonical shape
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
│   ├── clock.ts              ██████████  NEW — advanceable now()    (Phase 1)
│   ├── crypto.ts             ██████████  NEW — sync sha256 + uuid
│   ├── runbook-loader.ts     ██████████  NEW — absorbs node:fs
│   ├── tenancy.ts            ███░░░░░░░  + scope alongside tenantId
│   └── repository.ts         █████░░░░░  hot-state write path
├── integrations/
│   ├── network/              ████████░░  → telematics/              (Phase 2)
│   ├── contact-center/       ████████░░  → eld-hos/
│   ├── observability/        ████████░░  → video-safety/
│   ├── connector.ts          ░░░░░░░░░░  untouched — retry + breaker generic
│   ├── registry.ts           ████░░░░░░  connectorsFor(principal)   (Phase 2)
│   └── fixtures.ts           ██████████  rendered from scenarios    (Phase 4)
├── aws/
│   ├── kinesis.ts            ██████████  NEW — shards, batch,       (Phase 3)
│   │                                     poison-record bisect
│   └── (dynamodb, s3, eventbridge, stepfunctions, bedrock)  ██░░░░░░░░
├── pipeline/
│   └── steps.ts              ████████░░  +250-350 new lines         (Phase 3)
├── data/
│   ├── generate.ts           ██████████  NEW — seeded generator     (Phase 4)
│   ├── scenarios.ts          ██████████  NEW — six scripted situations
│   ├── polylines.ts          ██████████  NEW — 3-4 roads per district
│   ├── sites.ts              ██████████  → districts.ts + drivers.ts
│   ├── schema.sql            ███████░░░  tables AND their RLS policies (Phase 5)
│   └── runbooks/             ██████████  four new runbooks          (Phase 8)
├── geo/
│   ├── spatial.ts            ░░░░░░░░░░  untouched — domain-neutral (Phase 5)
│   ├── mapbox.ts             ██░░░░░░░░  style spec reused verbatim by the UI
│   ├── site-repository.ts    ████████░░  splits: driver + territory
│   └── postgis-queries.ts    ██████░░░░  nearest-driver, containment
├── api/
│   ├── schema.graphql        ██████░░░░  renamed types              (Phase 6)
│   ├── appsync-resolvers.ts  █████░░░░░
│   ├── vtl/                  ███████░░░  3 files — NOT type-checked
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

- [ ] `src/platform/clock.ts` — `now()`, `setTo()`, `advance()`. Fixed epoch for
      demos and tests, advanced for trace replay. Replaces 20 `new Date()` /
      `Date.now()` calls
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

### Interlock with Phase 4

These two phases depend on each other and will deadlock if taken literally:
Phase 2 rewrites `normalise()` to consume vendor payloads, and Phase 4 generates
those payloads. Break the cycle by splitting the work:

- **Phase 2 owns the vendor payload *types*** plus **one hand-written sample per
  vendor** — enough to write and test `normalise()` in isolation.
- **Phase 4 replaces the samples with the generator**, emitting the same types.

The eight samples are throwaway; write them fast and do not polish them.

### Per-tenant vendor subsets (Decision 11)

Today one tenant pulls from all eight connectors. For a carrier that is not
plausible — a truck carries one GPS unit, one ELD and one dashcam. Model it
properly:

| Tenant | Vendors | Why |
|---|---|---|
| `acme-freight` (the demo tenant) | Samsara, Motive, Lytx | GPS + ELD + video — the realistic three-device fleet, and exactly the corroboration the detection rule needs |
| `northstar-logistics` | Geotab, Omnitracs, Netradyne | A different stack entirely, which is the point |
| `pinnacle-transport` | Verizon Connect, Platform Science | Two vendors — proves the rule degrades gracefully |

`registry.ts` gains `connectorsFor(principal)` rather than exporting a flat
list. That turns per-tenant vendor configuration from an assertion into a code
path, and it makes the cross-vendor corroboration story defensible: three
independent devices on one truck genuinely can disagree.

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
   collect ──▶ normalise ──▶ [ src/aws/kinesis.ts ] ──▶ processBatch(records[])
      │                        shards by driverId          │           [NEW]
      ▼                                                    │
   S3 raw                          ┌─────────────────┬─────┴──────────┐
                                   ▼                 ▼                ▼
                          putCurrentPosition   appendHistory      evaluate
                          overwrite, 1/driver  S3, cold path          │
                                [NEW]              [NEW]        resolveTerritory
                                                                 + geofence
                                                                bbox ─▶ exact
                                                                    [NEW]
                                                                      │
                                                                      ▼
                                                                  Exception[]
                                                                      │
                                                                   detect
                                                            corroborate + merge
                                                                      │
                                                                      ▼
                                                                  Incident[]
                                                                      │
                                                                   publish
                                                                      │
                                        ExceptionRaised ◀─────────────┤
                                        IncidentOpened  ◀─────────────┘
                                        (nothing else reaches the bus)
```

1. **A stream stand-in** (Decision 12) — `src/aws/kinesis.ts`, alongside the
   existing DynamoDB / S3 / EventBridge / Step Functions / Bedrock fakes. It
   needs shards keyed by `driverId`, batch delivery with a size and a window,
   and — the part that makes it worth writing — **poison-record bisect**, so
   `BisectBatchOnFunctionError` is demonstrated rather than described. Without
   this file, every batching claim in the repo is a comment.
2. **Hot/cold split** (§1) — `putCurrentPosition()` overwrites one item per
   driver; history appends to the S3 stand-in.
3. **Batched processing** (§2) — `processBatch(records[])`, never per-record.
4. **`enrich` becomes `resolveTerritory`** — it does not disappear. Vendors send
   `[lon, lat]`; the platform resolves which district and which geofences that
   point falls in. Same step, same position in the pipeline, different join.
5. **In-process geofencing** (§4) — wire the existing `bboxAround` /
   `pointInPolygon` from `spatial.ts` into `resolveTerritory` as a two-phase
   check, module-scope cached. *This code already exists and is already tested;
   it just is not on the ingest path yet.*
6. **Only exceptions publish** — delete the `SignalsNormalized` fan-out.

### Where `Exception` and `Incident` are produced

The two-level split from the domain spine maps onto two existing steps, which
is why it costs almost nothing:

| Step | Emits | Rule |
|---|---|---|
| `evaluate` | `Exception[]` | Deterministic per-driver rules over one batch: geofence breach, harsh braking, route deviation, idle, HOS risk, panic |
| `detect` | `Incident[]` | Corroboration and merge across drivers — the thing that pages a human |

### The merge radius is a bug if copied over

`detectIncidents` currently merges sites within **150km**. Sites are cities, so
that is right. Drivers are not: a district is ~50km across, so a 150km radius
merges *every exception in the district into one incident, always*. The
`road-closure` scenario would become indistinguishable from background noise,
and the merge would stop being evidence of anything.

Replace distance-only merging with **corridor identity plus a tight radius**:

```
merge two exceptions when
    same route corridor           (the semantic join — drivers on one road)
    AND within ~3km               (a road closure is a point, not a region)
    AND within a 15-minute window (stale exceptions are not the same event)
```

The time window is new and necessary — sites do not move, drivers do, so two
drivers passing the same point an hour apart are two events, not one.

**~250–350 net new lines**, up from the earlier estimate: the Kinesis stand-in
and the corridor-merge rule are both real code.

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

Six scripted situations, each of which exists to prove one architectural claim.
This is what turns fixture data into an argument:

| Scenario | Proves |
|---|---|
| `road-closure` — 14 DAL drivers deviate together | Spatial merge: **one** incident with 14 affected drivers, not 14 pages |
| `gps-drift` — one driver deviates, nothing corroborates | The two-independent-sources rule: this is **not** an exception |
| `harsh-braking` — telematics and dashcam agree | Cross-vendor corroboration raising a safety exception |
| `hos-risk` — driver approaching hours-of-service limit | The agent + the Step Functions reassignment saga |
| `panic` — driver panic button | "Real-time" means two different things; this path bypasses the batch window entirely — which is only demonstrable because Decision 12 adds a real stream stand-in |
| `poison-record` — one unparseable vendor payload mid-batch | `BisectBatchOnFunctionError`: the batch splits, 3,599 records land, one goes to the failure destination. The classic Kinesis outage, shown not to happen |

`gps-drift` is the most valuable of the six, because it demonstrates the system
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

**Carry the row-level security policies across.** `schema.sql` already enables
RLS on `sites`, `service_regions` and `incidents` with a `tenant_isolation`
policy reading a session variable. That is one of the four layers in the
defence-in-depth claim, and renaming tables without renaming their policies
would silently drop it — the tables would still exist, the isolation would not.
New tables (`drivers`, `territories`, `geofences`, `route_corridors`) each need
the policy attached.

Districts add a second dimension: tenant isolation is the hard boundary, but a
dispatcher scoped to DAL should not read PHX either. Extend the policy to read
both `app.tenant_id` and `app.scope`, or state explicitly that scope is enforced
at the application layer and RLS covers tenancy only. Either is defensible;
leaving it ambiguous is not.

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

Do not miss `src/api/vtl/` — three files named for the old domain:

| File | Becomes |
|---|---|
| `Query.site.request.vtl` | `Query.driver.request.vtl` |
| `Query.site.response.vtl` | `Query.driver.response.vtl` |
| `Query.signals.js` | `Query.telemetry.js` |

These are VTL and APPSYNC_JS resolver code — **not type-checked, not executed by
the test suite, and not covered by the `NetPulse` grep**. They are the single
easiest thing in this migration to leave behind broken.

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

## Phase 11 — Scenario tests

**The 40 existing tests are not this phase's work** (Decision 10). They are
distributed across the phases that break them:

| Test file | Tests | Repaired in |
|---|---|---|
| `platform/tenancy.test.ts` | 9 | Phase 1 — `Principal` gains `scope` |
| `integrations/connector.test.ts` | 9 | Phase 2 — with the hand-written samples |
| `pipeline/pipeline.test.ts` | 13 | Phase 3 — the largest repair |
| `geo/spatial.test.ts` | 9 | Phase 5 — likely untouched; `spatial.ts` does not change |

Every one of them imports `Signal`, `Incident` or `detectIncidents`, so Phase 1
breaks all 40 on contact. Leaving them broken until Phase 11 would mean running
Phases 2–10 with no test signal at all — the exact stretch of work where a
silent rename mistake is most likely and least visible.

The four behaviours they pin — idempotent ingest, cross-tenant denial, the
lon/lat swap, an agent refused a write tool — all survive with new nouns.

### What this phase actually adds

Five assertions that only exist once Phase 4's scenarios do:

- **Telemetry does not reach the event bus.** Run all 3,600 records; assert the
  bus received zero `Telemetry*` events. The architecture's load-bearing claim,
  and the one most likely to be broken by a well-meaning later edit.
- **`gps-drift` raises nothing.** The noise filter, pinned.
- **`road-closure` raises exactly one incident** with 14 affected drivers — and
  fails if the merge radius regresses to something that swallows the district.
- **`poison-record` loses exactly one record.** 3,599 land, one reaches the
  failure destination, the shard does not stall.
- **`panic` bypasses the batch window.** Latency asserted against the clock,
  which is only possible because Decision 4 made it injectable.

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

## Housekeeping — small files, easy to forget

None of these are hard; all of them are invisible to `tsc` and to the test
suite, which is exactly why they get left behind.

| File | What changes | Phase |
|---|---|---|
| `.env.example` | Seven vendor keys (`MERAKI_API_KEY`, `MIST_API_TOKEN`, `ARUBA_CENTRAL_TOKEN`, `GENESYS_*`, `THOUSANDEYES_BEARER`, `SPLUNK_HEC_TOKEN`) → the new vendor set. Drop `MAPBOX_ACCESS_TOKEN` or mark it optional — Decision 5 means nothing needs it. Add `KINESIS_STREAM_NAME` | 0, 2 |
| `package.json` | `name`, `description`, the eight `demo:*` scripts, plus `web` / `web:build` in Phase 9 | 0, 9 |
| `src/api/vtl/` | Three resolver files named for the old domain | 6 |
| `src/data/schema.sql` | RLS policies, not just table names | 5 |
| `.github/workflows/` | Job names, plus a `web` build job | 10 |
| `infra/terraform/` | Tags and resource names — string literals throughout | 10 |

---

## `demo.ts` — the eight sections, respecified

703 lines, touched last, and the point where every rename converges. Fixing the
target now keeps it a rewrite rather than an exploration:

| `--only=` | Now | Becomes |
|---|---|---|
| `auth` | Cognito federation, custom claims, tenant isolation | Same, plus `scope` in the token and a dispatcher who cannot read another district |
| `ingest` | Fan out to 8 vendors, normalise, correlate | Fan out to the tenant's 3 vendors, stream, batch, `resolveTerritory`, evaluate, detect |
| `data` | DynamoDB Query vs Scan | Same, plus the hot/cold split: 60 driver items overwritten vs history appended |
| `events` | EventBridge content routing | Same, plus the proof that 3,600 telemetry records produced zero bus events |
| `graphql` | AppSync resolvers, RBAC, subscriptions | Same, with the district filter as the subscription example |
| `rest` | API Gateway, validation, webhooks | Same |
| `geo` | PostGIS, GeoJSON, TopoJSON, MapBox | Territory containment, geofence bbox→exact, nearest-available-driver |
| `ai` | RAG over runbooks, agent tool loop | Same loop, fleet tools, and the refused `reassignDriver` call |

Two sections earn new material rather than a rename: `events` gains the
zero-telemetry-events proof, and `ingest` gains the batching and poison-record
demonstration. The other six are substitution.

---

## Execution notes

**Ordering:** types → leaves → `demo.ts` last. `demo.ts` is 703 lines
orchestrating all eight sections; touching it early means rewriting it twice.

**Safety net.** `npm run typecheck` after every phase — with a rename this wide,
the compiler catches most of it. But two whole classes of error are invisible to
it, and both need a deliberate pass:

- **String literals.** Event sources (`'netpulse.ingest'`), DynamoDB key
  prefixes, GraphQL field names, Terraform tags. Grep, do not trust `tsc`.
- **Non-TypeScript files.** VTL and APPSYNC_JS resolvers, SQL, HCL, YAML.
  Nothing checks these at all.

**`npm test` must pass at the end of every phase**, which is only possible
because Decision 10 repairs each test file inside the phase that breaks it.

```
   0 ──▶ 1 ──┬──▶ 2 ──▶ 3 ──▶ 4 ──┐
             │                     │
             ├──▶ 5 ───────────────┤
             ├──▶ 6 ───────────────┼──▶ demo.ts ──▶ 9 ──▶ 11 ──▶ 12
             ├──▶ 7 ───────────────┤    (backend)   (web)
             └──▶ 8 ───────────────┘

   10 ──── independent, any point after 0
```

Two real sequencing constraints, both learned the hard way by reading the code:

- **Phase 4 gates Phase 9.** A board with nothing moving on it is not worth
  building twice.
- **Phase 2 and Phase 4 interlock.** Phase 2 writes the vendor payload types and
  one throwaway sample each; Phase 4 replaces the samples with the generator.
  Taken in strict sequence they deadlock.
