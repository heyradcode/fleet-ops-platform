# NetPulse — working notes

A network operations intelligence platform on AWS serverless, runnable entirely
offline. Two workspaces: the backend in `src/` (zero runtime dependencies) and
the operations board in `web/` (React + MapLibre, its own dependencies).

Every feed is a vendor's cloud HTTP API — Meraki, Mist and Aruba Central, polled
on a schedule and pushing webhooks at us — plus our own probes. They land in S3,
are normalised into one canonical `Observation`, and become alarms and then
incidents.

There is no syslog, SNMP, IPFIX or gNMI. There was, and the decoder-per-encoding
split that served it is gone with it; see the note on `plane` below for the one
piece of that design that had to survive in a different form.

## Commands

This repo uses **pnpm**, not npm. The lockfile and the non-hoisted layout both
assume it, and `npm install` would flatten `web/`'s dependencies into a place
`src/` can import from - which quietly breaks the zero-dependency backend.

```bash
pnpm install
pnpm start                      # the backend demo, narrated, all sections
pnpm start --only=scenarios     # the six scenarios — the best 30 seconds here
pnpm dev                        # the same, restarting on every save (nodemon)
pnpm test                       # 292 tests, no network. Picks up web/ tests too.
pnpm typecheck                  # backend
pnpm web                        # operations board, http://localhost:5180 - real Cognito sign-in
pnpm web:env                    # write web/.env.cognito.local from the Terraform outputs
pnpm build:agent                # bundle the AgentCore agent (docs/11-agentcore.md)
pnpm web:build                  # typechecks web/ AND builds it
pnpm mock                       # mock Teams/Genesys/Webex APIs, http://127.0.0.1:5190
pnpm check:promises             # no un-awaited or misused promise, backend and web/
pnpm seed:aws --dry-run         # fill the REAL table (needs TABLE_NAME); --dry-run needs no AWS
pnpm verify                     # all five checks, in order
```

`--only=` takes: `auth ingest scenarios data events graphql rest geo ai comms solarwinds brief`.
Note `pnpm start --only=x` needs no `--` separator; npm did.

`pnpm verify` runs typecheck, the promise check, tests, the demo and the web build in that order.
Each catches something the others do not - and none of them catches everything,
which is why the list ends with actually reading the demo output.

## Invariants — break these and something silently stops working

**No `node:` builtins outside `src/platform/runbook-loader.node.ts` and tests.**
The board imports the backend directly and runs it in the browser tab. A
bundler resolves imports whether or not the code path executes, so one static
`node:fs` anywhere in the shared graph breaks the web build. CI enforces this.
Anything platform-specific goes behind `src/platform/` — that is what
`clock.ts`, `crypto.ts`, `random.ts` and `runbook-loader.ts` are for.

**XML goes through `platform/xml.ts`.** No `DOMParser` in Node, no
dependencies in the shared graph. It REFUSES any DOCTYPE (no XXE, no entity
expansion) and bounds size and depth. Kurmi's SOAP will need it too.

**No `Buffer`.** Same reason. `platform/crypto.ts` has `b64urlEncode` /
`b64urlDecode`. The webhook HMAC verification in `integrations/webhook.ts` is
built on those, and must stay that way — it runs in the browser graph too.

**`plane` is NEVER derived from `encoding`.** It was, correctly, while syslog
meant "the box said so" and REST meant "its cloud said so". Every feed is now
cloud HTTP, so deriving it would mark the whole platform `controller`,
`planes.length >= 2` would be unsatisfiable from vendor data, and nearly every
alarm would be silently held back. The builders take `plane` as a required
argument with no default; a new connector cannot compile until its author has
decided, per endpoint, where the knowledge actually came from. One Meraki poll
legitimately produces both planes.

**Everything is deterministic.** Never `new Date()`, `Date.now()` or
`Math.random()` — use `platform/clock.ts` and `platform/random.ts`. Two
`pnpm start` runs must produce identical output apart from wall-clock
durations, and CI diffs them. This is what makes a screenshot reproducible and
a real change distinguishable from noise.

