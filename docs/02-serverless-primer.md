# Serverless primer

For someone who knows back-end engineering but has not built on AWS serverless.
The mental models, not the API reference.

---

## Lambda

**What it is:** you upload a function; AWS runs it on demand and bills you per
millisecond of execution × the memory you configured. No servers, no capacity
planning, scales to zero and to thousands.

**The execution model — the part that matters:**

```
cold start:  provision microVM → download package → start runtime
             → run MODULE-SCOPE code → run handler
warm start:  run handler                        ← reuses everything above
```

A container is reused for many invocations. So:

```ts
// Module scope: runs ONCE per container. Do expensive setup here.
const ddb = new DynamoDBClient({});
const secret = await getSecret();          // top-level await is allowed

export async function handler(event) {
  // Runs per invocation. Keep it lean.
}
```

Creating an SDK client inside the handler is the single most common Lambda
performance mistake — you pay the TLS handshake and credential resolution on
every call instead of once per container.

**Memory is the only performance dial.** CPU scales linearly with it. A function
that runs twice as fast at 1024MB as at 512MB costs *the same*, because billing
is GB-seconds. The cheapest setting is rarely the smallest — measure with AWS
Lambda Power Tuning.

**Limits to know:** 15 min timeout, 10GB memory, 250MB unzipped package (10GB as
a container image), 6MB synchronous payload, 1000 concurrent executions by
default (a soft limit, raise it).

**Concurrency settings:**
- *Reserved* concurrency **caps** a function — use it to stop a runaway ingest
  from starving your user-facing API of the shared account pool.
- *Provisioned* concurrency keeps N environments warm — costs money, so only on
  latency-critical paths like the authorizer.

**Always create the log group in Terraform.** If you let Lambda create it
implicitly, retention is NEVER EXPIRE and your CloudWatch bill grows forever.
→ `infra/terraform/modules/lambda/main.tf`

---

## API Gateway

Two products with confusingly similar names.

| | HTTP API (v2) | REST API (v1) |
|---|---|---|
| Cost | ~70% cheaper | |
| Latency | Lower | |
| JWT authorizer | Built in | Lambda authorizer only |
| Request validation | No | Yes (JSON Schema) |
| API keys / usage plans | No | Yes |
| WAF, private endpoints, canary deploys | No | Yes |

**Default to HTTP API.** Choose REST API when you specifically need one of the
right-hand column.

**Three ways to authorise a route:**

1. **Cognito/JWT authorizer** — zero code, API Gateway validates the token
   itself. Use when "is the token valid" is the whole rule.
2. **Lambda authorizer** — your code returns an IAM policy. Use when the
   decision needs *your* data: tenant status, subscription tier, per-route
   roles, IP allow-lists.
3. **IAM (SigV4)** — service-to-service, not humans.

**The Lambda-authorizer trap.** Set `authorizerResultTtlInSeconds` or you invoke
it on every single request. But the cached policy is keyed on the **token**, not
the path — so if you return a path-specific policy with caching on, the first
route the user hits becomes the only one they can reach. Return a **wildcard**
policy over the API and enforce per-route rules downstream using the `context`
you pass through.
→ `src/auth/authorizer.ts`

**Webhooks** authenticate with an HMAC signature over the raw body, not a JWT —
the vendor has no Cognito token. Verify the signature *before* parsing, return
200 fast and queue the work (vendors retry aggressively on slow responses), and
be idempotent, because you will receive the same delivery twice.

---

## Step Functions

A state machine defined in **Amazon States Language** (JSON). Use it when a
workflow has more than ~2 steps, needs per-step retry or branching, or can
outlive a 15-minute Lambda. Use plain Lambda + EventBridge when the steps are
genuinely independent.

**The state types you will actually use:**

| State | Purpose |
|---|---|
| `Task` | Call a Lambda or an AWS service directly |
| `Map` | Fan out over an array, with `MaxConcurrency` |
| `Choice` | Branch on the data |
| `Parallel` | Run several branches at once |
| `Pass` | Reshape data without calling anything |
| `Wait` | Sleep — for seconds or until a timestamp |
| `Succeed` / `Fail` | Terminate |

**Retry and Catch are per-state**, which is the whole reason to use the service:

```json
"Retry": [{
  "ErrorEquals": ["ProviderThrottled", "States.TaskFailed"],
  "IntervalSeconds": 2, "MaxAttempts": 4,
  "BackoffRate": 2, "JitterStrategy": "FULL"
}],
"Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "MarkProviderFailed" }]
```

`JitterStrategy: FULL` matters. Without jitter, every parallel branch that was
throttled at the same instant retries at the same instant and recreates the
spike that caused the throttling.

**`ToleratedFailurePercentage` on a Map state** lets the run succeed on partial
data. In an ops dashboard, seven vendors' data beats none.

**Standard vs Express:** see the cheat sheet. Short version — Standard for
scheduled workflows you will need to debug, Express for per-request
orchestration at volume.

→ `src/pipeline/state-machine.asl.json` (deployable) and
`src/pipeline/ingest-workflow.ts` (the same thing, runnable)

---

## EventBridge

A router. Producers `PutEvents`; **rules** match on event content and forward to
targets.

```json
{
  "source": ["netpulse.detect"],
  "detail-type": ["IncidentOpened"],
  "detail": { "severity": ["critical"] }
}
```

Arrays mean "any of". Matching happens **in the bus**, so a Lambda subscribed to
critical incidents is never invoked for a warning — you don't pay to start a
function that immediately decides the event wasn't for it.

**Put the fields rules will filter on at the top level of `detail`.** Deeply
nested match fields make for fragile patterns.

**Use a custom bus, not the default one.** The default bus also carries every
AWS service event in the account, so your rules filter through noise you don't
control, and you can't cleanly manage access to it.

**Attach a DLQ to every rule that matters.** EventBridge retries a failing target
for up to 24 hours and then **drops the event silently**.

**Archive + replay** is the recovery story for "our consumer had a bug for six
hours" — you replay the archive instead of asking vendors for history.

**EventBridge Scheduler** (not the older rule-with-a-cron-expression) is the
current service for schedules: one-off schedules, time zones with DST handling,
and a **flexible time window** that jitters the start so a thousand tenants
don't all fire at `:00`.

→ `src/aws/eventbridge.ts`, `infra/terraform/modules/eventbridge/main.tf`

---

## How they fit together here

```
Scheduler ─▶ Step Functions ─▶ Lambda × 5 ─▶ DynamoDB + S3
                                    │
                                    └─▶ EventBridge ─▶ pager
                                                     ─▶ AI summariser
                                                     ─▶ analytics
```

Step Functions for the **known, ordered** pipeline. EventBridge for the
**unknown, unordered** set of things that care about the result. That split is
the design decision worth being able to defend.
