# NetPulse

**A network operations intelligence platform on AWS serverless.** Multi-vendor
ingest, deterministic alarm detection, topology-aware correlation, a live
operations board, and an AI assistant that shows its working.

It runs on your machine with **no AWS account and no network**:

```bash
pnpm install
pnpm start       # the backend, narrated, in your terminal
pnpm web         # the operations board, at localhost:5180
```

The board opens on a sign-in page. Offline there are no passwords — type any
address at one of four registered customer domains (`acme-networks.com`,
`eng.acme-networks.com`, `netpulse.io`, `northwind-utilities.com`) and the same
Cognito logic the Lambdas run mints and verifies a token locally. What you see
afterwards is decided by that token, not by anything on the page: an operator
gets one site, an admin the whole estate, and an unregistered domain gets
nothing at all.

<sub>Node 22+ for the backend — it is TypeScript and Node runs it directly via
type-stripping, so there is no build step. The board is a separate workspace
with its own dependencies.</sub>

---

## What it is

NetPulse watches a mixed Cisco / Juniper / Aruba estate through the vendors'
own cloud APIs — Meraki, Mist and Aruba Central — polled on a schedule and
pushing webhooks back. It adds one thing no vendor can tell you, normalises
three cloud dialects into one shape, decides deterministically what deserves a
human, and lets an engineer ask *"forty devices are alarming — which one do I
actually go and look at?"*

The architecture is sized for **40,000 devices**. This repository runs a
60-device synthetic estate offline, so the whole thing fits in a terminal and in
your head.

### The constraint everything follows from

You are not watching the network. You are watching three vendors' opinions of
it, and the two hard problems are both consequences of that.

**Everything reports twice.** A webhook fires the instant a port drops, and the
poll re-reports the same event minutes later because its watermark deliberately
overlaps. One Meraki call returns both the switch's own event log *and* the
cloud's view of that switch. A platform that counts deliveries as evidence pages
somebody for every port flap in the building.

**A dead device reports nothing, and neither does a degraded API.** Silence is
not an observation, and the failure that matters most is the one the failing
thing cannot describe. Worse, when every feed is one vendor's cloud, "the estate
is down" and "our view of the estate is down" look identical. So the platform
keeps three independent vantage points — what the device reported, what its
cloud concluded, and what our own probe found — and corroboration is defined
over *those*, never over endpoints or transports.

---

## The thing worth looking at first

```bash
pnpm start --only=scenarios
```

Six situations, each proving one claim, all travelling the real
fetch → normalise → collapse → evaluate → correlate path from the JSON these
clouds actually return and POST:

| | Proves |
|---|---|
| One failure, webhook + poll | 2 records → 1 event → **held back**, not paged |
| The same failure from three vantage points | device + controller + probe → **1 incident** |
| A distribution switch dies | 8 alarms across 4 devices → **1 incident, root cause named** |
| One access port flaps alone | recorded, shown, **nobody woken** |
| Three clouds, one event kind | `offline` · `disconnected` · `Down` → one shape, one rule |
| A device nobody registered | dropped, **counted and named** — never silently |

The fourth one is the point of the other five. A board that alerts on everything
is a board people learn to ignore.

---

## How it fits together

```
  POLL  Meraki · Mist · Central     WEBHOOK  the same clouds, inbound
        │  every 5 min, watermarked        │  HMAC + replay window at the edge
        │  three pagination dialects       │  timely, partial, sometimes twice
        ▼                                  ▼
  S3 landing zone ──▶ connector.normalise(raw, inventory, RESOURCE)
        │                                  │
        │      the resource carries the PLANE — one cloud observes from two
        │             + our own probe: the external plane
        ▼                                  ▼
  Kinesis ──▶ batched consumer ──┬──▶ DynamoDB   current status, overwritten
  (by deviceId)                  ├──▶ S3         observation history, Parquet
                                 ├──▶ S3         flows, by exporter, Athena only
                                 └──▶ rules ──▶ Alarm ──▶ Incident
                                                             │
                            only alarms ──▶ EventBridge ─────┤
                                                             ▼
                              AppSync subscription, filtered by site
                                                             │
                                                             ▼
                                                   the operations board
```