**`loadEstate()` is idempotent, and that is load-bearing.** The generator draws
from the seeded random source, so regenerating advances it — a second call
produces a differently shuffled estate *and* shifts every subsequent uuid. Pass
`force` only when you genuinely want a fresh draw.

**No TypeScript `enum`, `namespace`, parameter properties or decorators.**
`node src/demo.ts` runs TS via type-stripping, which cannot handle anything
requiring code generation. `tsc` stays green and `pnpm start` dies at runtime.
Use union types, as the existing code does.

**Imports carry `.ts` extensions.** Required by type-stripping. `web/` handles
this via `allowImportingTsExtensions`.

**Only `infra/terraform/auth/` and `infra/terraform/agentcore/` are ever
applied.** `agentcore/` is the assistant on Bedrock AgentCore Runtime - a
SEPARATE root because it needs AWS provider 6.x and `auth/` is on 5.x with a
live deployment; it reads `auth/`'s state and changes nothing there. `auth/`
creates a Cognito pool,
the token trigger, the membership table and the main on-demand DynamoDB
table, and costs pennies. The main table is filled by `pnpm seed:aws`
through `aws/dynamodb.sdk.ts` - the SDK adapter, imported only by Node entry
points outside `src/` and by tests; CI greps for that too. Every other root
is read-only demonstration material: applying `envs/` brings up Aurora (~$87/month idle at
a 0.5 ACU floor × 2 instances) and Kinesis (~$29/month, no free tier), and
anything wanting a Bedrock Knowledge Base drags in OpenSearch Serverless at
~$700/month. Nothing in this repo *needs* an AWS account.

## Rules that are load-bearing and easy to break

These are the claims the architecture rests on. Each has a test; if you change
one, change the test deliberately rather than making it pass.

- **What crosses the bus is a PROJECTION, not the record.** `AlarmEventDetail`
  and `IncidentEventDetail` name it, and producers use `satisfies`. A consumer
  casting `e.detail as Alarm` compiles and then throws on every delivery,
  because the bus never carried the field - which is exactly how the Splunk
  forwarder broke. If a consumer needs a field, widen the projection; do NOT
  re-read the record, which is one GetItem per event on the hot path.
- **Splunk gets alarms and incidents, never observations.** It licenses by
  INDEXED VOLUME PER DAY, so the same argument that keeps observations off the
  bus keeps them out of Splunk - and here the bill is metered rather than
  amortised. Bulk stays in S3/Athena. Splunk is a bus consumer, so adding it
  changed nothing that produces events.
- **Splunk is NOT an observation plane.** Tempting, and the same mistake as
  deriving `plane` from `encoding` in a new hat: if the customer's Splunk
  ingests the Meraki API, a Splunk row agreeing with Meraki is one vendor
  corroborating itself through a proxy. Search results are CONTEXT for a human
  and for the agent; they never become Observations and never reach the rules.
- **Observations never reach the event bus.** Only alarms and incidents are
  published. An estate produces far more observations than decisions, and
  publishing them would make cost scale with estate size instead of incidents.
- **Flows never reach the operational store at all.** Aggregated traffic
  records go to their own S3 bucket, partitioned by exporter, and are queried
  with Athena. They are the one observation class whose volume would make
  DynamoDB scale with traffic rather than with incidents.
- **Corroboration means two independent PLANES, not two endpoints.** One Meraki
  poll returns the switch's own reported events *and* the cloud's opinion of
  that switch; a webhook and the poll that later re-reports it are one witness
  twice over. Independence means a different vantage point: the device, its
  controller, or our own probe. The far end of a link counts too — same plane,
  different chassis. `power-fault` is exempt: a chassis reporting its own dead
  PSU has no second opinion available.
