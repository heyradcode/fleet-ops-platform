# AppSync and GraphQL

## Why GraphQL here at all

A Meridian dashboard shows open incidents, each incident's affected sites, each
site's recent signals, and a map layer. Over REST that is four or five round
trips, or one bespoke `/dashboard` endpoint that you rewrite every time the UI
changes. Over GraphQL it is one request whose shape the *client* decides.

The decisive AppSync-specific reason, though, is **managed subscriptions**:
real-time push over WebSocket with server-side filtering and no infrastructure
of your own. Building that on API Gateway WebSockets means owning connection
state, fan-out and reconnection.

---

## Resolvers: three kinds, and choosing correctly

This is most of the skill, and a very likely interview question.

### 1. Unit resolver, APPSYNC_JS runtime

Runs **inside AppSync**. No Lambda, no cold start, no per-invocation charge.

```js
import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const tenantId = ctx.identity.claims['custom:tenantId'];
  if (!tenantId) util.unauthorized();

  return {
    operation: 'Query',
    query: {
      expression: 'PK = :pk',
      expressionValues: util.dynamodb.toMapValues({ ':pk': `TENANT#${tenantId}#SIGNAL` }),
    },
    scanIndexForward: false,
    limit: Math.min(ctx.args.limit ?? 25, 100),
    nextToken: ctx.args.nextToken,
  };
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);
  return { items: ctx.result.items, nextToken: ctx.result.nextToken };
}
```

**Restrictions:** no `async`/`await`, no promises, no `fetch`, no npm packages,
only `@aws-appsync/utils`, exactly two exports, 32KB of code. If you can't fit
inside that, you needed a Lambda — don't fight the runtime.

### 2. Pipeline resolver

Several functions in sequence sharing `ctx.stash`. Use for
authorise → fetch → transform, still without a Lambda.

### 3. Lambda data source

Full Node/Python runtime. Use when you need Bedrock, Aurora, or orchestration
across services.

> **The rule:** if a resolver only reads or writes DynamoDB, do **not** put a
> Lambda behind it.

You will also meet **VTL** (Velocity templates) — the older resolver language.
New work should use APPSYNC_JS, but any AppSync codebase more than a couple of
years old is full of VTL, so be able to read it.
→ `src/api/vtl/` has one of each.

---

## Authorisation is declared in the schema

```graphql
type Query @aws_cognito_user_pools {
  incidents(status: IncidentStatus): [Incident!]!
}

type Mutation @aws_cognito_user_pools {
  openIncident(input: OpenIncidentInput!): Incident!
    @aws_auth(cognito_groups: ["admin", "operator"])   # field-level RBAC

  publishSignal(input: PublishSignalInput!): Signal! @aws_iam   # for services
}
```

Two things to notice:

1. **`@aws_auth` is enforced before any resolver runs.** RBAC with no code.
2. **Multiple auth modes coexist on one API.** Cognito for humans, IAM for the
   ingest pipeline. The same schema serves both, with per-field control.

The tenant always comes from `ctx.identity.claims` — the **verified** token —
never from `ctx.args`. A client can put anything in args.

---

## Subscriptions: how they actually work

This surprises everyone once, so be precise about it.

```graphql
type Subscription {
  onIncidentOpened(severity: Severity): Incident
    @aws_subscription(mutations: ["openIncident"])
}
```

```
1. Client opens a WebSocket to the REALTIME endpoint
   (wss://<id>.appsync-realtime-api.<region>.amazonaws.com/graphql)
   and sends a `start` message with the subscription document, its arguments,
   and the same auth header the HTTP endpoint uses.

2. AppSync registers it, remembering the ARGUMENTS as a filter.

3. When `openIncident` completes, AppSync takes the mutation's RETURN VALUE,
   matches it against every registered filter, and pushes it to the sockets
   that match.
```

Consequences you should be able to state:

- **The payload is the mutation's selection set.** If the mutation didn't return
  a field, subscribers cannot receive it — even if they asked for it.
- **You cannot publish by writing to DynamoDB.** To push from backend code you
  must *call the mutation*, usually with IAM auth. That is exactly why
  `publishSignal` exists in this schema and is `@aws_iam`: the ingest pipeline
  calls it purely to trigger subscription fan-out.
- **Filtering is server-side**, so a client watching Dallas is neither billed for
  nor woken by Chicago's traffic.
- **Limits:** 100 subscriptions per connection, 240KB max payload, and an idle
  timeout you must handle by reconnecting.

`enhancedSubscriptionFilters` let you filter on fields that are *not*
subscription arguments, set from inside the mutation resolver via
`extensions.setSubscriptionFilter()` — for things like "only notify users whose
region matches".

→ `src/api/subscriptions.ts`, and `--only=graphql` shows the fan-out with one
watcher matching and one not.

---

## The N+1 problem

```graphql
query { sites { name signals(limit: 5) { kind severity } } }
```

`Query.sites` runs once. `Site.signals` runs **once per site**. Five sites, six
resolver invocations. Fifty sites, fifty-one.

Fixes, best first:

1. **BatchInvoke resolver.** AppSync hands your Lambda an **array** of events
   (up to 2000) instead of one, and you do a single Query per partition. This is
   AppSync's built-in DataLoader.
2. **Per-resolver caching**, keyed on `$context.source`.
3. **Denormalise at write time** — store the top few signals on the Site item.

---

## Caching

`PER_RESOLVER_CACHING` lets you set a TTL on the resolvers that are safe to
cache (the map layer, the site list) and leave the rest alone.

**The risk:** the cache key includes `$context.identity` by default. If you
hand-set `caching_keys` and omit identity, you will serve one tenant another
tenant's cached response. Verify it.

---

## Pagination

Cursor-based, never offset-based. DynamoDB's `LastEvaluatedKey` is a *key*, not
a row number, and offsets cannot express it.

```graphql
type SignalConnection {
  items: [Signal!]!
  nextToken: String     # opaque — base64 of LastEvaluatedKey
}
```

Keep it opaque. Leaking the raw key exposes your key schema.

---

## AppSync-specific scalars

`AWSDateTime`, `AWSDate`, `AWSEmail`, `AWSURL`, `AWSJSON`, `AWSPhone`,
`AWSIPAddress`. They validate for free on the way in.

`AWSJSON` is the escape hatch for arbitrary structures — GeoJSON crosses the
wire as `AWSJSON` here, because modelling GeoJSON in SDL produces a deep union
type nobody wants to write fragments for. Use it deliberately: anything inside
is invisible to the client's type system.