Aurora PostGIS holds the inventory and the topology — "everything beneath this
switch" is a recursive CTE and one round trip. Cognito carries the site scope in
a signed claim.

---

## Where to look

You have limited time, so:

| Read | For |
|---|---|
| `src/platform/types.ts` | The domain model. `ObservationPlane` is the load-bearing one |
| `src/integrations/http.ts` | Pagination and watermarks — what cloud APIs share |
| `src/integrations/webhook.ts` | Verifying a delivery on a public endpoint |
| `src/platform/inventory.ts` | The alias→device join — the genuinely hard part |
| `src/pipeline/steps.ts` | Where observations become alarms become incidents |
| `src/data/scenarios.ts` | Six scenarios, each proving one claim about the rules |
| `web/src/transport/` | Why the whole backend runs inside the browser tab |

One vertical slice, end to end:
`integrations/controller/meraki.ts` → `pipeline/steps.ts` →
`platform/repository.ts` → `api/appsync-resolvers.ts`. That path touches most
of the stack.

The comments are the documentation. They explain *why*, name the trade-offs,
and flag the mistakes that are easy to make.

---

## Design decisions

- **`plane` describes ORIGIN, never transport.** Every feed is now cloud HTTP,
  so deriving the plane from the encoding would mark the whole platform
  `controller` — corroboration would be unsatisfiable from vendor data and
  nearly every alarm would be silently held back. The builders require it as an
  argument with no default. One Meraki poll legitimately produces two planes.
- **What cloud APIs share is MECHANICS, not shape.** Meraki, Mist and Central
  JSON have nothing in common but the letters, so there is no shared decoder to
  write. What they do share — three pagination dialects, watermarks, OAuth
  refresh, per-organisation rate limits — is all of it on the critical path,
  and all of it fails silently.
- **Observations never reach the event bus.** They are persisted and folded into
  hot state; only alarms are published. A test asserts it, because it is the
  claim most easily broken by a well-meaning edit.
- **Flows never reach the operational store at all.** Aggregated traffic goes
  to its own bucket, partitioned by exporter, and is read with Athena. It is
  the one class whose volume would make DynamoDB scale with traffic rather than
  with incidents.
- **Corroboration means two independent planes, not two deliveries.** A webhook
  and the poll that re-reports it are one witness talking twice. What counts is
  a different vantage point — the controller, the probe — or the chassis at the
  *other* end of the link. A failed power supply is exempt: nothing else is
  positioned to see it.
- **One dead switch is one incident.** Alarms anchor at the highest alarming
  device in their uplink chain, and everything sharing an anchor is one page
  naming the device to go and look at. The obvious seed-and-sweep algorithm is
  wrong here in a way it is not on a map — see the note in `steps.ts`.
- **Tenancy is a type, not a filter.** Every repository function takes a
  `Principal` and derives the partition key itself. `dynamodb:LeadingKeys`
  enforces the same boundary at AWS, and Postgres row-level security enforces it
  a third time.
- **Scope is signed, not asserted.** An operator's site is stamped into the
  token by a Cognito trigger, so it cannot be widened by editing a request. An
  operator with *no* site claim gets one device, not the estate — widening
  access has to be a deliberate grant.
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
the pagination and watermark logic, the webhook signature verification, the
retry and circuit-breaker behaviour, the corroboration and merge rules, the RAG
chunking and hybrid-search maths, the agent loop, and all the Terraform and
GitHub Actions.

**Simulated, so it runs offline:** `src/aws/` stands in for DynamoDB, S3,
EventBridge, Step Functions, Kinesis and Bedrock. Each fake mirrors the real
SDK's method names, and each file's header shows the call it replaces. Vendor
HTTP calls return fixtures instead of hitting the network.