- **SolarWinds is a poller WE run, so it observes from two planes.** Its ICMP
  node status is EXTERNAL - the same plane as our probe, so a tenant running
  both has one external witness, not two. The SNMP counters it relays (CPU,
  interfaces) are DEVICE. Its ALERTS are never ingested: Orion's conclusions
  from the same polls would be one witness twice. Only Up/Down/Unreachable
  are measurements - Warning/Critical are Orion threshold opinions, Unmanaged
  is muted, CPU -2 is "unknown", an admin-down port is a decision. SWQL comes
  from a fixed catalogue with values BOUND as declared `@parameters`; no time
  filter, because Orion `LastSync` columns have no zone.
- **Inverted metric thresholds are easy to write backwards and nothing fails.**
  Reachability was [1, 1] - every reachable device `critical` - for a release;
  alarms test `value === 0` directly, so only the map and the agent were
  wrong. `classify.test.ts` pins both inverted metrics now.
- **Duplicates collapse BEFORE the rules run.** `collapseDuplicates` folds
  records sharing a `dedupeKey`. Skip it and `evaluate` counts one port flap as
  four pieces of evidence and pages somebody.
- **Merging is by TOPOLOGY, anchored at the cause.** Each alarm anchors at the
  highest device in its uplink chain that is also alarming; alarms sharing an
  anchor are one incident. The obvious seed-and-sweep algorithm is wrong: two
  access switches under one dead distribution switch are not related *to each
  other*, so whichever seeded first claimed the parent and the rest each became
  their own page. Geometry hides this — proximity is symmetric, a tree is not.
- **Only `TOPOLOGY_CAUSED` alarm kinds merge.** A dead switch fires link-down,
  device-unreachable *and* adjacency-lost; merging only same-kind would page
  three times for one failure. Interface errors and optical degradation are
  about that box and never merge.
- **The merge window is 10 minutes.** Failures propagate over minutes — access
  switches notice in seconds, their APs time out over a minute or two, a
  routing adjacency takes three. Under five minutes splits one outage into
  several pages; an hour collapses an afternoon of flapping into one permanent
  incident.
- **Comms data is people and subjects, not devices.** Teams, Genesys and
  Webex produce a workforce (joined on the lower-cased email) and SIGNALS about
  trunks, facilities and queues. They have their own types in
  `integrations/comms/`; do not push them through `Observation`/`Alarm`, which
  are keyed on a DeviceId that would have to be faked.
- **Call records are aggregated before any rule sees them.** One number per
  (subject, kind, window), and no rate below its minimum sample - the same
  argument that keeps flows out of the operational store.
- **Facility call quality needs two SERVICES to agree.** It is an inference
  about a site's network; Teams alone can be wrong (a client build, a media
  region). A trunk's failure rate and a queue's backlog are the system of
  record counting itself, and are exempt. A source that measured the same
  subject and saw nothing wrong DISPUTES an inference (holds it back, named) -
  but only LOCALISES a count: a trunk failing Teams's calls is failing them
  even if Bandwidth's end is fine, and the healthy end says which leg is bad.
- **Bandwidth is the carrier's end of the same SBC, not a paging gate.** It
  sees what Teams structurally cannot: a dead SBC's inbound calls fail AT the
  carrier and never reach Teams, so the Direct Routing report has no row for
  them. Peers map to SBC FQDNs by PEER ID; an unmapped peer keeps its own name
  and still pages. The call-outcomes read (`fetchPeerOutcomes`) is a
  PLACEHOLDER shape until the Insights reference is in hand - change it there
  and in the mock, nowhere else. The CDR API is daily and not for detection.
- **Helix is CONTEXT, never evidence - and read-only.** Like Splunk: a
  change record never becomes a signal and cannot page or suppress anything.
  It is attached AFTER the rules decide, as a CANDIDATE explanation, and every
  surface says "candidate". Matching goes through tenant tables (Helix site ->
  facility, CI -> SBC); queues get no context rather than a guess from ticket
  text. A Helix outage marks context UNKNOWN - never "no changes" - and never
  fails the poll. Writing tickets is a separate, unmade decision.
