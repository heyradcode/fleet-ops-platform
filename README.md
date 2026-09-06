# NetPulse — an agentic SaaS demo on AWS serverless

A small, heavily-commented reference implementation of **every technology named
in the job description**, built as one coherent product rather than eight
disconnected snippets.

It runs on your machine with **zero dependencies and no AWS account**:

```bash
npm start
```

<sub>Node 22+ required — the source is TypeScript and Node runs it directly via
type-stripping, so there is no build step.</sub>

---

## The product, in one paragraph

**NetPulse** is a multi-tenant SaaS platform for enterprise network operations.
It pulls telemetry from eight third-party systems — network gear (Cisco, Juniper,
HPE Aruba), contact centres (Genesys, Five9, Amazon Connect) and observability
tools (ThousandEyes, Splunk) — normalises them into one canonical shape,
enriches it with geospatial data, correlates it into incidents, serves it over
GraphQL and REST, and lets an AI agent answer *"why is the Dallas site degraded,
and is it just Dallas?"* by calling tools and citing runbooks.

That is deliberately the JD's own first deliverable: *"integrate a designated
set of third-party APIs into a centralized reporting view."*

---

## Where each JD requirement lives

| JD requirement | Read this | Runnable |
|---|---|---|
| AWS Lambda, Step Functions, API Gateway, EventBridge | `src/pipeline/`, `src/aws/` | `npm start -- --only=ingest` |
| LLM orchestration, AgentCore agent loop | `src/ai/agent-core.ts` | `--only=ai` |
| Amazon Bedrock RAG | `src/ai/knowledge-base.ts`, `src/ai/bedrock-rag.ts` | `--only=ai` |
| GraphQL via AppSync (resolvers, caching, subscriptions) | `src/api/schema.graphql`, `src/api/appsync-resolvers.ts`, `src/api/vtl/` | `--only=graphql` |
| REST via API Gateway | `src/api/rest-handler.ts` | `--only=rest` |
| Network management integrations | `src/integrations/network/` | `--only=ingest` |
| Contact centre integrations | `src/integrations/contact-center/` | `--only=ingest` |
| Observability integrations | `src/integrations/observability/` | `--only=ingest` |
| Cognito + social + SAML 2.0 / OIDC | `src/auth/` | `--only=auth` |
| GeoJSON, TopoJSON, PostGIS, MapBox | `src/geo/`, `src/data/schema.sql` | `--only=geo` |
| DynamoDB / Aurora schema design | `src/aws/dynamodb.ts`, `src/data/schema.sql` | `--only=data` |
| Terraform, dev/test/stage/prod | `infra/terraform/` | *(read-only)* |
| GitHub Actions CI/CD | `.github/workflows/` | *(read-only)* |
| Python | `python/` | *(read-only)* |

---

## How to read it

You have limited time, so read in this order:

1. **`docs/01-architecture.md`** — the whole system on one page, and the two
   request flows that matter.
2. **Run `npm start`.** Watch the eight sections execute. Each one prints what
   it is doing and why.
3. **`src/platform/types.ts`** — the domain model. Everything else is built on
   these six types.
4. **One vertical slice end to end:** `src/integrations/network/cisco-meraki.ts`
   → `src/pipeline/steps.ts` → `src/platform/repository.ts` →
   `src/api/appsync-resolvers.ts`. That path touches most of the stack.
5. **`docs/09-interview-cheatsheet.md`** — the questions you are most likely to
   be asked, with answers, on the day.

The comments in the source are the real documentation. They explain *why*, name
the trade-offs, and flag the mistakes that are easy to make — the things you
need in your head, not the things you can look up.

### Documentation index