**Synthetic, deliberately:** every site, device and observation is generated
from a seed. A real device inventory is a map of an identifiable organisation's
internal network and has no business in a public repository. Vendor payload
shapes are **modelled from published API references, not captured from live
accounts** — Meraki, Mist and Aruba Central all gate API access behind a
customer contract. Each cloud's alert-type vocabulary is the least well covered
publicly; verify the mappings against a live tenant before relying on them.

**Deployable, but only one part:** `infra/terraform/auth/` creates a real
Cognito user pool and the token trigger, and costs pennies — see its README.
Everything else under `infra/` is read-only demonstration material describing
the full platform; applying it would bring up Aurora and Kinesis, which bill
whether or not anything uses them. **Nothing here requires an AWS account** —
with no pool configured the board runs the same Cognito logic against a local
issuer.

The offline model in `src/aws/bedrock.ts` is scripted, not intelligent. It
reproduces the one behaviour that matters for understanding agents: emit a
`tool_use` block, receive a `tool_result`, repeat, then answer.

The embeddings are computed rather than faked, but they are a **hashed
bag-of-words, not a semantic model** — two synonyms sharing no tokens score
exactly zero, and a test pins that. So retrieval offline is lexical, ranked and
tenant-filtered for real; what arrives with Titan is the vector's *meaning*,
not the pipeline around it.

---

## Commands

```bash
pnpm start                         # every section, in order
pnpm start --only=scenarios        # the six scenarios — start here
pnpm start --only=ingest           # auth | ingest | scenarios | data | events
pnpm start --only=ai               # graphql | rest | geo | ai
pnpm dev                           # the same, restarting on every save

pnpm test                          # 104 tests, no network
pnpm typecheck

pnpm web                           # the operations board
pnpm web:build

pnpm verify                        # all four, in the order that catches most
```

Two runs of `pnpm start` produce identical output apart from wall-clock
durations — CI asserts it. Everything is seeded and the clock is injected, so a
screenshot reproduces and a real change is distinguishable from noise.

### Hosting

The board is a static site, and the backend runs inside it — the in-process
transport imports the resolvers directly, so deploying `web/` deploys
everything. `vercel.json` at the root builds it with `pnpm web:build` and
serves `web/dist`; the same three settings work on Netlify or Cloudflare
Pages. Import the repo, keep the root directory at the repo root (the build
reaches into `src/`), and enable Corepack so the pinned pnpm is used.

Sign-in works with no AWS account: the board runs Cognito's own logic —
home-realm discovery, the PreTokenGeneration trigger, the verifier's seven
checks — against a local issuer. Set `VITE_COGNITO_DOMAIN`,
`VITE_COGNITO_CLIENT_ID` and `VITE_COGNITO_ISSUER` and it switches to a real
user pool with RS256 verification against the published JWKS;
`infra/terraform/auth/` creates one for pennies a month.

There is no separately hostable API. `src/api/` holds the Lambda handlers and
the rest of `infra/` the Terraform that would run them — read-only material,
and not free to deploy.

---

## Repository

```
src/          the platform. Zero runtime dependencies.
  platform/     domain model, the inventory join, and the injected primitives
  integrations/ cloud connectors, HTTP mechanics, webhook verification, the probe
  pipeline/     collect → normalise → stream → enrich → evaluate → correlate
  geo/          spatial maths, PostGIS queries, GeoJSON/TopoJSON, topology walks
  ai/           RAG, the agent loop, guardrails
  aws/          local stand-ins for six AWS services
  data/         seeded estate generator, scenarios, health trace, runbooks
web/          the operations board. React + MapLibre, its own dependencies.
  auth/         sign-in: home-realm discovery, the token trigger, the verifier
  transport/    the boundary that lets the backend run in the browser tab
infra/        Terraform. Read-only, apart from auth/.
python/       the same designs as Lambdas, with real boto3 calls.
docs/         how each part of the stack works.
```
