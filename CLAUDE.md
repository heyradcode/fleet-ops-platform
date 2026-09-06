# Meridian — working notes

A fleet dispatch platform on AWS serverless, runnable entirely offline. Two
workspaces: the backend in `src/` (zero runtime dependencies) and the dispatch
board in `web/` (React + MapLibre, its own dependencies).

## Commands

This repo uses **pnpm**, not npm. The lockfile and the non-hoisted layout both
assume it, and `npm install` would flatten `web/`'s dependencies into a place
`src/` can import from - which quietly breaks the zero-dependency backend.

```bash
pnpm install
pnpm start                      # the backend demo, narrated, all sections
pnpm start --only=scenarios     # the six scenarios — the best 30 seconds here
pnpm dev                        # the same, restarting on every save (nodemon)
pnpm test                       # 96 tests, no network. Picks up web/ tests too.
pnpm typecheck                  # backend
pnpm web                        # dispatch board, http://localhost:5180
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
`b64urlDecode`.

**Everything is deterministic.** Never `new Date()`, `Date.now()` or
`Math.random()` — use `platform/clock.ts` and `platform/random.ts`. Two
`pnpm start` runs must produce identical output apart from wall-clock
durations, and CI diffs them. This is what makes a screenshot reproducible and
a real change distinguishable from noise.

**No TypeScript `enum`, `namespace`, parameter properties or decorators.**
`node src/demo.ts` runs TS via type-stripping, which cannot handle anything
requiring code generation. `tsc` stays green and `pnpm start` dies at runtime.
Use union types, as the existing code does.

**Imports carry `.ts` extensions.** Required by type-stripping. `web/` handles
this via `allowImportingTsExtensions`.

**`infra/` is never deployed.** It is read-only demonstration material.
Nothing in this repo needs an AWS account, and deploying it would cost real
money — Aurora and any OpenSearch collection bill whether or not they are used.

## Rules that are load-bearing and easy to break

These are the claims the architecture rests on. Each has a test; if you change
one, change the test deliberately rather than making it pass.

- **Telemetry never reaches the event bus.** Only exceptions and incidents are
  published. At 11,000 readings/sec, publishing readings would make cost scale
  with fleet size instead of with incidents.
- **Corroboration means two independent SIGNALS, not two vendors.** A truck
  carries one GPS unit, so demanding two telematics vendors would make route
  deviations permanently undetectable. A second vendor OR a different kind of
  evidence for the same driver counts. `panic` and `hos-risk` are exempt — a
  regulatory clock is not a sensor to be double-checked.
- **The merge radius is 3km / 15 minutes, on the same corridor.** An earlier
  cut used 150km, which is wider than a district and would collapse everything
  in Dallas into one permanent incident.
- **Only `LOCATION_CAUSED` exception kinds merge with each other.** A road
  closure fires both `route-deviation` and `prolonged-idle`; merging only
  same-kind would page twice for one event.
- **Scope comes from the token, not the request.** Repository and resolver
  functions take a `Principal` and derive keys from it. A dispatcher with no
  district claim gets *driver* scope, not the whole fleet — widening access is
  a deliberate grant.

## Data

All synthetic, all seeded. `src/data/generate.ts` builds 60 drivers across 5
uneven districts (Dallas 16, others 11) moving along hand-drawn corridors in
`polylines.ts`. `scenarios.ts` holds six situations that each prove one claim
and emit **vendor-shaped payloads**, so they travel the real normalise path.

Vendor fixtures are **modelled from published API references, not captured
from live accounts** — Samsara, Motive, Lytx and the rest gate API access
behind a customer contract. Say so if you add one; do not imply captured data.

Real driver telemetry is a location trace of an identifiable person. Nothing
real belongs in this repo.

## Gotchas found the hard way

- **`process` does not exist in a browser.** Not undefined - UNBOUND, so
  `process.env.FOO` throws. Every read of it was at module scope, so the board
  was a blank page. Configuration goes through `platform/env.ts`. This is the
  bug that motivated the browser-contract test, which loads the whole graph
  with `process` and `Buffer` deleted.
- **Shared thresholds live in one place.** `HOS_THRESHOLD_MINUTES` in
  `integrations/connector.ts` drives the detection rule, the reassignment
  guard AND the board's hours-of-service strip. It used to be typed three
  times; an amber strip that disagreed with the rule would have been the
  symptom.
- **`crypto.randomUUID()` is secure-context only.** Undefined over plain http
  on a LAN address, which is how the board is reached behind a VPN that
  intercepts loopback. `platform/crypto.ts` falls back to `getRandomValues`.
- **The dev server binds `0.0.0.0`** (`server.host` in `web/vite.config.ts`)
  for the same reason. It is exposed to your local network while running.
- **Non-TypeScript files are invisible to every check.** VTL and APPSYNC_JS
  resolvers in `src/api/vtl/`, SQL, HCL, YAML. A rename that `tsc` and the
  tests both pass can still leave Terraform pointing at a file that no longer
  exists. Grep them explicitly.
- **String literals are invisible too.** EventBridge sources, DynamoDB key
  prefixes, GraphQL field names, Terraform tags.
- **Running the demo catches what nothing else does.** Typecheck, tests and the
  build were all green while the auth section demonstrated nothing, because a
  tenant rename left its email addresses behind and every lookup fell to the
  fail-closed path. Read the output, do not just check the exit code.

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
src/integrations/  8 vendor connectors in 3 families; a tenant runs 2-3
src/pipeline/    collect → normalise → stream → resolve → evaluate → detect
src/geo/         spatial maths, PostGIS queries, GeoJSON/TopoJSON
src/ai/          RAG, agent loop, guardrails
src/aws/         local stand-ins for 6 AWS services
src/data/        generator, corridors, scenarios, runbooks, schema.sql
web/src/transport/  the boundary that lets the backend run in the browser
web/src/auth/    sign-in: the same Cognito logic the Lambdas run, local issuer
```
