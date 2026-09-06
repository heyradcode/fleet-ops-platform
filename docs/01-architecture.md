# Architecture

## The whole system

```
                         ┌──────────────────────────────────────┐
   Google / Facebook     │            AWS Cognito               │
   Apple / SAML / OIDC ─▶│  user pool + identity federation     │
                         │  PreTokenGeneration ─┐               │
                         └──────────────────────┼───────────────┘
                                                │ stamps custom:tenantId
                                                ▼  into every token
   Browser / SPA ──── JWT ────┬────────────────────────────────┐
                              │                                │
                    ┌─────────▼──────────┐        ┌────────────▼─────────┐
                    │   AppSync (GraphQL)│        │  API Gateway (REST)  │
                    │  • direct DynamoDB │        │  • Lambda authorizer │
                    │  • Lambda resolvers│        │  • webhooks          │
                    │  • subscriptions ⚡│        └────────────┬─────────┘
                    └─────────┬──────────┘                     │
                              └───────────┬─────────────────────┘
                                          ▼
                    ┌──────────────────────────────────────────┐
                    │              Lambda (Node / Python)       │
                    └───┬───────────────┬──────────────┬───────┘
                        │               │              │
              ┌─────────▼──────┐ ┌──────▼───────┐ ┌────▼─────────────┐
              │   DynamoDB     │ │    Aurora     │ │  Bedrock         │
              │ single table   │ │  PostgreSQL   │ │  • Claude        │
              │ + GSI1         │ │  + PostGIS    │ │  • Titan embed   │
              │ + Streams      │ │  (Data API)   │ │  • Knowledge Base│
              └────────────────┘ └───────────────┘ │  • Guardrails    │
                                                   └──────────────────┘
   ═══════════════════════════ ingest side ═══════════════════════════

   EventBridge Scheduler (rate: 5 min)
              │
              ▼
   ┌──────────────────────── Step Functions ────────────────────────┐
   │  Map(concurrency 4)   Task        Task      Choice      Task   │
   │  ┌───────────────┐  ┌────────┐ ┌────────┐          ┌────────┐ │
   │  │ collect × 8   │─▶│normalise│▶│ enrich │────────▶ │ detect │ │
   │  │ (per vendor)  │  └────────┘ └────────┘          └───┬────┘ │
   │  └───────┬───────┘                                     │      │
   └──────────┼─────────────────────────────────────────────┼──────┘
              │ raw payload                                 ▼
              ▼                                        ┌─────────┐
        ┌──────────┐                                   │ publish │
        │ S3 (raw) │                                   └────┬────┘
        │ bronze   │                                        │
        └──────────┘                                        ▼
                                              ┌──────────────────────┐
   Cisco Meraki ─┐                            │     EventBridge      │
   Juniper Mist  │  network                   │   custom event bus   │
   HPE Aruba    ─┤                            └──┬────────┬──────┬───┘
   Genesys      ─┐                               │        │      │
   Five9         │  contact centre            pager    AI agent  Firehose
   Amazon Connect┤                          (critical) (summary) (analytics)
   ThousandEyes ─┐                                            └──▶ DLQ
   Splunk        │  observability
```

---

## Why each service

Being able to say *why* — and what you would have used instead — matters more
than being able to name them.

| Service | Why it, specifically |
|---|---|
| **Lambda** | Spiky, event-shaped work. Nothing here runs continuously, so paying for idle EC2/Fargate would be waste. Limit to know: 15 min, 10GB, 1000 default concurrency. |
| **Step Functions** | The ingest has 5 steps needing per-step retry, a fan-out and a branch. Expressing that in Lambda code means hand-rolling retry, state and error handling; expressing it in ASL gives you a visual execution history you can hand to a colleague at 3am. |
| **EventBridge** | Producers do not know consumers. Adding "also post to Slack" is a *rule*, not a code change. Content-based filtering happens in the bus, so you never pay to start a Lambda that immediately decides the event was not for it. |
| **AppSync** | A dashboard fetches ten related things; GraphQL makes that one round trip. The decisive feature is **managed subscriptions** — real-time push with server-side filtering, with no WebSocket infrastructure of your own. |
| **API Gateway** | Webhooks and health checks. Third parties cannot speak GraphQL. HTTP API over REST API: ~70% cheaper and lower latency. |
| **Cognito** | Five identity providers, one issuer. Your API trusts exactly one token format no matter how the user signed in. |
| **DynamoDB** | Signals are high-volume, write-heavy, and always read by known key. Single-digit-millisecond reads at any scale, no capacity planning on PAY_PER_REQUEST. |
| **Aurora + PostGIS** | DynamoDB cannot answer "which sites are within 75km of this point". Spatial indexes and ad-hoc joins are what a relational engine is for. Serverless v2 scales to zero in dev. |
| **S3** | The raw archive. Cheap, durable, and it makes replay possible when a mapping bug is found. |
| **Bedrock** | Managed model access with an IAM-shaped security story, plus Knowledge Bases and Guardrails. No API keys to rotate, and the data does not leave your account boundary. |

---

## Request flow 1: a user opens the dashboard

