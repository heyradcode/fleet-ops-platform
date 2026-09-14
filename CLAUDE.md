# NetPulse — working notes

A network operations intelligence platform on AWS serverless, runnable entirely
offline. Two workspaces: the backend in `src/` (zero runtime dependencies) and
the operations board in `web/` (React + MapLibre, its own dependencies).

Cisco, Juniper and Aruba feeds — syslog, SNMP traps, controller REST APIs and
our own probes — land in S3, are decoded and mapped into one canonical
`Observation`, and become alarms and then incidents.

## Commands

This repo uses **pnpm**, not npm. The lockfile and the non-hoisted layout both
assume it, and `npm install` would flatten `web/`'s dependencies into a place
`src/` can import from - which quietly breaks the zero-dependency backend.

```bash
pnpm install
pnpm start                      # the backend demo, narrated, all sections
pnpm start --only=scenarios     # the six scenarios — the best 30 seconds here
pnpm dev                        # the same, restarting on every save (nodemon)
pnpm test                       # 104 tests, no network. Picks up web/ tests too.
pnpm typecheck                  # backend
pnpm web                        # operations board, http://localhost:5180
pnpm web:build                  # typechecks web/ AND builds it
pnpm verify                     # all four checks, in order
```

`--only=` takes: `auth ingest scenarios data events graphql rest geo ai`.
Note `pnpm start --only=x` needs no `--` separator; npm did.

`pnpm verify` runs typecheck, tests, the demo and the web build in that order.
Each catches something the others do not - and none of them catches everything,
which is why the list ends with actually reading the demo output.

## Invariants — break these and something silently stops working

**No `node:` builtins outside `src/platform/runbook-loader.node.ts` and tests.**
The board imports the backend directly and runs it in the browser tab. A
bundler resolves imports whether or not the code path executes, so one static
`node:fs` anywhere in the shared graph breaks the web build. CI enforces this.
Anything platform-specific goes behind `src/platform/` — that is what
`clock.ts`, `crypto.ts`, `random.ts` and `runbook-loader.ts` are for.

**No `Buffer`.** Same reason. `platform/crypto.ts` has `b64urlEncode` /
`b64urlDecode`. This is also why the decoders never touch binary: SNMP and
IPFIX arrive as JSON from the collector, which is the right architecture anyway.

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

**Only `infra/terraform/auth/` is ever applied.** It creates a Cognito pool and
the token trigger, and costs pennies. Every other root is read-only
demonstration material: applying `envs/` brings up Aurora (~$87/month idle at
a 0.5 ACU floor × 2 instances) and Kinesis (~$29/month, no free tier), and
anything wanting a Bedrock Knowledge Base drags in OpenSearch Serverless at
~$700/month. Nothing in this repo *needs* an AWS account.

## Rules that are load-bearing and easy to break

These are the claims the architecture rests on. Each has a test; if you change
one, change the test deliberately rather than making it pass.

- **Observations never reach the event bus.** Only alarms and incidents are
  published. A syslog-heavy estate pushes tens of thousands of records/sec;
  publishing them would make cost scale with estate size instead of incidents.
- **Flows never reach the operational store at all.** IPFIX goes to its own S3
  bucket, partitioned by exporter, and is queried with Athena. It is the one
  observation class whose volume would make DynamoDB scale with traffic.
- **Corroboration means two independent PLANES, not two feeds.** A Cisco link
  failure emits a syslog line *and* an SNMP trap from the same agent — one
  witness talking twice. Independence means a different vantage point: the
  device, its controller, or our own probe. The far end of a link counts too:
  same plane, different chassis. `power-fault` is exempt — a chassis reporting
  its own dead PSU has no second opinion available.
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
**vendor-shaped payloads** — real syslog lines, real trap varbinds — so they
travel the real decode → map → collapse → evaluate → correlate path. Devices are
selected by role and vendor, never by literal name, so a generator change fails
loudly instead of silently proving nothing.