- **One comms source failing costs that source, never the poll.** Each pull
  and each signal read is isolated; the failure lands in integration health
  (`comms/health.ts`) and in `evaluateSignals({ unavailable })`, so an
  inference missing its second witness says "Webex was UNAVAILABLE" rather
  than "single source" - could-not-ask is not saw-nothing. A down source's
  columns are ABSENT from the split, not zero. Health status is coarse
  (healthy / degraded / down / not-configured, plus `stale` after 15 min);
  permanent limits are CAVEATS, never a status - a tile that is always amber
  teaches people to ignore amber. Data-quality issues always name the fix.
- **A comms incident resolves on a HEALTHY MEASUREMENT, never on silence.**
  One open incident per subject (`comms/lifecycle.ts`), keeping its id and
  opening time across polls. A poll counts toward resolution only when every
  kind in the incident was MEASURED `ok` on that subject; three in a row
  resolve it. A source that was down, or too few samples, is UNKNOWN - it
  neither counts nor resets. Still firing but held back RESETS. A dead SBC at
  3am produces no signal at all, which is exactly why "no alarm" is not
  "recovered". Back within 30 minutes reopens the same incident (flap count),
  it does not open a new one.
- **Changes are looked up UP the uplink chain, never sideways.** The agent's
  `recentChanges` tool (`ai/itsm-tools.ts`) checks Helix for the device, then
  each hop above it: a change on the core can kill a distribution switch; a
  change on its SIBLING shares a parent, not a cause, and is never listed.
  Helix CI names join through the device aliases via `inventory.peekDevice`,
  which does NOT record a miss - a CMDB is full of printers and servers, and
  counting them would make inventory drift measure the CMDB. The Helix client
  comes from a registry (`setHelixClientFactory`), like the Splunk transport;
  unset means "not configured", said as such.
- **The daily brief's numbers never come from a model.** `reporting/daily-brief.ts`
  builds a structured `Brief` from stored incidents, their structured
  `figures`, health and counts; the prose is a template over it. Consumers
  that need a number read `CommsIncident.figures`, never a regex over an
  evidence sentence. People at a facility are UNIQUE (`byFacility[].people`),
  never the sum of platform columns, which double-counts the overlap. Nothing
  open but a feed down is AMBER with the feed named - never a calm green over
  missing data. Delivery (scheduler + SES/Teams) is documented, not wired:
  mailing executives is the customer's decision.
- **Anomalies are unusual for THIS subject at THIS hour of the week - and
  never alarms.** `comms/anomalies.ts` keeps Welford running stats per
  (subject, metric, source, hour-of-week) in the CUSTOMER's zone via `Intl` -
  a fixed UTC offset moves every bucket an hour at each DST change. It never
  learns an outage: anomalous values and subjects with an open incident are
  not folded in. No verdict under 4 weeks of history. Counts get a sqrt(mean)
  spread floor (Poisson noise) and a minimum change, so one caller where
  there are usually none is not news. Volume is a metric - a dead SBC's
  SILENCE is found as calls-through far below normal. Backfill reads past
  windows through an injected reader; offline, `mockHistory` moves the clock.
  Rates over ~30 calls are noisy: a sub-threshold abandonment plant realised
  as 2 calls and was, correctly, not flagged.
- **The workforce roster is never persisted.** The join links named people
  to agencies and buildings; the store keeps counts only, and the roster is
  rebuilt each poll. Comms reads need TENANT scope until an agency/facility
  scope exists - a site is not a facility. The comms agent tools are offered
  per tenant via `toolSpecsFor`; `TOOL_SPECS` stays the network set.
- **The board's data views have ONE implementation.** `boardSnapshot` and
  `commsSnapshot` in `src/api/board-api.ts` are what the in-process
  transport calls in the tab AND what the board API serves from Lambda;
  `web/src/transport/select.ts` picks the transport. Scope bounds ALARMS
  and INCIDENTS as well as devices - they used to be filtered by the
  requested site only, so a Dallas operator asking for Austin got Austin's
  alarm, invisible offline (Phoenix has none) and a leak over HTTP. The API
  re-verifies the token with all seven checks: the gateway's JWT authorizer
  does not check `token_use` or the tenant claim.
