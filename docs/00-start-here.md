# Start here

NetPulse is an estate operations platform: network feeds in, incidents out, a live
board and an assistant on top. This is the shortest path through it.

## 1. Run it (5 minutes)

```bash
pnpm start --only=scenarios
```

Six situations go through the real pipeline. Each one exists to prove a claim
about how the rules behave, and the fourth — one access port flapping alone,
which raises an alarm and pages nobody — is the one worth pausing on. Any
dashboard can light up; a board that cries wolf is one people stop reading.

Then the whole thing, and the board:

```bash
pnpm start
pnpm web
```

The board signs in through a real Cognito pool - set it up with
`infra/terraform/auth/README.md` first; until then it shows what it needs.
What each account can see is decided by the token it was issued, not by
anything on the page: the email's domain maps to a customer, role and site in
the membership table. A domain with no row signs in and sees nothing, which is
the fail-closed rule rather than a bug. An account mapped to the `hhs-demo`
customer opens the second half: the voice and contact-centre view.

## 2. Read in this order (2-3 hours)

| Order | What | Why |
|---|---|---|
| 1 | `docs/01-architecture.md` | The whole system on one page |
| 2 | `src/platform/types.ts` | The domain model. Everything is built on it |
| 3 | `src/integrations/connector.ts` + one connector | Eight vendor dialects, one shape |
| 4 | `src/pipeline/steps.ts` | Where readings become alarms become incidents |
| 5 | `src/data/scenarios.ts` | The six claims, and the data that proves them |
| 6 | `src/api/schema.graphql` | The API surface, with AppSync directives |
| 7 | `src/ai/agent-core.ts` | The agent loop, in 90 lines |

## 3. If you only have an hour

Read the "Design decisions" section of the root `README.md`, then
`src/pipeline/steps.ts`. Between them they cover the decisions the rest of the
codebase exists to serve.

## 4. What is real here

The architecture, IAM, SQL, schemas and integration logic are real.
`src/aws/` contains local stand-ins for DynamoDB, S3, EventBridge, Step
Functions, Kinesis and Bedrock so the whole thing runs offline, and all data is
generated from a seed — a real device inventory is a map of an identifiable
organisation's internal network. Vendor payload shapes are modelled from
published API references rather than captured from live accounts, and
`docs/10-voice-and-contact-centre.md` says, per source, which parts are
placeholders still to be verified.

The root README says all of this in more detail. It is worth being precise
about, because the value of a reference implementation is entirely in whether
you can trust what it claims.

## Depth-first reading, by topic

- `docs/02-serverless-primer.md` — Lambda, API Gateway, Step Functions, EventBridge
- `docs/03-appsync-graphql.md` — resolver types, N+1, subscriptions, caching
- `docs/04-cognito-federation.md` — OAuth flows, SAML/OIDC, triggers, tenancy
- `docs/05-bedrock-rag-agentcore.md` — RAG, chunking, agents, tools, guardrails
- `docs/06-geospatial.md` — GeoJSON/TopoJSON, PostGIS, MapLibre, the lon/lat trap
- `docs/07-data-modelling.md` — DynamoDB single-table, Aurora, S3, idempotency
- `docs/08-terraform-cicd.md` — modules, environments, state, OIDC deploys
- `docs/09-code-tour.md` — a walk through the code itself, file by file
- `docs/10-voice-and-contact-centre.md` — the comms estate: seven sources, one set of rules