`trace.ts` records a half-hour of a cascade for the board's replay scrubber.
Nothing on a network map moves, so what replays is STATE, not position.

Vendor fixtures are **modelled from published API references, not captured
from live accounts** — Meraki, Mist and Aruba Central all gate API access
behind a customer contract. Say so if you add one; do not imply captured data.
The AOS-CX message wording is the least well covered publicly and should be
verified against a real switch.

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
- **RFC 5424's NILVALUE `-` is not cosmetic.** Cisco sends a bare `-` where
  structured data would go. Leave it attached and the message begins
  `- %LINK-3-UPDOWN`, the anchored mnemonic pattern never matches, and every
  Cisco record decodes with an empty tag and is silently unclaimed by its own
  mapper.
- **Cisco abbreviates in syslog and not in SNMP.** The same port is `Gi1/0/1`
  in a log line and `GigabitEthernet1/0/1` in an ifName varbind. An exact-match
  lookup resolves them to two different interfaces, and the trap and the log
  line silently stop corroborating each other. `canonicalInterfaceName` exists
  solely to stop that, and its abbreviation table is longest-prefix-first for
  the same reason.
- **`ifIndex` is not an identity.** It is only stable across a reboot if
  ifIndex persistence is configured. Resolve by NAME first; the index is a hint.
  Preferring it because it arrives as an integer is what puts a fortnight of
  counters on the wrong port.
- **A Cognito PreTokenGeneration trigger must be V2_0.** V1 writes claims to
  the ID token only, and this platform authorises on the ACCESS token
  (`token_use: 'access'` is check 4). A V1-wired pool signs people in and
  hands them a token with no tenant claim, which the verifier then rejects —
  so the symptom is "nobody can sign in" pointing at code that is correct.
  Terraform pins it; a test pins the response shape.
- **Cognito custom attributes are a one-way door.** They cannot be renamed or
  removed once the pool exists, and there is a cap of 50.
- **Shared thresholds live in one place.** `UTILISATION_THRESHOLDS` in
  `integrations/classify.ts` drives the capacity rule AND the board's load
  strip. An amber strip that disagreed with the rule would have been the
  symptom.
- **The token trigger is in the BROWSER's module graph.**
  `web/src/auth/local.ts` imports `auth/pre-token-generation.ts` so the offline
  board runs Cognito's real logic — which means an AWS SDK import there breaks
  `pnpm web:build`, and **CI would not catch it**: the portability check greps
  for `node:` builtins and `@aws-sdk/*` is not one. Membership therefore goes
  through a registry (`platform/membership.ts`), with the DynamoDB adapter
  wired in `infra/terraform/auth/lambda-entry.ts`, which only esbuild reads.
  Same shape as `runbook-loader.ts` / `runbook-loader.node.ts`.
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
  prefixes, GraphQL field names, Terraform tags, syslog mnemonics, trap OIDs.
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
src/integrations/wire.ts   decoder/mapper contracts for the PUSH half
src/integrations/decode/   one decoder per ENCODING, shared across vendors
src/integrations/map/      one mapper per (vendor, platform, encoding)
src/integrations/controller/  the PULL half: Meraki, Mist, Aruba Central
src/integrations/probe.ts  the external plane — the only thing that sees silence
src/pipeline/    collect → normalise → stream → enrich → evaluate → correlate
src/geo/         spatial maths, PostGIS queries, GeoJSON/TopoJSON, topology
src/ai/          RAG, agent loop, guardrails
src/aws/         local stand-ins for 6 AWS services
src/data/        estate generator, scenarios, health trace, runbooks, schema.sql
web/src/transport/  the boundary that lets the backend run in the browser
web/src/auth/    sign-in: the same Cognito logic the Lambdas run, local issuer
src/platform/membership.ts  which customer an email domain belongs to; a
                 registry, so the browser never loads the DynamoDB client
```