- **What the rules decided is a pure function of the TENANT.**
  `tenantScenarios` reseeds before replaying: alarm and incident ids come
  from the seeded uuid stream, and each replay used to continue it, so the
  board and its live feed - merged BY alarmId - gave one alarm two ids. A
  warm Lambda reseeds per request for the same reason; that is safe only
  because a container handles one request at a time.
- **The model is a REGISTRY, and the deployed agent is READ-ONLY.**
  `invokeModel` (`aws/bedrock.ts`) runs the scripted offline model unless a
  Node entry registers Claude (`aws/bedrock.sdk.ts`, AnthropicBedrockMantle);
  `agent_model = "offline"` is a valid deployment. The AgentCore agent is
  offered `READ_ONLY_TOOL_SPECS` and the loop now REFUSES any tool it did
  not offer - a real model can name one it was never shown. Its IAM role
  can only GetItem/Query. The token is verified TWICE: AgentCore Identity
  checks issuer, signature, expiry and client_id; `agent-invocation.ts`
  re-runs all seven checks, because neither `token_use` nor the tenant claim
  is AgentCore's to check. `allowedClients`, never `allowedAudience`: a
  Cognito access token has no `aud`.
- **Scope comes from the token, not the request.** Repository and resolver
  functions take a `Principal` and derive keys from it. An operator with no site
  claim gets *device* scope, not the whole estate — widening access is a
  deliberate grant.

## Data

All synthetic, all seeded. `src/data/estate.ts` builds 60 devices across 5
uneven sites (Dallas 16, others 11) in a two-tier topology — core → distribution
→ access → AP, plus a WAN edge. The vendor is per SITE, not per tenant, because
that is what estates look like after an acquisition.

`scenarios.ts` holds six situations that each prove one claim and emit
**vendor-shaped payloads** — the JSON these clouds actually return and POST — so
they travel the real fetch → normalise → collapse → evaluate → correlate path.
Devices are selected by role and vendor, never by literal name, so a generator
change fails loudly instead of silently proving nothing.

`trace.ts` records a half-hour of a cascade for the board's replay scrubber.
Nothing on a network map moves, so what replays is STATE, not position.

Vendor fixtures are **modelled from published API references, not captured
from live accounts** — Meraki, Mist and Aruba Central all gate API access
behind a customer contract. Say so if you add one; do not imply captured data.
Each cloud's alert-type vocabulary is the least well covered publicly; verify
the mappings against a live tenant before relying on them.

Real device inventories are a map of an identifiable organisation's internal
network. Nothing real belongs in this repo.

## Gotchas found the hard way

- **`process` does not exist in a browser.** Not undefined - UNBOUND, so
  `process.env.FOO` throws. Every read of it was at module scope, so the board
  was a blank page. Configuration goes through `platform/env.ts`. This is the
  bug that motivated the browser-contract test, which loads the whole graph
  with `process` and `Buffer` deleted. It happened a second time with
  `process.stdout` in the logger - the graph loaded, the board rendered, and
  the assistant failed on its first log line. Output goes through `out()` in
  `platform/logger.ts`; the contract test now asks the agent a question, and
  CI greps for any `process.` member, not just `.env`.
- **Splunk wants EPOCH SECONDS and newline-delimited objects.** Milliseconds
  index the event in the year 56000; a JSON array indexes the whole batch as
  ONE event. Both return 200, both look like success, and both leave the
  customer paying for an index their searches cannot see.
- **AR qualifications are BUILT, never concatenated** (`qualification()` in
  `comms/helix.ts`). `q=` is a query language; values are escaped by doubling
  `"`, field names checked against an allow-pattern. Always send
  `fields=values(...)`: without it a ticket returns the submitter's name and
  email. Auth is `AR-JWT <token>`, not Bearer, and the login returns a bare
  text token with no expiry. Timestamps are `+0000` with no colon.
