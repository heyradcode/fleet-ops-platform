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
is *"architecture sized for 330k drivers; this MVP runs a 12-driver fixture set
offline."* Keep the `(assumption)` markers the write-up already carries.

This repository is a **reference slice of an architecture**, runnable offline —
not a copy of a production system. That distinction is what stops it reading as
too-good-to-be-true, which is the whole point of the exercise.

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
  Driver app · vehicle telematics · ELD · dashcam · sensors
        │              │             │        │
        └──────────────┴──────┬──────┴────────┘   8 vendor adapters,
                              │                   one normalise() each
                   ┌──────────▼───────────┐
                   │ Kinesis Data Streams │  partitioned by driverId
                   │ (ordered per driver) │  ordering only where it matters
                   └──────────┬───────────┘
                              │  BATCHED — never one invocation per event
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
  ┌─────▼───────┐   ┌─────────▼─────────┐  ┌────────▼─────────┐
  │ Hot state   │   │ Rules + geofence  │  │ Firehose ──▶ S3  │
  │ DynamoDB    │   │ evaluation        │  │ history (parquet)│
  │ 1 item per  │   │ bbox ─▶ exact,    │  │ Athena           │
  │ driver,     │   │ in-process        │  └──────────────────┘
  │ overwritten │   └─────────┬─────────┘
  └─────┬───────┘             │
        │                     │  ONLY EXCEPTIONS BECOME EVENTS
        │           ┌─────────▼─────────┐
        │           │   EventBridge     │  geofence breach, harsh braking,
        │           │  custom event bus │  route deviation, idle, panic
        │           └───┬────┬──────┬───┘
        │               │    │      └──── dispatch / reassignment
        │       safety ─┘    └─ on-call         (Step Functions saga)
        │
  ┌─────▼────────────────────────────────────────────────────┐
  │ AppSync subscriptions — the live dispatch board           │
  │ server-side filter by district / status / exception type  │
  └───────────────────────────────────────────────────────────┘

  ┌───────────────────────────────────────────────────────────┐
  │ Aurora PostGIS — territories, facilities, route corridors, │
  │ geofence polygons, spatial queries                         │
  └───────────────────────────────────────────────────────────┘

  ┌───────────────────────────────────────────────────────────┐
  │ Cognito — dispatchers via SAML/OIDC · drivers device-bound │
  │ token carries district scope; nothing accepts a bare id    │
  └───────────────────────────────────────────────────────────┘