```
1. SPA holds a Cognito access token (obtained via authorization code + PKCE).

2. POST https://<api-id>.appsync-api.<region>.amazonaws.com/graphql
   Authorization: <access token>

   query Dashboard {
     incidents(status: open) { incidentId title severity sites { name } }
     mapLayer { featureCollection bbox }
   }

3. AppSync validates the JWT itself (signature, issuer, audience, expiry)
   before any resolver runs. An invalid token never reaches your code.

4. Per field, AppSync picks a resolver:
     incidents  -> Lambda data source  (needs joins + Aurora)
     mapLayer   -> Lambda data source  (needs PostGIS)
     Site.name  -> already in the parent object, no resolver at all

5. The Lambda receives event.identity.claims — already verified — and builds a
   Principal. Every repository call takes that Principal and derives the
   DynamoDB partition key from it. There is no code path that can query
   without a tenant.

6. One response, one round trip, exactly the fields asked for.
```

**The trap in step 4:** `sites { signals { ... } }` invokes `Site.signals` once
per site — the N+1 problem. Fixes in order of preference: a BatchInvoke resolver
(AppSync hands the Lambda an array of up to 2000 events, you do one Query per
partition), per-resolver caching, or denormalising the top few signals onto the
Site item at write time.

---

## Request flow 2: a vendor's telemetry becomes a page

```
1. EventBridge Scheduler fires every 5 minutes.
   FLEXIBLE time window jitters the start, so a thousand tenants do not all
   hammer the vendor at :00.

2. Step Functions Map state, MaxConcurrency 4, one branch per vendor.
   ToleratedFailurePercentage 40 — a dead vendor must not fail the run.
   Partial data beats no data in an ops dashboard.

3. collect: fetch, then archive the untouched payload to
   s3://…/raw/tenant=acme/provider=cisco-meraki/dt=2026-09-04/hh=10/….json
   Archive BEFORE normalising. Normalisation is code, code has bugs, and when
   you fix the bug you want to replay rather than beg the vendor for history.

4. normalise: vendor JSON -> Signal[]. A pure function, so it is trivially
   testable and safely replayable. signalId is a CONTENT HASH, which makes the
   at-least-once pipeline idempotent at rest.

5. enrich: join site coordinates from Aurora. Best-effort — a signal without a
   location is still a valid signal, so this step Catches and continues.

6. detect: deterministic correlation.
     a) group non-OK signals by site
     b) require 2+ INDEPENDENT providers agreeing before opening an incident
        (cross-vendor agreement is the cheapest noise filter there is)
     c) merge affected sites within 150km into ONE regional incident
        (eleven pages for one carrier fault is how on-call teams learn to
         ignore pages)
   No LLM here, on purpose. Detection must be explainable and testable.

7. publish: BatchWriteItem to DynamoDB, THEN PutEvents to EventBridge.
   Write before publish — otherwise a subscriber that immediately queries gets
   a 404. (The rigorous version is the transactional outbox: write the event in
   the same transaction and let a DynamoDB Streams handler publish it.)

8. EventBridge fans out on { "detail": { "severity": ["critical"] } }:
     - the notifier Lambda pages a human
     - the agent Lambda writes an AI root-cause summary
     - Firehose archives everything for analytics
   Three consumers, none aware of the others. Adding a fourth is Terraform.
```

---

## The security model, in four layers

Defence in depth means each layer independently prevents the breach.

| Layer | Mechanism | Stops |
|---|---|---|
| **Edge** | Cognito JWT validated by AppSync / API Gateway | Unauthenticated requests, forged tokens |
| **Application** | Every repository function takes a `Principal` and builds the key from it | A forgotten `WHERE tenant_id = …` |
| **IAM** | `dynamodb:LeadingKeys` on an STS session policy | A *buggy* Lambda reaching another tenant's partition |
| **Database** | Postgres row-level security keyed on `app.tenant_id` | SQL injection, or an ad-hoc query run by a human |

And for the AI specifically:

| Layer | Mechanism |
|---|---|
| Input | Bedrock Guardrails: denied topics, prompt-attack filter, PII redaction |
| Retrieval | Metadata filter pinning the knowledge base to one tenant |
| Tools | Per-tool authorisation against the **caller's** roles, in code |
| Output | Contextual grounding score — block answers the sources do not support |

The tool-authorisation layer is the important one. An agent whose tools can
change infrastructure must not have more authority than the human who asked. Get
that wrong and prompt injection becomes privilege escalation: a hostile string
in a vendor payload persuades the model to call `openIncident`, and because the
Lambda's role permits it, it happens.

---

## What is deliberately NOT here

Knowing what you left out — and why — is as much a signal as what you built.

- **A front-end.** The JD is back-end. The API returns MapBox style JSON so the
  client is a thin renderer.
- **VPC networking detail.** Only Aurora needs a VPC; Lambdas that touch only
  DynamoDB, S3 and Bedrock are better off outside one (no ENI cold-start
  penalty, no NAT gateway bill).
- **A real vector store.** Bedrock Knowledge Bases wrap OpenSearch Serverless
  or Aurora pgvector. `src/ai/knowledge-base.ts` implements chunking, embedding
  and hybrid search by hand so the mechanism is visible rather than managed.
- **Per-tenant cost attribution.** Real SaaS needs it. It is tagging plus a
  DynamoDB-Streams-to-Firehose metering pipeline, and it is a project of its own.
