# Meridian

**A real-time fleet dispatch platform on AWS serverless.** Telematics ingest,
deterministic exception detection, a live dispatch board, and an AI assistant
that shows its working.

It runs on your machine with **no AWS account and no network**:

```bash
pnpm install
pnpm start       # the backend, narrated, in your terminal
pnpm web         # the dispatch board, at localhost:5180
```

The board opens on a sign-in page. Four demo accounts, no passwords: a district
dispatcher, a safety reviewer, an operations lead and a user from a different
carrier. What each one sees is decided by the token they are issued.

<sub>Node 22+ for the backend — it is TypeScript and Node runs it directly via
type-stripping, so there is no build step. The board is a separate workspace
with its own dependencies.</sub>

---

## What it is

Meridian monitors and dispatches a fleet. It pulls telemetry from the vendors a
carrier actually runs — one GPS unit, one electronic logging device and one
dashcam per truck — normalises eight different vendor dialects into one shape,
decides deterministically what deserves a human's attention, and lets a
dispatcher ask *"this driver is off their route — is it real, and what are my
options?"*

The architecture is sized for **330,000 drivers**. This repository runs a
60-driver synthetic fleet offline, so the whole thing fits in a terminal and in
your head. Where a number is derived from the larger figure rather than
measured, it says so.

### The constraint everything follows from

```
330,000 drivers ÷ one ping per 30s   ≈  11,000 readings/sec sustained
                                        ~950 million/day
peak (shift change, wave dispatch)   ≈  3-5× that
```

Three consequences, and most of the design is one of them:

1. **A Lambda per reading is the wrong shape.** Batch from a stream.
2. **Every reading cannot be a durable operational write.** Current position is
   overwritten in DynamoDB; history is appended to S3 as Parquet.
3. **Fan-out must be filtered server-side.** A dispatcher watching one district
   must not receive — or pay for — 11,000 events/sec of national traffic.

And the decision that falls out of all three: **telemetry does not become
events. Only exceptions do.** That keeps the event bus and everything
downstream proportional to *incidents* rather than to *fleet size*.

---

## The thing worth looking at first

Run `pnpm start --only=scenarios`. Six situations go through the real
pipeline, and each proves one claim:

```
Road closure on I-35E, Dallas
Fourteen affected drivers produce ONE incident, not fourteen pages
    42 readings   28 exceptions   1 incidents
  -> Route deviation affecting 14 drivers in dal

A single GPS spike, Austin
An uncorroborated deviation raises NO incident - the noise filter working
     2 readings    1 exceptions   0 incidents
  -> nothing paged. 1 exception(s) raised, none corroborated.
```

The second one is the point. Any dashboard can light up. A board that pages a
dispatcher fourteen times for one road closure, or wakes them for GPS drift, is
one they learn to ignore — and a board people have learned to ignore is worse
than no board.

---

## How it fits together

```
  Driver app · telematics · ELD · dashcam
        │
        │  8 vendor adapters, one normalise() each; a carrier runs 2-3
        ▼
  Kinesis ──▶ batched consumer ──┬──▶ DynamoDB   current position, overwritten
  (by driverId)                  ├──▶ S3         history, append-only, Parquet
                                 └──▶ rules ──▶ Exception ──▶ Incident
                                                                │
                              only exceptions ──▶ EventBridge ──┤
                                                                ▼
                              AppSync subscription, filtered by district
                                                                │
                                                                ▼
                                                     the dispatch board
```

Aurora PostGIS holds territories, geofences and route corridors — the questions
DynamoDB cannot answer. Cognito carries the district scope in a signed claim.

---

## Where to look

You have limited time, so:

| Read | For |
|---|---|
| `src/platform/types.ts` | The domain model. Everything is built on these types |
| `src/pipeline/steps.ts` | Where readings become exceptions become incidents |
| `src/data/scenarios.ts` | Six scenarios, each proving one claim about the rules |
| `src/aws/kinesis.ts` | Batching, sharding, and the poison-record bisect |
| `web/src/transport/` | Why the whole backend runs inside the browser tab |

One vertical slice, end to end:
`integrations/telematics/samsara.ts` → `pipeline/steps.ts` →
`platform/repository.ts` → `api/appsync-resolvers.ts`. That path touches most
of the stack.

The comments are the documentation. They explain *why*, name the trade-offs,
and flag the mistakes that are easy to make.

---

## Design decisions

- **Telemetry never reaches the event bus.** Readings are persisted and folded
  into hot state; only exceptions are published. A test asserts it, because it
  is the claim most easily broken by a well-meaning edit.
