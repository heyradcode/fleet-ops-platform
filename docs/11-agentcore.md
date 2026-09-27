# The assistant on Amazon Bedrock AgentCore

The board's assistant — the agent loop in `src/ai/agent-core.ts`, its tools
and guardrails — can run on **Amazon Bedrock AgentCore Runtime** instead of in
the browser tab. This document explains what AgentCore is, how it works, how
this repository uses it and why, how to deploy it, and what it costs.

Status: **deployed** - runtime `netpulse_demo_agent`, `READY`, running the
offline model. The authorizer is verified from outside: no token and a
forged token are both refused with 401 before any microVM starts. One thing
outside the code blocks real Claude: the AWS account is not yet enabled for
Anthropic models (see [Claude model access](#claude-model-access)). Until it
is, the agent runs on AgentCore with the repository's offline model, which
exercises every part of AgentCore except the model call.

---

## 1. What AgentCore is

An **agent** is a loop: send the conversation and a list of tools to a model;
if the model asks for a tool, run it, append the result, and ask again; stop
when the model answers. `src/ai/agent-core.ts` is exactly that loop, with an
iteration cap, per-tool authorisation and a trace of every step.

Writing the loop is the easy part. Running it for real users is not: every
conversation needs somewhere isolated to run, the caller has to be
authenticated, the agent needs credentials for the systems it touches,
conversations want memory, and someone has to be able to see what happened.

**AgentCore is AWS's managed platform for that second part.** It is a set of
independent services; you use the ones you need:

| Service | What it does | Used here |
|---|---|---|
| **Runtime** | Hosts your agent code. Each *session* gets its own isolated **microVM** (CPU, memory, filesystem), kept warm between requests in that session and destroyed after it. Any framework, any model. | **Yes** |
| **Identity** | *Inbound*: who may invoke the agent (IAM SigV4, or JWTs from your OIDC provider). *Outbound*: credentials the agent uses to call other services on a user's behalf (OAuth token vault). | **Inbound, yes** (Cognito JWT) |
| **Gateway** | Turns existing APIs and Lambda functions into MCP tools, with policy, guardrails and interceptors in front. | No |
| **Memory** | Managed short-term (conversation) and long-term (extracted facts, preferences) memory. | No |
| **Code Interpreter** / **Browser** | Sandboxed code execution and a managed headless browser as tools. | No |
| **Observability** | Traces, metrics and logs for sessions and tool calls, in CloudWatch. | Logs only |

AgentCore does **not** replace the model provider. The model is whatever the
agent calls; here, Claude on Amazon Bedrock. AgentCore hosts the thing that
calls it.

---

## 2. How AgentCore Runtime works

### The contract

Your code is a small HTTP server. AgentCore requires three things of it
([HTTP protocol contract][contract]):

- listen on `0.0.0.0:8080`;
- `GET /ping` returns `{"status": "Healthy"}` (or `"HealthyBusy"` while
  background work is running, which keeps the session alive);
- `POST /invocations` takes the request body and returns JSON (or SSE for
  streaming).

That is the whole interface. The framework, the model and the tools are yours.

### Deploying code

Two artefact types:

- **Container**: an arm64 image in ECR.
- **Direct code deployment**: a `.zip` in S3 with an entry-point file and its
  dependencies. Node.js has been supported since April 2026 (`NODE_22`), with
  either vendored `node_modules/` or a single esbuild bundle
  ([Node.js direct code deployment][node]).

This repository uses **direct code deployment**, so no Docker is involved.
`pnpm build:agent` produces one bundled `agent.js`, and Terraform zips it and
uploads it.

### Sessions and microVMs

Every invocation carries a session id
(`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`, 33+ characters).

- **The first request with a new id** starts a fresh microVM: a cold start,
  when your module-level code runs.
- **Later requests with the same id** go to the **same warm microVM**, with
  its memory intact.
- **An idle session** is torn down after `idleRuntimeSessionTimeout`, and
  every session ends at `maxLifetime` regardless.

Two consequences shape the code here:

1. **Per-microVM state is per-session state.** Anything cached at module scope
   (the DynamoDB client, the Bedrock client, the JWKS keys, the ingested
   runbooks) is shared by every request in that session, and by nobody else.
2. **Session ids must not be shared between people.** The board makes a new
   id whenever the signed-in token changes, so the next person at the desk
   never lands in the previous person's microVM.

### Inbound auth (AgentCore Identity)

A runtime accepts **either** IAM SigV4 **or** JWT bearer tokens, not both
([inbound auth][oauth]). With a JWT authorizer you give it:

- `discoveryUrl`: your IdP's `/.well-known/openid-configuration`. The issuer
  must match the token's `iss`.
- `allowedClients`, matched against the token's `client_id` claim, and/or
  `allowedAudience`, matched against `aud`.

AgentCore validates the token **before** anything starts, so a bad request
never costs a microVM.

**The container does not see the token unless you allowlist the header**
(`requestHeaderConfiguration.requestHeaderAllowlist`). AgentCore forwards no
request header it was not told to.

### Invoking it

```
POST https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{URL-encoded ARN}/invocations?qualifier=DEFAULT
Authorization: Bearer <JWT>
X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <33+ chars>
Content-Type: application/json
```

The endpoint answers a CORS preflight for any origin, allowing the
`Authorization` and session-id headers. This was checked against the live
endpoint while building this. **So a browser can call an agent directly with
the user's own token**: no proxy, no AWS credentials in the page.

### Pricing

Runtime bills per second:

| What | Price | When it's charged |
|---|---|---|
| CPU | $0.0895 per vCPU-hour | Only while the agent is actually computing. Waiting on the model, DynamoDB or the network is not billed. |
| Memory | $0.00945 per GB-hour | For the whole life of the session, including idle time until the idle timeout. |

For an agent that mostly waits on a model, the model's tokens are the bill,
and the runtime is cents.

---

## 3. How this repository uses it

```
 board (browser)
   │  POST …/runtimes/{arn}/invocations?qualifier=DEFAULT
   │  Authorization: Bearer <Cognito ACCESS token>       ← the one the board signed in with
   │  X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: netpulse-<48 hex>
   ▼
 AgentCore Identity ── JWT authorizer: issuer = the pool, client_id = the board's app client
   │                    (rejected here → 401, nothing started, nothing billed)
   ▼
 AgentCore Runtime ── microVM for this session: `node agent.js`   (NODE_22, arm64)
   │   infra/terraform/agentcore/agent-entry.ts   the socket + wiring, once per microVM
   │   src/ai/agent-invocation.ts                 the handler:
   │     1. read the forwarded Authorization header
   │     2. re-verify it: all seven checks (token_use, tenant claim, …)
   │     3. validate the question
   │     4. seed the demo world, load the caller's estate, ingest runbooks once
   │     5. runAgent() with READ-ONLY tools, as the caller
   ├──▶ Claude on Bedrock   src/aws/bedrock.sdk.ts (AnthropicBedrockMantle) - or the offline model
   └──▶ DynamoDB            src/aws/dynamodb.sdk.ts - GetItem/Query only, keys from the caller's tenant
```

### The files

| File | Role |
|---|---|
| `src/ai/agent-core.ts` | The loop. Unchanged in spirit; it now reports a model `refusal` or `max_tokens`, and refuses any tool it did not offer. |
| `src/ai/agent-invocation.ts` | One invocation: token → principal → answer. Portable and tested. |
| `src/aws/bedrock.ts` | The model **registry**: the scripted offline model by default, a real model when registered. |
| `src/aws/bedrock.sdk.ts` | Claude on Bedrock via `AnthropicBedrockMantle`, with a one-shot fallback on refusal. Node only. |
| `infra/terraform/agentcore/agent-entry.ts` | The `node:http` server on 8080: `/ping`, `/invocations`. |
| `scripts/build-agent.mjs` | esbuild: one CommonJS `agent.js`, SDKs bundled, runbooks embedded. |
| `infra/terraform/agentcore/*.tf` | S3 code bucket, execution role, the runtime with its JWT authorizer. |
| `web/src/transport/agentcore.ts` | The board's caller: URL, token, per-person session, error wording. |

### The decisions, and why

**Code deployment, not a container.** There is no Docker on the development
machine, and there doesn't need to be: one bundled file fits in the
direct-deployment zip with room to spare.

**The browser calls AgentCore directly.** The alternative, a Lambda behind
the existing HTTP API that forwards the call, adds a hop and API Gateway's
30-second integration timeout. A multi-step answer from a real model can run
past that. The endpoint's CORS support made the proxy unnecessary.

**JWT inbound auth, with the user's own token.** The board already holds a
Cognito access token. Configuring AgentCore Identity with the same pool means:
- the agent is invoked **as the person asking**;
- there are no AWS credentials in the browser;
- a bad token is rejected before a microVM starts.

`allowedClients` is used, not `allowedAudience`: a Cognito **access** token
has no `aud` claim, so an audience check would reject every one.

**The token is checked twice.** AgentCore checks signature, issuer, expiry and
`client_id`. It does **not** check `token_use`, so an ID token from the same
pool would pass. Nor does it check that a tenant claim exists, and the tenant
claim is the boundary every tool derives its keys from. So the handler
re-verifies with all seven checks (`auth/cognito-jwt-verifier.ts`). It's the
same rule the board API follows behind its gateway authorizer.

**Read-only.** The deployed agent is offered the read tools only, and the
loop now refuses any tool it did not offer, whatever the model asks for.
Opening an incident pages a human; a model in the cloud doing that is a
decision, not a default. The execution role backs this up: `GetItem` and
`Query`, no writes.

**A model registry, not a hard-coded client.** `invokeModel` is where the
scripted model and Claude are swapped, so the loop, the tools and the tests
are identical either way.
- `agent_model = "offline"` deploys the whole AgentCore path with no model
  cost.
- A Claude model ID switches to Claude with one variable.

**The model is Claude Opus 5 on Bedrock**, via `AnthropicBedrockMantle`: the
Messages API on Bedrock's own endpoint, with the same request shape as
Anthropic's API and SigV4-signed with the runtime's execution role.
- **Thinking blocks go back unchanged.** A real model returns them, and the
  loop already appends each assistant turn verbatim.
- **A refusal is retried once on a fallback model** (`anthropic.claude-opus-4-8`
  by default). Bedrock does not offer the first-party server-side `fallbacks`
  parameter, so the fallback is client-side, in the adapter.

**A separate Terraform root.** AgentCore's Terraform resources exist only in
AWS provider 6.x, while `infra/terraform/auth` runs on 5.x with a live
deployment behind it. A major provider upgrade shouldn't ride in on a new
feature. This root reads `../auth`'s state (the pool and the table) and
changes nothing there.

**The code key contains the content hash.** A fixed S3 key would leave the
runtime pointing at the same path after a rebuild, with nothing telling it the
bytes changed. With the hash in the key, a new build means a new artifact, a
runtime update and a new runtime version.

### Things that were learned building it

- **The entry file's module type is decided by the nearest `package.json`.**
  Locally that was the repository root's `"type": "module"`, and the CommonJS
  bundle died on its first `require()`. In the zip there is no `package.json`
  above it, so it would have worked there. A local test that disagrees with
  production is worse than none, so the build writes a one-line
  `{"type":"commonjs"}` beside `agent.js` and ships it.
- **The runtime has no AWS SDK.** Unlike Lambda's Node runtime, `NODE_22` on
  AgentCore ships nothing, so the bundle includes the SDKs. Marked `external`,
  as for the Lambdas, they would fail with `Cannot find module` on the first
  request after a deploy that reported success.
- **Zip permissions.** AgentCore needs files readable (644). A zip made on
  Windows carries no Unix modes; `output_file_mode = "0644"` sets them.
- **Creating a runtime also creates its `DEFAULT` endpoint** - a separate
  action, `bedrock-agentcore:CreateAgentRuntimeEndpoint`. The first deploy
  failed on exactly that: the runtime call was allowed, the endpoint behind
  it was not, and the error names only the second.
- **IAM needs a moment.** An apply seconds after publishing a new policy
  version failed with the same AccessDenied as before the fix. The policy
  simulator (`aws iam simulate-principal-policy`) tells a propagation delay
  from a real denial - test `CreateAgentRuntime` against resource `*`, since
  it takes no runtime ARN and a runtime-ARN simulation reports a misleading
  implicit deny.
- **Session ids and the seeded demo world.** The board seeds `uuid()` for
  deterministic output. Session ids come from `crypto.getRandomValues`
  directly, or every tab would have asked for the same microVM.

---

## 4. Claude model access

A test call from this account to `anthropic.claude-opus-5`,
`anthropic.claude-sonnet-5` and `anthropic.claude-haiku-4-5` returned, for
all three:

> 403 — *"… is not available for this account. … For additional access
> options, contact AWS Sales."*

The models are listed in `us-east-1`, and Haiku 4.5 is documented as open to
all Bedrock customers, so this is an **account-level** restriction, not
permissions or code. The usual causes, in the order to check:

1. **Anthropic's one-time use-case form.** Open the Bedrock console →
   *Model catalog* → any Claude model, and submit the form if you're prompted.
2. **A new account still being verified.** Bedrock model access on a fresh
   account can be limited until billing verification completes.
3. **Organisation policy.** An SCP that denies Bedrock or marketplace
   subscriptions.

To re-test after fixing it, from the repo root:

```powershell
node -e "import('@anthropic-ai/bedrock-sdk').then(async ({AnthropicBedrockMantle}) => { const c = new AnthropicBedrockMantle({awsRegion:'us-east-1'}); const r = await c.messages.create({model:'anthropic.claude-opus-5',max_tokens:16,messages:[{role:'user',content:'Reply OK'}]}); console.log(r.stop_reason, r.content) })"
```

Once that answers, switch the agent to Claude (step 5 below).

---

## 5. Deploying it

From the repo root, in PowerShell. `infra/terraform/auth` must already be
applied: this root reads its pool and table.

**1. Permissions** for the deploying user (a customer-managed policy, for the
reason in `infra/terraform/auth/README.md`):

```powershell
cd infra\terraform\agentcore
aws iam create-policy --policy-name NetpulseAgentCoreDeploy --policy-document file://deploy-policy.json
aws iam attach-user-policy --user-name YOUR_USER --policy-arn arn:aws:iam::588651260734:policy/NetpulseAgentCoreDeploy
```

**2. Build the agent:**

```powershell
cd ..\..\..
pnpm build:agent
```

**3. Choose the model.** Until Claude access is granted, create
`infra\terraform\agentcore\terraform.tfvars` (it is gitignored):

```hcl
agent_model = "offline"
```

**4. Plan, then apply:**

```powershell
cd infra\terraform\agentcore
terraform init
terraform plan     # expect: 7 to add - bucket (+2 settings), code object, role, role policy, runtime
terraform apply
cd ..\..\..
```

**5. Point the board at it and ask something:**

```powershell
pnpm web:env       # now also writes VITE_AGENT_RUNTIME_ARN
pnpm web
```

Sign in, open a device or the comms view, and ask the assistant a question.
The request goes from your browser to AgentCore. The first question in a
session is a cold start (a second or two); follow-ups reuse the warm microVM.

**Switching to Claude later:** set `agent_model = "anthropic.claude-opus-5"`
(or remove the line), then `terraform apply`. AgentCore creates a new runtime
version, and new sessions use it.

**Updating the code:** `pnpm build:agent`, then `terraform apply`. The new
zip has a new hash, so the runtime updates.

**Tearing it down:** `terraform destroy` in `infra/terraform/agentcore`, then
remove the `VITE_AGENT_RUNTIME_ARN` line (or run `pnpm web:env` again) so the
assistant goes back to running in the tab.

### Where to look when it doesn't work

| Symptom | Cause |
|---|---|
| Browser: *"Your session has expired - sign in again"* on the first question | AgentCore rejected the token: the pool or client in the runtime's authorizer isn't the one the board signed in with. Compare `terraform output` in both roots. |
| *"The assistant failed on this question"* (424) | The agent returned an error. Check CloudWatch → `/aws/bedrock-agentcore/runtimes/netpulse_demo_agent-*`. `no bearer token reached the agent` means the header allowlist is missing. |
| 424, with `permission_error … not available for this account` in the logs | Claude access (section 4). Set `agent_model = "offline"` meanwhile. |
| 424 with `AccessDenied` on `bedrock-mantle:CreateInference` | The execution role's model statement. See the comment in `main.tf`. |
| Runtime `CREATE_FAILED` | Usually the zip: rebuild with `pnpm build:agent`. The failure reason is in `aws bedrock-agentcore-control get-agent-runtime`. |

---

## 6. Costs, concretely

| Piece | Cost at demo volume |
|---|---|
| Runtime | CPU only while computing; memory for up to 5 idle minutes per session. A few cents a month. |
| S3 (one zip, a few MB) | Fractions of a cent. |
| Claude Opus 5 on Bedrock | **The real cost.** Per-token pricing ([Bedrock pricing][bedrock-pricing]). A question typically takes 3-6 model calls with tool results in context, so estimate cents per question. `agent_model = "offline"` costs nothing. |

The $5 monthly budget alarm in `infra/terraform/auth` covers the account. At
Opus prices, a long afternoon of questions can reach it. That's the alarm
working, not a fault.

---

## 7. What AgentCore could do here next

The other AgentCore services map onto real gaps in this platform:

- **Memory:** follow-up questions ("and the one above it?") currently start
  from nothing. Short-term memory keyed on the session would give the agent
  the conversation.
- **Gateway:** the agent's tools are code inside the bundle. Gateway could
  expose the board API's routes as MCP tools, with policy and guardrails
  outside the agent, and the runtime could be restricted to accept calls only
  through it.
- **Observability:** ADOT auto-instrumentation gives per-step traces in
  CloudWatch. The bundle is CommonJS partly to keep that option open, because
  ADOT only patches `require()`.
- **Streaming:** `/invocations` can answer with SSE, so the board could show
  each tool call as it happens instead of waiting for the whole trace.

## Sources

- [AgentCore Runtime: HTTP protocol contract][contract]
- [Direct code deployment for Node.js][node]
- [Inbound and outbound auth (JWT, header allowlist, invoking with a bearer token)][oauth]
- [Terraform: `aws_bedrockagentcore_agent_runtime`][tf]
- [Claude in Amazon Bedrock (Mantle endpoint, model IDs, IAM)][mantle]
- [AgentCore pricing breakdown][pricing]
- [Amazon Bedrock pricing][bedrock-pricing]

[contract]: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html
[node]: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html
[oauth]: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html
[tf]: https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime
[mantle]: https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock
[pricing]: https://cloudburn.io/blog/amazon-bedrock-agentcore-pricing
[bedrock-pricing]: https://aws.amazon.com/bedrock/pricing/
