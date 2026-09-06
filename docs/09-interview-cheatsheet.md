# Cheat sheet

The questions you are most likely to be asked, with answers short enough to say
out loud. Each one points at the file that demonstrates it.

---

## Serverless

**When would you NOT use Lambda?**
Steady, predictable, high-volume traffic — Fargate is cheaper past roughly
constant load. Anything over 15 minutes. Workloads needing >10GB memory, a GPU,
or sub-10ms p99 where a cold start is unacceptable. Long-lived connections
(WebSockets need API Gateway or AppSync in front).

**What actually causes a cold start, and how do you reduce it?**
Provisioning a microVM, downloading and unpacking your package, starting the
runtime, then running module-scope code. Reduce it by: bundling and
tree-shaking (package size dominates), keeping `@aws-sdk/*` external because it
is already in the runtime, initialising SDK clients at module scope so warm
invocations reuse them, ARM64/Graviton, and provisioned concurrency on the few
latency-critical paths. Note VPC-attached Lambdas no longer pay the old ENI
penalty, but a VPC still means a NAT gateway bill.
→ `infra/terraform/modules/lambda/main.tf`

**How do you tune Lambda memory?**
CPU scales linearly with memory, so a function that runs twice as fast at
1024MB as at 512MB costs *the same* — you are billed for GB-seconds. The
cheapest setting is rarely the smallest. Use AWS Lambda Power Tuning rather
than guessing.

**Your Lambda gets retried. How do you avoid double-processing?**
Make the write idempotent rather than trying to make delivery exactly-once.
Here, `signalId` is `sha256(provider|sourceRef|observedAt)`, so a duplicate
`PutItem` overwrites with identical bytes. For genuinely non-idempotent side
effects use a conditional write on a dedupe key.
→ `src/platform/ids.ts`

**Standard vs Express Step Functions?**
Standard: exactly-once, up to 1 year, full visual execution history, billed per
state transition — use for scheduled or long workflows you will need to debug.
Express: at-least-once, max 5 minutes, billed per GB-second (far cheaper at high
volume), logs instead of history — use for per-request orchestration.

**Why EventBridge instead of SNS or SQS?**
SNS is fan-out with no content filtering beyond message attributes. SQS is a
queue, not a router. EventBridge filters on the event *body*, so one bus serves
many consumers each seeing only what matches — and adding a consumer is a rule,
not a producer change. It also gives you an archive and replay, per-target retry
and per-target DLQs.
→ `src/aws/eventbridge.ts`, `infra/terraform/modules/eventbridge/main.tf`

---

## AppSync / GraphQL

**When do you use a Lambda resolver vs a direct resolver?**
If the resolver only reads or writes DynamoDB, do **not** put a Lambda behind
it. A direct (APPSYNC_JS or VTL) unit resolver runs inside AppSync: no cold
start, no per-invocation charge, one less thing to deploy. Reach for a Lambda
when you need Bedrock, Aurora, or orchestration across services.
→ `src/api/vtl/Query.signals.js` vs `src/api/appsync-resolvers.ts`

**What are the APPSYNC_JS restrictions?**
No async/await, no promises, no `fetch`, no npm packages, only
`@aws-appsync/utils`, exactly two exports (`request`/`response`), 32KB of code.
If you cannot fit inside that, you needed a Lambda — don't fight the runtime.

**How do AppSync subscriptions actually work?**
They are **derived from mutations**, not published manually. `@aws_subscription
(mutations: ["openIncident"])` means: when that mutation succeeds, AppSync takes
its **return value**, matches it against every registered subscription's
arguments as a server-side filter, and pushes it over WebSocket to the sockets
that match. Two consequences: (1) if the mutation didn't return a field,
subscribers cannot receive it; (2) to push from backend code you must *call the
mutation* — usually with IAM auth — because writing to DynamoDB directly
triggers nothing.
→ `src/api/subscriptions.ts`

**How do you handle N+1?**
`sites { signals { … } }` invokes the nested resolver once per site. Fix with a
**BatchInvoke** resolver (AppSync passes an array of up to 2000 events; you do
one Query per partition), per-resolver caching, or denormalising at write time.