- **Corroboration means two independent signals, not two vendors.** A truck
  carries one GPS unit, so a route deviation can never be seen by two
  telematics vendors — demanding that would make deviations undetectable. What
  makes one real is *different evidence pointing the same way*: off-route **and**
  stationary. Hours-of-service and panic are exempt entirely; a regulatory
  clock is not a sensor to be double-checked.
- **One road closure is one incident.** Exceptions merge on corridor, 3km and a
  15-minute window. An earlier cut of this rule merged within 150km, which is
  wider than a whole district — it would have collapsed every exception in
  Dallas into one permanent incident.
- **Tenancy is a type, not a filter.** Every repository function takes a
  `Principal` and derives the partition key itself. `dynamodb:LeadingKeys`
  enforces the same boundary at AWS, and Postgres row-level security enforces
  it a third time.
- **Scope is signed, not asserted.** A dispatcher's district is stamped into
  the token by a Cognito trigger, so it cannot be widened by editing a request.
  A dispatcher with *no* district gets their own assignments, not the fleet —
  widening access has to be a deliberate grant.
- **An agent acts with the caller's permissions, never the platform's.** That
  one rule is what stops prompt injection from becoming privilege escalation,
  and the board renders refused tool calls so you can watch it happen.
- **Platform primitives are injected** — clock, randomness, hashing, runbook
  loading. That is why two runs produce identical output, and why the same
  domain code runs on Lambda and in a browser.
- **`[longitude, latitude]`.** GeoJSON, PostGIS and MapLibre all use x-then-y;
  humans say the opposite. A swap does not throw — it silently puts Dallas in
  Antarctica.
- **`ST_DWithin`, never `ST_Distance(...) < n`.** The first uses the GiST
  index; the second measures every row in the table.

---

## What is real and what is simulated

Being clear about this matters.

**Real:** every design decision, the AWS resource definitions, the IAM
policies, the GraphQL schema and resolvers, the SQL and its row-level security,
the normalisation logic, the retry and circuit-breaker behaviour, the
corroboration and merge rules, the RAG chunking and hybrid-search maths, the
agent loop, and all the Terraform and GitHub Actions.

**Simulated, so it runs offline:** `src/aws/` stands in for DynamoDB, S3,
EventBridge, Step Functions, Kinesis and Bedrock. Each fake mirrors the real
SDK's method names, and each file's header shows the call it replaces. Vendor
HTTP calls return fixtures instead of hitting the network.

**Synthetic, deliberately:** every driver, position and reading is generated
from a seed. Real driver telemetry is a location trace of an identifiable
person and has no business in a public repository. Vendor payload shapes are
**modelled from published API references, not captured from live accounts** —
Samsara, Motive, Lytx and the rest gate API access behind a customer contract.

**Never deployed:** `infra/` is read-only demonstration material. Nothing here
needs an AWS account.

The offline model in `src/aws/bedrock.ts` is scripted, not intelligent. It
reproduces the one behaviour that matters for understanding agents: emit a
`tool_use` block, receive a `tool_result`, repeat, then answer. The
**embeddings are genuinely computed**, so RAG retrieval really does retrieve —
you can watch the scores move.

---

## Commands

```bash
pnpm start                         # every section, in order
pnpm start --only=scenarios        # the six scenarios — start here
pnpm start --only=ingest           # auth | ingest | scenarios | data | events
pnpm start --only=ai               # graphql | rest | geo | ai
pnpm dev                           # the same, restarting on every save

pnpm test                          # 96 tests, no network
pnpm typecheck

pnpm web                           # the dispatch board
pnpm web:build

pnpm verify                        # all four, in the order that catches most
```

Two runs of `pnpm start` produce identical output apart from wall-clock
durations — CI asserts it. Everything is seeded and the clock is injected, so a
screenshot reproduces and a real change is distinguishable from noise.

---

## Repository

```
src/          the platform. Zero runtime dependencies.
  platform/     domain model, and the injected primitives
  integrations/ 8 vendor connectors, 3 families
  pipeline/     collect → normalise → resolve → evaluate → detect → publish
  geo/          spatial maths, PostGIS queries, GeoJSON/TopoJSON
  ai/           RAG, the agent loop, guardrails
  aws/          local stand-ins for six AWS services
  data/         seeded generator, road corridors, scenarios, runbooks
web/          the dispatch board. React + MapLibre, its own dependencies.
  auth/         sign-in: home-realm discovery, the token trigger, the verifier
  transport/    the boundary that lets the backend run in the browser tab
infra/        Terraform. Read-only.
python/       the same designs as Lambdas, with real boto3 calls.
docs/         how each part of the stack works.
```