```

The load-bearing decision is visible in the middle: **telemetry does not become
events — only exceptions do.** Eleven thousand position updates per second
through a content-filtered event bus would be both slow and ruinous. The same
volume into a key-value overwrite plus a batched rules pass is routine.

---

## What actually changes, by file

```
src/
├── platform/
│   ├── types.ts              ██████████  rewritten — the keystone   (Phase 1)
│   ├── tenancy.ts            ███░░░░░░░  + scope alongside tenantId
│   └── repository.ts         █████░░░░░  hot-state write path
├── integrations/
│   ├── network/              ████████░░  → telematics/              (Phase 2)
│   ├── contact-center/       ████████░░  → eld-hos/
│   ├── observability/        ████████░░  → video-safety/
│   ├── connector.ts          ░░░░░░░░░░  untouched — retry + breaker generic
│   └── fixtures.ts           ██████████  new vendor payloads
├── pipeline/
│   └── steps.ts              ███████░░░  +200-250 new lines         (Phase 3)
├── geo/
│   ├── spatial.ts            ░░░░░░░░░░  untouched — domain-neutral (Phase 4)
│   ├── site-repository.ts    ████████░░  splits: driver + territory
│   └── postgis-queries.ts    ██████░░░░  nearest-driver, containment
├── api/
│   ├── schema.graphql        ██████░░░░  renamed types              (Phase 5)
│   ├── appsync-resolvers.ts  █████░░░░░
│   └── subscriptions.ts      ░░░░░░░░░░  untouched — filter engine already right
├── auth/                     ███░░░░░░░  + Principal.scope          (Phase 6)
├── ai/
│   ├── agent-core.ts         ░░░░░░░░░░  untouched                  (Phase 7)
│   ├── guardrails.ts         ░░░░░░░░░░  untouched
│   └── tools.ts              ████████░░  new tools, same contract
└── demo.ts                   ███████░░░  LAST — orchestrates all eight sections
```

Four files come through completely untouched — `spatial.ts`, `subscriptions.ts`,
`agent-core.ts`, `guardrails.ts`. That is the evidence the abstractions were
drawn in the right places, and it is worth saying out loud when presenting this.

---

## Phase 0 — Naming

Blocks everything: every subsequent phase writes the name into comments.

- [ ] Decide product name and repo name (repo = product + domain suffix, so it
      is scannable in a repo list)
- [ ] Rename the directory; drop `_demo` and the underscore, use kebab-case
- [ ] Update `package.json`
- [ ] Replace 90 occurrences of `NetPulse` across 37 files

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

---

## Phase 2 — Connectors

**`src/integrations/`** — 8 connector files + `registry.ts` + `fixtures.ts`.

Straight substitution, keeping the 3/3/2 shape:

| Now | Becomes |
|---|---|
| `network/` — Cisco Meraki, Juniper Mist, Aruba Central | `telematics/` — **Samsara**, **Geotab**, **Verizon Connect** |
| `contact-center/` — Genesys, Five9, Amazon Connect | `eld-hos/` — **Motive**, **Omnitracs**, **Platform Science** |
| `observability/` — ThousandEyes, Splunk | `video-safety/` — **Lytx**, **Netradyne** |

Each connector's `normalise()` is rewritten to emit `Telemetry`. The retry,
circuit-breaker and registry scaffolding is untouched. `fixtures.ts` gets
vendor-shaped GPS / HOS / safety-event payloads.

---

## Phase 3 — Pipeline and the scale mechanisms

**`src/pipeline/`** — `steps.ts`, `ingest-workflow.ts`, `state-machine.asl.json`.

The phase that earns the repo its architecture claim, and the only one that is
more than a reskin:

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

**~200–250 net new lines.** Everything else in this plan is substitution.

---

## Phase 4 — Geospatial

**`src/geo/`, `src/data/`**

- `spatial.ts` is domain-neutral — **untouched**
- `site-repository.ts` → `driver-repository.ts` + `territory-repository.ts`
- `postgis-queries.ts` — nearest-site becomes nearest-available-driver;
  add territory containment and route-corridor adherence
- `schema.sql` — `drivers`, `territories`, `geofences`, `route_corridors`
- `data/sites.ts` → ~12 drivers across the existing five cities, now districts

---

## Phase 5 — API

**`src/api/`** (622 lines including the schema).

`schema.graphql` renames types and adds the filtered subscription the write-up
names explicitly:

```graphql
onDriverException(district: ID, severity: Severity): Exception
```

`subscriptions.ts` needs **no logic change** — its filter engine already does
server-side matching, and `demo.ts` already proves the unmatched watcher is
never woken. That demo moment gets considerably stronger when the filter is a
district rather than a severity.

---

## Phase 6 — Auth

**`src/auth/`**

Two populations, one model: dispatchers via enterprise SSO (SAML / OIDC),
drivers device-bound and offline-tolerant. `pre-token-generation.ts` injects
`scope` alongside `tenantId`. Small phase.

---

## Phase 7 — AI

**`src/ai/`, `src/data/runbooks/`**

New tools: `queryDriverTelemetry`, `findNearbyAvailableDrivers` (spatial),
`getRoutePlan`, `reassignDriver` (the write tool the guardrail refuses).

New runbooks: route deviation, harsh-braking review, HOS-violation risk,
vehicle breakdown.

`agent-core.ts` and `guardrails.ts` are **unchanged** — the write-up says the
agent "maps over almost unchanged," and that is accurate.

---

## Phase 8 — Infra, Python, CI

- Terraform: rename tags and resources; add `kinesis` + `firehose` modules so
  the stream-batching argument has something concrete to point at
- `python/` handlers reskin
- `.github/workflows/` need only name changes

Independent of Phases 1–7; can run at any point after Phase 0.

---

## Phase 9 — Tests

40 tests. The four behaviours they pin — idempotent ingest, cross-tenant
denial, the lon/lat swap, an agent refused a write tool — all survive the
rename with new nouns.

**Add one:** *telemetry does not reach the event bus; only exceptions do.* That
is the architecture's load-bearing claim and it should fail loudly if someone
breaks it.

---

## Phase 10 — Docs and framing

The structural move: **`portfolio/03-fleet-management-platform.md` stops being a
portfolio write-up and becomes the repo's `docs/01-architecture.md`.** It is
already better than the current architecture doc.

That leaves `portfolio/01` (AI fabric) and `portfolio/02` (logistics) as
write-ups of *other* systems — either a `docs/other-platforms/` folder, or
dropped from the repo.

- [ ] `README.md` rewritten around the product; the *"Where each JD requirement
      lives"* table — the thing that makes it read as JD-shaped — goes away
- [ ] `docs/00-start-here.md` reframed from interview prep to project orientation
- [ ] `docs/09-interview-cheatsheet.md` leaves the repo, or loses its "on the
      day" voice
- [ ] The nine primers keep their content, lose the JD framing — they become
      "how this stack works," which is portfolio-appropriate
- [ ] This file is deleted once the migration lands

---

## Execution notes

**Ordering:** types → leaves → `demo.ts` last. `demo.ts` is 703 lines
orchestrating all eight sections; touching it early means rewriting it twice.

**Safety net:** run `npm run typecheck` after every phase. With a rename this
wide, the compiler is what catches the misses. `npm test` after phases 3, 5
and 7.

```
        ┌─▶ 2 ──▶ 3 ─┐
        │            │
   0 ──▶ 1 ─┼─▶ 4 ──────┤
        │            │
        ├─▶ 5 ──────┤──▶ demo.ts ──▶ 9 ──▶ 10
        │            │
        ├─▶ 6 ──────┤
        │            │
        └─▶ 7 ──────┘

   8 ──── independent, any point after 0
```