**How do you do authorisation in AppSync?**
Declaratively, in the schema. `@aws_cognito_user_pools` / `@aws_iam` per type or
field; `@aws_auth(cognito_groups: ["admin"])` for field-level RBAC, enforced
before any resolver runs. Multiple auth modes coexist on one API — Cognito for
humans, IAM for the ingest pipeline.
→ `src/api/schema.graphql`

**AppSync caching risk?**
The cache key includes `$context.identity` by default. If you hand-set
`caching_keys` and omit identity, you serve one tenant another tenant's cached
response. Verify it.

---

## Cognito

**Walk me through the login flow.**
Authorization code + PKCE. The SPA hits `/oauth2/authorize` with
`identity_provider=Google`, a `code_challenge` and `state`. Cognito bounces the
user to Google; Google returns a code to Cognito; Cognito exchanges it, applies
the attribute mapping, fires PreTokenGeneration, and redirects to your app with
*its own* code. The SPA exchanges that plus the `code_verifier` for Cognito
tokens. Never the implicit flow — deprecated, and it leaks tokens in the URL
fragment.
→ `src/auth/providers.ts`

**ID token vs access token?**
ID token = *who the user is* (claims/attributes), for your app. Access token =
*what they may do* (scopes, groups), for your API. Not interchangeable — only
the ID token carries user attributes like email. Always verify `token_use`.

**What does verifying a Cognito JWT actually check?**
Signature (RS256, against the cached JWKS, matching on `kid`), `iss` is your
pool, `aud`/`client_id` is your app client, `token_use`, `exp`, `iat`/`nbf` with
a little skew, and that `alg` is what *you* expect — never trust the token's own
`alg` header, which is the classic JWT confusion attack. In production use
`aws-jwt-verify`; cache the JWKS.
→ `src/auth/cognito-jwt-verifier.ts`

**How does a Google user get a tenant?**
The **PreTokenGeneration** trigger. Google knows nothing about your SaaS, so
this Lambda looks up the tenant and roles and stamps them into the token as
`custom:tenantId` and group overrides. Every downstream service then gets
tenancy from a signed token with no extra database call on the hot path. It runs
on every login — keep it under 100ms, and fail *closed* on an unknown domain.
→ `src/auth/pre-token-generation.ts`

**SAML vs OIDC?**
Prefer OIDC whenever the customer offers both: JSON not XML, and discovery via
`/.well-known/openid-configuration`. For SAML, use the metadata **URL** not a
pasted certificate, so Cognito picks up rotation automatically — a hard-coded
cert expires at 2am on a Sunday. SAML claim names are URIs; copy them verbatim.

**The gotchas per social provider?**
Google: map username to `sub`, never email — people change email addresses.
Facebook: may return **no email** (phone signups), so email must be optional in
the pool schema. Apple: sends the name **only on first authorisation**, uses
Private Relay addresses, and its client secret is a JWT you sign with a `.p8`
key that expires every 6 months — automate the rotation.

**Custom attributes?**
Cannot be renamed or deleted once created; hard cap of 50. A one-way door.
Also: make `custom:tenantId` **not** writable by the app client, or a user can
move themselves into another tenant.

---

## Data modelling

**Why single-table DynamoDB?**
No joins, so you model access patterns first and derive keys from them. Items
you fetch together are stored together and retrieved with one Query on a key
prefix. Here `SK` starts with an ISO timestamp, so "newest first" is
`ScanIndexForward: false` — no sorting in code, ever.
→ `src/aws/dynamodb.ts`

**Query vs Scan?**
Query reads only the partition you asked for: cost is proportional to the
*answer*. Scan reads the entire table: cost is proportional to the *data*. A
`FilterExpression` does **not** reduce cost — items are read and then discarded.
If you find yourself filtering a lot, you need a different key or a GSI.

**What does a GSI cost?**
It is a full, eventually-consistent copy of the projected attributes with its
own throughput, and it consumes write units on **every** base-table write.
Project with `INCLUDE`, not `ALL`. Useful trick: GSIs are **sparse** — items
without the GSI key simply do not appear, so you can index a subset cheaply.

**When do you reach for Aurora instead?**
Anything spatial, anything ad-hoc, anything needing joins or aggregates. Here:
sites, service regions, and reporting. Signals stay in DynamoDB.