| Doc | Covers |
|---|---|
| `docs/00-start-here.md` | The shortest path if you are short on time |
| `docs/01-architecture.md` | System diagram, request flows, why each service |
| `docs/02-serverless-primer.md` | Lambda, API Gateway, Step Functions, EventBridge |
| `docs/03-appsync-graphql.md` | Resolver types, N+1, subscriptions, caching |
| `docs/04-cognito-federation.md` | OAuth flows, SAML/OIDC, triggers, tenancy |
| `docs/05-bedrock-rag-agentcore.md` | RAG, chunking, agents, tools, guardrails |
| `docs/06-geospatial.md` | GeoJSON/TopoJSON, PostGIS, MapBox, the lon/lat trap |
| `docs/07-data-modelling.md` | DynamoDB single-table, when to use Aurora |
| `docs/08-terraform-cicd.md` | Modules, environments, state, OIDC deploys |
| `docs/09-interview-cheatsheet.md` | Likely questions and crisp answers |

---

## What is real and what is simulated

Being clear about this matters — do not claim more than the code does.

**Real:** every design decision, all the AWS resource definitions, the IAM
policies, the GraphQL schema and resolvers, the SQL, the vendor payload shapes,
the normalisation logic, the retry/circuit-breaker behaviour, the correlation
rules, the RAG chunking and hybrid-search maths, the agent loop, and all the
Terraform and GitHub Actions.

**Simulated, so it runs offline:** `src/aws/` contains ~500 lines standing in
for DynamoDB, S3, EventBridge, Step Functions and Bedrock. Each fake mirrors the
real SDK's method names and shapes, and each file's header comment shows the
real call it replaces. The vendor HTTP calls return fixtures from
`src/integrations/fixtures.ts` instead of hitting the network.

The offline "model" in `src/aws/bedrock.ts` is scripted, not intelligent. It
reproduces the one behaviour that matters for understanding agents: emit a
`tool_use` block, receive a `tool_result`, repeat, then answer. The **embeddings
are genuinely computed** (a hashing bag-of-words embedding), so the vector
search in the RAG section really does retrieve — you can watch the scores move.

---

## Commands

```bash
npm start                      # everything, in order
npm start -- --only=auth       # auth | ingest | data | events
npm start -- --only=graphql    # graphql | rest | geo | ai

npm test                       # 40 tests, no network
npm run typecheck              # tsc --noEmit
```

The tests are worth reading on their own — they document the behaviours that
are easiest to get wrong (idempotent ingest, cross-tenant denial, the lon/lat
swap, an agent refused a write tool).

---

## Things worth being able to say out loud

These are the specific, non-obvious points this codebase is built around. If you
can explain these, you can hold a conversation about the whole stack.

- **Tenancy is a type, not a filter.** Every repository function takes a
  `Principal` and derives the partition key itself, so there is no code path
  that *can* forget the tenant. IAM `dynamodb:LeadingKeys` enforces the same
  boundary a second time, at AWS. (`src/platform/tenancy.ts`)
- **Normalise once, at the edge.** Eight vendors, one `Signal` type. Everything
  downstream — the map, the agent, the alerting — understands exactly one
  schema. Adding a ninth vendor is a new file, not a new architecture.
- **Archive raw before you transform.** The untouched payload goes to S3 first.
  When you find a mapping bug you replay history instead of asking the vendor
  for last month's data.
- **Idempotency by content hash.** `signalId = sha256(provider|ref|timestamp)`,
  so at-least-once delivery becomes exactly-once storage for free.
- **Detection is deterministic; explanation is AI.** Rules decide what is real —
  they must be testable and explainable at 3am. The LLM's job starts afterwards.
- **An agent acts with the caller's permissions, never the Lambda's.** That one
  rule is what stops prompt injection from becoming privilege escalation.
  (`src/ai/guardrails.ts`, and the test that proves it)
- **The tenant filter on RAG retrieval is not optional.** A knowledge base is
  shared infrastructure; a missing metadata filter is a cross-tenant data leak.
- **`[longitude, latitude]`.** GeoJSON, PostGIS and MapBox all use x-then-y;
  humans and Google Maps say the opposite. A swap does not throw — it silently
  puts Dallas in Antarctica.
- **`ST_DWithin`, never `ST_Distance(...) < n`.** The first uses the GiST index;
  the second computes a spherical distance for every row in the table.
- **Don't put a Lambda behind a resolver that only reads DynamoDB.** AppSync
  direct resolvers have no cold start and no per-invocation charge.
