# Start here

You have a demo to prepare for and you are new to most of this stack. Here is
the shortest path.

## 1. Run it (5 minutes)

```bash
npm start
```

Eight sections, each narrating what it does. Then run one at a time and read the
matching source:

```bash
npm start -- --only=auth      # then read src/auth/
npm start -- --only=ingest    # then read src/integrations/ and src/pipeline/
npm start -- --only=ai        # then read src/ai/
```

## 2. Read in this order (2-3 hours)

| Order | What | Why |
|---|---|---|
| 1 | `docs/01-architecture.md` | The whole system on one page |
| 2 | `src/platform/types.ts` | Six types; everything else is built on them |
| 3 | `src/integrations/connector.ts` + one connector | The JD's first deliverable |
| 4 | `src/pipeline/steps.ts` | Where the data actually gets processed |
| 5 | `src/api/schema.graphql` | The API surface, with AppSync directives |
| 6 | `src/ai/agent-core.ts` | The agent loop, in 90 lines |
| 7 | `docs/09-interview-cheatsheet.md` | The answers, out loud |

## 3. If you only have an hour

Read `docs/09-interview-cheatsheet.md` and the "Things worth being able to say
out loud" section of the root `README.md`. Then run `npm start` once so you have
seen the thing work.

## 4. Be honest about what you built

If asked, this is a **learning project**: the architecture, IAM, SQL, schemas and
integration logic are real; `src/aws/` contains ~500 lines of local stand-ins for
DynamoDB, S3, EventBridge, Step Functions and Bedrock so it runs offline. Say
that plainly. "I built a reference implementation to learn the stack, and here is
what I learned" is a strong answer. Claiming production experience you don't have
is not, and it collapses on the first follow-up question.

## Depth-first reading, by topic

- `docs/02-serverless-primer.md` — Lambda, API Gateway, Step Functions, EventBridge
- `docs/03-appsync-graphql.md` — resolver types, N+1, subscriptions, caching
- `docs/04-cognito-federation.md` — OAuth flows, SAML/OIDC, triggers, tenancy
- `docs/05-bedrock-rag-agentcore.md` — RAG, chunking, agents, tools, guardrails
- `docs/06-geospatial.md` — GeoJSON/TopoJSON, PostGIS, MapBox, the lon/lat trap
- `docs/07-data-modelling.md` — DynamoDB single-table, Aurora, S3, idempotency
- `docs/08-terraform-cicd.md` — modules, environments, state, OIDC deploys