**How do you connect Lambda to Postgres?**
Not with a raw connection per invocation — a thousand concurrent Lambdas means
a thousand Postgres connections and Postgres dies in the low hundreds. Use
**RDS Proxy** to pool and multiplex, or the **Aurora Data API** (HTTP,
IAM-authed, no connection at all), which is what this project uses.
→ `python/geospatial/postgis_lambda.py`

**Multi-tenant isolation models?**
Silo (stack per tenant — strongest isolation, worst cost/ops, for regulated
whales), Pool (one table, tenantId as partition key — cheapest, needs
discipline), Bridge (a mix). This is Pool, defended in four layers: types, IAM
`dynamodb:LeadingKeys`, and Postgres RLS.
→ `src/platform/tenancy.ts`

---

## AI

**RAG vs an agent — which do you need?**
They are not alternatives. RAG is a *retrieval* strategy; an agent is a
*control-flow* strategy, and the agent uses RAG as one of its tools. Single-shot
RAG for Q&A: cheap, fast, predictable. An agent when the number of steps is not
known in advance.
→ `src/ai/bedrock-rag.ts` vs `src/ai/agent-core.ts`

**Describe the agent loop.**
Call the model with (system, messages, tools). If `stop_reason` is `tool_use`,
execute the tool(s), append `tool_result` blocks, call again. If `end_turn`,
you're done. That is the whole idea; AgentCore hosts that loop plus session
isolation, memory, identity delegation and observability. Four things make it
production-grade: a hard iteration cap, per-tool authorisation, errors returned
as `tool_result` content so the model self-corrects, and a trace.

**What makes a good tool definition?**
The schema *is* the prompt — it is the only thing the model sees. Describe
**when** to use the tool, not just what it does. Encode constraints in the
schema (enums, required, bounds) rather than pleading for them in the prompt.
Return errors as data: "unknown siteId 'xyz-99'; valid ids are …" lets the model
fix its own call; a thrown exception just kills the turn.
→ `src/ai/tools.ts`

**How do you chunk documents for RAG?**
Too small and a chunk says "escalate to the carrier" with no clue what the
symptom was. Too large and one embedding averages three unrelated procedures and
matches nothing well. For structured documents split on headings — the author
already told you where the boundaries are — and prepend the document and section
titles into the chunk text so topic-level queries still match. Free prose needs
fixed-size chunks with overlap. Bedrock offers FIXED_SIZE, SEMANTIC and
HIERARCHICAL. Chunking is the single biggest quality lever in RAG.

**Why hybrid search?**
Embeddings understand that "choppy calls" relates to "packet loss" but are bad
at exact tokens — a model number, an error code, "SFP". Keyword/BM25 is the
opposite. Bedrock's `overrideSearchType: HYBRID` fuses them. Tune the weighting
against a real eval set, not a hunch.

**How do you make multi-tenant RAG safe?**
A metadata filter on every retrieval:
`filter: { equals: { key: "tenantId", value: principal.tenantId } }`.
A knowledge base is shared infrastructure — a missing filter is the RAG
equivalent of a missing `WHERE` clause, and it is a cross-tenant data leak.

**How do you stop prompt injection from causing damage?**
Not with prompt instructions. **Authorisation lives in the tool, checked against
the caller's roles.** The worst case then is a refused tool call. Layer Bedrock
Guardrails on top (prompt-attack filter, denied topics, PII, and contextual
grounding to catch unsupported answers), and give viewers a smaller tool set
than operators.
→ `src/ai/guardrails.ts`, and the test that proves a viewer is refused

**How do you know the model isn't making things up?**
Contextual grounding: score the answer against the retrieved passages and block
below a threshold. Plus citations in the response, and exposing the tool trace —
users trust an agent far more when they can see which tools it called.

---

## Geospatial

**Longitude or latitude first?**
GeoJSON, PostGIS and MapBox GL: `[longitude, latitude]` (x, y). Leaflet, Google
Maps and humans: `(latitude, longitude)`. A swap does not throw — it silently
puts Dallas in Antarctica. Name the variables `lon`/`lat` and range-check at the
API boundary.