- **Starlink telemetry is a STREAM whose position the SERVER advances on
  send.** The watermark rule is inverted and we cannot change it, so every
  response body is archived raw to S3 BEFORE it is parsed - the archive is
  then the only copy. Positions are per SERVICE ACCOUNT: one per environment,
  or dev and prod each silently get a share. Retention is 8 hours. Columns are
  found by NAME per device type and alert codes mapped through the response's
  own enums (the mock's alert names are placeholders). `UtcTimestampNs`
  exceeds 2^53 - fine for ms maths, never an identity. The published client
  caches its token in a STATIC field, shared across tenants; ours is per
  client. A dish's sample count is a clock, not traffic - no volume baseline.
- **911Inform is NOT built: there is no public API documentation.** Do not
  invent one; it needs the vendor's or HHS's reference first, as Kurmi's
  schema did.
- **Kurmi is SOAP: HTTP 200 is not success, and paging is not guessed.**
  `<status>` in the body decides; a 200 with FAILURE is a failure. Credentials
  travel IN the envelope - `client.soap()` hands them to the builder so the
  connector never holds them, every value is XML-escaped, and no request body
  is ever logged. The response flags `listIsNotComplete` but the one sample
  shows no paging parameter, and a guessed one the server ignores returns page
  one forever - so a truncated search is PARTITIONED by `ciscoName` MAC
  prefix (`SEP0`..`SEPF`, twice), and a slice still truncated marks the
  inventory incomplete. The field is `kurmiDepartment` (lower-case k); the
  facility is the path's LEAF via a tenant table. Agency codes outside the
  configured set are counted and named - the real sample's were `DPS`/`VDH`,
  i.e. not HHS at all. Phones are DEVICES: their own inventory, never
  columns in the (people) workforce.
- **The agent never composes SPL.** It picks from a catalogue by name and
  passes typed parameters. SPL has commands that write (`collect`,
  `outputlookup`) and run scripts, so an injected pipe is not a data leak, it
  is code execution inside the customer's SIEM.
- **A webhook endpoint on the public internet is not protected by its URL.**
  Verify the HMAC BEFORE the timestamp and both before `JSON.parse`: checking
  the clock first tells an unauthenticated caller whether their guess was in
  range, and parsing first runs a parser on unauthenticated input. The
  timestamp must be INSIDE the signed payload, or an attacker edits it and
  replays yesterday. The nastiest forgery is not a false alarm - it is a
  `port_up` that CLEARS a real incident.
- **The raw webhook body must reach the verifier byte-for-byte.** Re-serialising
  parsed JSON changes key order and whitespace, the HMAC stops matching, and
  the symptom is "every delivery is rejected as forged" pointing at a signature
  check that is completely correct.
- **One device, several vendor handles.** A cloud knows a box by a serial or a
  MAC, never by the hostname on it, and connectors legitimately try more than
  one. Use `resolveDeviceAny`, not two `resolveDevice` calls: the latter records
  TWO unresolved misses for one unknown device, and the inventory-drift number
  then counts attempts rather than devices.
- **Pagination failures are silent.** Three clouds, three dialects — a `Link`
  header, one-indexed pages, and offsets. Stop a page early and nothing errors;
  you simply get a SHORTER ESTATE, and the board looks calm. `drainPages` owns
  the loop, the ceiling and the `truncated` flag for exactly that reason.
- **Watermarks advance AFTER the write, never at fetch time.** They record what
  was persisted. Advance one at collect time and a crash between fetch and write
  loses that window permanently — the next poll asks for everything after it,
  the gap is never re-requested, and nothing reports a problem. They also
  overlap by two minutes, because cloud APIs are eventually consistent and an
  exactly-abutting `since` drops events that became visible late.
- **Aruba Central OAuth refreshes EARLY, not on expiry.** A token that dies
  mid-poll gives a 401 on page four of seven; 401 is correctly non-retryable, so
  the run ends with a partial estate and no obvious cause. Sixty seconds of
  headroom removes the whole class. The cache is per tenant - a shared one would
  hand tenant A's token to tenant B's poll.
- **A Cognito PreTokenGeneration trigger must be V2_0.** V1 writes claims to
  the ID token only, and this platform authorises on the ACCESS token
  (`token_use: 'access'` is check 4). A V1-wired pool signs people in and
  hands them a token with no tenant claim, which the verifier then rejects —
  so the symptom is "nobody can sign in" pointing at code that is correct.
  Terraform pins it; a test pins the response shape.
- **The Entra directory is synced by DELTA, and the first sync spans runs.**
  75,000 users is ~76 pages, past the per-run ceiling, so `syncEntraDirectory`
  saves the nextLink it stopped at and resumes there. A full sync writes a new
  GENERATION and flips to it only when its last page lands - readers never
  see a half-built directory. Delta rows carry ONLY changed properties: merge
  them, never overwrite. The deltaLink is saved after the writes, like every
  watermark. A 410 means the token expired: resync, serving the old copy.
  Stored per user: a per-tenant salted hash of the address and a facility
  code - never the address.
- **The store is ASYNC, and a missing `await` is invisible to every test.**
  `mainTable` forwards to a `TableStore` (`aws/dynamodb.ts`) - in memory by
  default, DynamoDB when a Lambda entry point calls `setTableStore`. The
  in-memory table writes BEFORE its promise returns, so an un-awaited put
  passes tests, demo and build, and against DynamoDB is a lost write or a
  read racing it. `tsc` allows a discarded promise; `pnpm check:promises`
  does not, nor a promise used as a condition, concatenated into a string,
  or passed where anything is accepted - `JSON.stringify(promise)` is `"{}"`,
  which would have made three "nothing personal is stored" tests pass
  vacuously once the store went async. `memoryTable` is for what only the
  fake has (size, stats, Scan); production code never touches it. Write first, delete last:
  a crash between a delete and its replacement put loses the record.
- **Loops of awaits are slow; parallel read-modify-writes lose updates.**
  At ~300 ms a round trip, a thousand sequential awaits is five minutes.
  Use `forEachByKey` (`platform/concurrency.ts`): different keys run in
  parallel (bounded), the SAME key strictly in order - two folds of one
  baseline in parallel both read the old value and one update vanishes,
  with no error. Anything reported from such a loop is sorted afterwards,
  with the original position as the tie-break, so output stays
  byte-identical. The baseline backfill is resumable per WEEK
  (`BACKFILL#PROGRESS`, written after the week's writes) because it is not
  idempotent: a week folded twice narrows the spread.
- **AgentCore forwards NO header it was not told to.** Without
  `request_header_allowlist = ["Authorization"]` the agent never sees the
  token AgentCore just accepted, and answers 401. The agent logs "is
  Authorization in request_header_allowlist?" when that happens.
- **The agent bundle is CommonJS, SDKs INCLUDED, and says so.** AgentCore's
  NODE_22 runtime ships no AWS SDK (Lambda's does), so `build-agent.mjs`
  bundles them. Node picks a `.js` file's module type from the NEAREST
  package.json: locally the repo root's `"type": "module"` made the bundle
  die on its first `require()`, while in the zip it would have worked - so
  the build writes `{"type":"commonjs"}` beside `agent.js` and ships it.
  AgentCore session ids come from `crypto.getRandomValues`, never `uuid()`,
  which the demo world seeds - every tab would ask for the same microVM.
- **Cognito custom attributes are a one-way door.** They cannot be renamed or
  removed once the pool exists, and there is a cap of 50.
- **Shared thresholds live in one place.** `UTILISATION_THRESHOLDS` in
  `integrations/classify.ts` drives the capacity rule AND the board's load
  strip. An amber strip that disagreed with the rule would have been the
  symptom.
- **The token trigger stays SDK-free, though the board no longer runs it.**
  `web/src/auth/local.ts` imports `auth/pre-token-generation.ts` so the TESTS
  run Cognito's real logic with no pool; the board signs in through the real
  pool only, and local.ts is out of its bundle. The trigger is still shared
  code, so membership goes through a registry (`platform/membership.ts`),
  with the DynamoDB adapter wired in `infra/terraform/auth/lambda-entry.ts`,
  which only esbuild reads - same shape as `runbook-loader.node.ts` and
  `aws/dynamodb.sdk.ts`. CI's portability step greps for `@aws-sdk` imports
  and the two adapters in shared code; it did not always.
- **`crypto.randomUUID()` is secure-context only.** Undefined over plain http
  on a LAN address, which is how the board is reached behind a VPN that
  intercepts loopback. `platform/crypto.ts` falls back to `getRandomValues`.
- **The dev server binds `0.0.0.0`** (`server.host` in `web/vite.config.ts`)
  for the same reason. It is exposed to your local network while running.
- **Non-TypeScript files are invisible to every check.** VTL and APPSYNC_JS
  resolvers in `src/api/vtl/`, SQL, HCL, YAML, the GraphQL SDL. A rename that
  `tsc` and the tests both pass can still leave Terraform pointing at a file
  that no longer exists. Grep them explicitly.
- **String literals are invisible too.** EventBridge sources, DynamoDB key
  prefixes, GraphQL field names, Terraform tags, vendor alert-type strings.
- **Running the demo catches what nothing else does.** Typecheck, tests and the
  build were all green while the ingest section reported zero alarms, because
  the controller fixtures named devices the generator does not produce and
  every lookup fell to the unresolved path. Read the output, do not just check
  the exit code.

## Style

Comments explain **why**, name the trade-off, and flag the mistake that is easy
to make. They are the documentation — match their density and their voice.
Prose in comments and docs is British-inflected (`normalise`, `behaviour`);
identifiers are not.

The board is deliberately dense and industrial. One accent colour, amber,
which only ever means "attention". Status colours stay calm so amber and red
are the only things that pull the eye. Plain CSS with custom properties — no
utility framework, because its defaults pull the design toward a template.

## Layout

```
src/platform/    domain model + injected primitives (clock, crypto, random)
src/platform/inventory.ts  the alias→deviceId join; the hard part of ingestion
src/integrations/http.ts   pagination dialects, watermarks - what clouds share
src/integrations/webhook.ts  inbound: HMAC, replay window, idempotency
src/integrations/connector.ts  the one contract: poll() and onWebhook()
src/integrations/controller/  Meraki, Mist, Aruba Central
src/integrations/probe.ts  the external plane — the only thing that sees silence
src/integrations/splunk/   outbound HEC (a bus consumer) + catalogued SPL search
src/integrations/comms/  Teams, Genesys, Webex, Bandwidth, Helix, Kurmi, Starlink: client (tokens, retries, paging),
                 connectors, the workforce join (agency + facility split), and
                 signals -> alarms -> incidents
src/integrations/comms/mock/  Teams (Graph), Genesys, Webex mocks: mockFetch on the
                 real hostnames; scripts/mock-vendors.ts serves them on localhost
src/pipeline/    collect → normalise → stream → enrich → evaluate → correlate
src/geo/         spatial maths, PostGIS queries, GeoJSON/TopoJSON, topology
src/ai/          RAG, agent loop, guardrails
src/reporting/   the executive daily brief - every source, one page
src/aws/         local stand-ins for 6 AWS services; dynamodb.sdk.ts is the
                 REAL table adapter (Node only - paging, batch retries)
src/data/        estate generator, scenarios, health trace, runbooks, schema.sql
web/src/transport/  the boundary that lets the backend run in the browser;
                 api.ts reads the two data views over HTTP, select.ts picks
src/ai/agent-invocation.ts  one AgentCore invocation: token -> answer
infra/terraform/agentcore/  the assistant on Bedrock AgentCore Runtime
src/api/board-api.ts  GET /board and GET /comms - the one implementation of
                 both views, served from Lambda (infra/terraform/auth/api.tf)
web/src/auth/    sign-in: the real pool only (provider.ts); local.ts is the
                 offline issuer, kept as a TEST fixture, never on the page
src/platform/membership.ts  which customer an email domain belongs to; a
                 registry, so the browser never loads the DynamoDB client
```