**`geometry` or `geography`?**
`geography` is spherical: `ST_DWithin` takes **metres** and is correct across
timezones and the antimeridian; slower. `geometry` is planar and fast, but with
SRID 4326 the distance unit is **degrees**, which is meaningless for "within
75km". Default to `geography` unless you have measured a reason not to.

**Why is my spatial query slow?**
Almost always `ST_Distance(...) < n` instead of `ST_DWithin(...)`. The first
computes a spherical distance for every row; the second is index-assisted — the
GiST index does a bounding-box pre-filter and only then refines. `EXPLAIN
ANALYZE` and look for `Index Scan using …_gix`; if you see `Seq Scan`,
something has defeated the index.
→ `src/geo/postgis-queries.ts`, `src/data/schema.sql`

**GeoJSON or TopoJSON?**
GeoJSON for points, small geometry, and anything an API returns per request.
TopoJSON for large polygon sets with shared borders, served from
S3 + CloudFront and cached hard. TopoJSON stores each shared edge once as an
"arc", quantises coordinates onto an integer grid and delta-encodes them —
routinely 80–90% smaller. Nothing consumes it directly; the client calls
`topojson.feature()` to expand it back.
→ the demo shows 76% on a 600-vertex polygon

**What does MapBox do that PostGIS cannot?**
Isochrones — "everywhere reachable in 30 minutes by car" — for field-engineer
dispatch, plus geocoding and directions. Also: `pk.*` tokens are safe in the
browser **only if URL-restricted** in the MapBox dashboard; `sk.*` tokens are
server-only; cache geocoding results, because geocoding the same address twice
is billable twice.

---

## Terraform / CI-CD

**Workspaces or directories per environment?**
Directories. Workspaces share one backend key and one provider config, so a
mis-set `TF_WORKSPACE` can point a destroy at prod. Separate directories,
separate state files and separate AWS **accounts** make that impossible rather
than merely discouraged.

**How do you handle state?**
S3 with encryption, versioning and locking — `use_lockfile = true` on Terraform
1.10+, which replaced the DynamoDB lock table. Without locking, two concurrent
CI applies corrupt state.

**Are secrets safe in Terraform?**
`sensitive = true` redacts a value from **output**; it does not encrypt it in
**state**. State is plaintext JSON. So: encrypt the bucket, lock it down, nobody
gets console read access, and inject secrets as `TF_VAR_*` from Secrets Manager
at apply time rather than committing them to a tfvars file.

**How does CI authenticate to AWS?**
GitHub OIDC. GitHub issues a short-lived token; an IAM role trusts it with the
subject pinned to the repo *and* environment
(`repo:acme/meridian:environment:prod`). No long-lived access keys exist. A
wildcard subject would let any branch of any repo assume the prod deploy role.
→ `.github/workflows/terraform-apply.yml`

**How do you promote a build?**
Build the artefact **once** and move the same bytes through dev → test → stage →
prod. Rebuilding per environment means you tested one artefact and shipped a
different one. Manual approval before prod is a GitHub **Environment**
protection rule, not a workflow step.

**How do you stop a bad plan reaching prod?**
`terraform plan -detailed-exitcode` (0 = no change, 2 = changes), show the plan,
and fail the job if it deletes or replaces anything in prod unless a human has
explicitly signed off. Plus `terraform fmt -check`, `validate`, and a static
analyser (Trivy/tfsec) for public buckets, wildcard IAM and missing encryption.

**Where do database migrations go?**
Not in Terraform. `CREATE EXTENSION postgis` is SQL, not a resource, and schema
changes want their own review and rollback story. Run them as a pipeline step
after apply.

---

## Questions worth asking *them*

- Which of the eight integrations is highest priority, and do you already have
  sandbox credentials for them? (Vendor sandbox access is usually the real
  critical path on a 1–2 month integration deliverable.)
- Is the tenancy model pooled or siloed, and is that settled? It changes almost
  every downstream decision.
- Is AgentCore already chosen, or is it still open versus a plain Bedrock tool
  loop in Lambda?
- What does the geospatial requirement actually serve — a map view, dispatch
  routing, or spatial analytics? Those need very different amounts of PostGIS.
- Who owns the Terraform today, and is there an existing module library and
  account structure to fit into?
