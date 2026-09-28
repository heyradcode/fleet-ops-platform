# AI orchestration today, and how MCP and the knowledge graph would be added

Three parts:

1. **How AI orchestration works now**: what the code does, file by file.
   This part describes shipped code.
2. **MCP.** Built: an MCP tool server on AgentCore Runtime, behind an
   AgentCore Gateway that passes the user's token through, with an audit
   trail and a board view of it.
3. **The knowledge graph.** Phases 1 to 3 are built: the facility join,
   the graph, candidate causes on the comms board and in the brief, and the
   graph's agent tools, served through the MCP server.

The designs follow the proposal deck's AI architecture (slides 3, 5, 6, 11
and 12). The deck is held locally and not in the repository. They are shaped
to fit the rules this codebase already enforces: tenancy from the token,
context never becoming evidence, and determinism where a number is reported.

---

## Part 1 — How AI orchestration works now

### The shape in one picture

```
                    ┌───────────────────────── one of two HOSTS ─────────────────────────┐
                    │  in the browser tab                 on AgentCore Runtime           │
                    │  web/src/transport/in-process.ts    infra/terraform/agentcore/     │
                    │                                     agent-entry.ts  (Node, :8080)  │
                    └───────────────┬─────────────────────────────────┬──────────────────┘
                                    │                                 │ src/ai/agent-http.ts
                                    │                                 │   JSON or SSE stream
                                    │                                 │ src/ai/agent-invocation.ts
                                    │                                 │   token (7 checks) → principal
                                    │                                 │   conversation history (per user)
                                    ▼                                 ▼
                    ┌──────────────────── src/ai/agent-core.ts : runAgent() ────────────────────┐
                    │  input guardrail → [ model → tools → model → … ] → output guardrail      │
                    │  system prompt · history · budget · trace · onStep (streaming)          │
                    └───────┬───────────────────────────────┬───────────────────────────────────┘
                            │ invokeModel()                 │ executeTool(name, input, principal)
                            ▼                               ▼
              ┌──────── MODEL REGISTRY ────────┐   ┌──────────── TOOL REGISTRY ────────────┐
              │ src/aws/bedrock.ts              │   │ src/ai/tools.ts        network tools  │
              │   scripted offline model        │   │ src/ai/comms-tools.ts  comms tools    │
              │ src/aws/bedrock.sdk.ts          │   │ src/ai/itsm-tools.ts   Helix changes  │
              │   Claude on Bedrock (Mantle)    │   │ toolSpecsFor(principal, {readOnly})   │
              └─────────────────────────────────┘   └───────┬──────────────────────────────┘
                                                            ▼
                                   repositories (keys from the principal's tenant),
                                   the knowledge base (RAG), Splunk / Helix registries
```

The orchestration is **one agent loop**, used by both hosts. It has no
framework: the loop is about two hundred lines, written so every decision in
it can be read and tested.

### 1. The hosts

The loop runs in two places, with the same code in both:

| Host | Entry | Who calls it | Tools offered | Model |
|---|---|---|---|---|
| **In the tab** | `web/src/transport/in-process.ts` → `askAgent` | The board directly, when `VITE_AGENT_RUNTIME_ARN` is unset | `toolSpecsFor(principal, { readOnly: false })`: read tools **and** the write tools the role allows | Always the offline model |
| **On AgentCore** | `infra/terraform/agentcore/agent-entry.ts` → `serveInvocation` → `handleAgentInvocation` | The board over HTTPS, with the user's Cognito token | `toolSpecsFor(principal, { readOnly: true })`: read tools only | Set by `AGENT_MODEL`: `offline`, or a Claude model ID |

`web/src/transport/select.ts` picks the host: the AgentCore ARN routes the
assistant there, and anything else keeps it in the tab.

### 2. What happens before the loop (AgentCore host)

`src/ai/agent-invocation.ts`, in order:

1. **Token.** It reads the forwarded `Authorization` header (allowlisted in
   Terraform) and runs all seven checks (`verifyTokenRs256`) against **real
   time**. This yields a `Principal`: user, tenant, roles and scope. Nothing
   downstream trusts anything else to decide what may be seen.
2. **Request validation.** The body must be `{"question": …}`, non-empty and
   at most 2,000 characters.
3. **World setup.** It seeds the demo world and loads the caller's tenant
   estate, so the tools describe the same devices as the board.
4. **Knowledge base.** It ingests the runbooks once per tenant per microVM.
5. **Conversation history.** The last four question/answer pairs, stored in
   the microVM's memory and keyed by `tenantId|sub`. That is the verified
   user, not the session, because AgentCore does not bind a session to a user.
6. **The loop.** `runAgent({ question, principal, tools, history, onStep })`.
7. **After the loop.** It remembers the turn only if the answer passed the
   output guardrail. It stamps `servedBy: { host, model, turn }`.

### 3. The loop: `src/ai/agent-core.ts`

**Context assembly.** Every model call receives:
- **the system prompt** (`SYSTEM_PROMPT`), which fixes the agent's
  discipline:
  - ground recommendations in a retrieved runbook;
  - check observations before explaining a cause;
  - trace the topology before blaming a device;
  - say which observation planes support a conclusion;
  - never claim an action no tool took;
- **the history**, as alternating plain-text user/assistant turns (no tool
  calls, no thinking blocks);
- **the current question**, after PII redaction;
- **every assistant turn and tool result of this run so far**, appended
  verbatim. Verbatim matters: a real model's `thinking` blocks must go back
  unchanged.

**The budget.** `maxIterations` defaults to `max(8, tools.length + 2)`: one
step per tool, one for the answer, one spare. It was a fixed 8, and the first
real AgentCore question (an HHS caller offered 10 tools) ran out of steps.

**Each iteration:**

```
response = invokeModel({ system, messages, tools, maxTokens: 16000 })
append the assistant turn verbatim
switch (response.stop_reason):
  'refusal'    → return "The model declined …"          (never a blank answer)
  'max_tokens' → return the tool evidence, flagged as cut off
  not tool_use → output guardrail → return the answer
  'tool_use'   → run EVERY tool_use block in parallel (Promise.all)
                 → append ALL results in ONE user message
                 → next iteration
```

Two details there are the difference between a demo and a loop that holds up:
- **All tool results go back in one message.** Splitting them across
  messages teaches a model to stop calling tools in parallel.
- **Errors come back as data.** A tool that throws, or is refused, returns
  `ERROR: …` as its result, so the model can correct itself. A tool failure
  never kills the turn.

**Tool dispatch (`executeTool`).** Three gates, in order:
1. **Offered?** The tool must be in this run's offered list, or it's refused.
   A real model can name a tool it was never shown, and a read-only run that
   dispatched `openIncident` anyway would be read-only in the prompt only.
2. **Exists?** `toolByName(name)`.
3. **Allowed for this role?** `canUseTool(principal, name)`: write tools
   (`openIncident`, `acknowledgeIncident`, `suppressAlarm`) need `admin` or
   `operator`.

**Trace and streaming.** Every guardrail check, model turn and tool call
becomes an `AgentTrace` entry. The same entry is handed to `onStep` at the
moment it happens, which is what the board streams live.

### 4. The model layer: a registry

`src/aws/bedrock.ts` exposes `invokeModel(request)`, the only way the loop
reaches a model. A Node entry point can register a real model
(`setModelInvoker`); otherwise the scripted model answers.

- **The scripted offline model** (`plan()` in `bedrock.ts`) calls each
  eligible tool once, in order, then writes an answer from the tool results.
  - **Write tools are withheld** unless the question reads like an action
    ("open", "page", "escalate"…).
  - **Arguments come from the latest question,** such as a device ID or a
    site. It reads the latest question, not the first; with history it would
    otherwise answer the opening question forever.
  - **It is deterministic,** so the demo and the tests are reproducible. It
    is a stand-in, not reasoning.
- **Claude on Bedrock** (`src/aws/bedrock.sdk.ts`) uses `AnthropicBedrockMantle`,
  the Messages API on Bedrock's endpoint, signed with the runtime's IAM role.
  - **Thinking blocks pass through untouched.**
  - **A `refusal` is retried once** on `AGENT_FALLBACK_MODEL`
    (`anthropic.claude-opus-4-8`). Bedrock has no server-side `fallbacks`
    parameter, so the fallback is client-side.

That is the whole of "model routing" today: offline or one Claude model, plus
a fallback on refusal.

### 5. The tool layer: a per-tenant registry

`toolSpecsFor(principal, { readOnly })` builds the list each run offers:

| Group | Source | Tools |
|---|---|---|
| Network | `src/ai/tools.ts` (`TOOL_SPECS` / `READ_ONLY_TOOL_SPECS`) | `searchRunbooks`, `queryDeviceObservations`, `searchSplunk`, `traceTopology`, `listOpenIncidents`, plus write tools `openIncident`, `suppressAlarm` |
| Comms (tenants running comms sources) | `src/ai/comms-tools.ts` (`commsToolsFor`) | `listCommsIncidents`, `queryWorkforce`, `integrationHealth`, `dailyBrief`, `explainAnomalies` |
| ITSM (tenants with Helix) | `src/ai/itsm-tools.ts` (`itsmToolsFor`) | `recentChanges` (up the uplink chain, never sideways) |

**Every tool receives the principal and derives its keys from it.** A tool
cannot read another tenant's data, because no function accepts a bare tenant
ID. Some tools are "context" connectors behind registries: Splunk's search
catalogue and the Helix client. When one isn't configured, the tool says so
("not configured"), which is different from "no results".

### 6. Retrieval (RAG): `src/ai/knowledge-base.ts`

- **Chunking:** by markdown heading, because the runbook author already
  marked the semantic boundaries.
- **The tenant filter:** applied before scoring, and never optional.
- **Hybrid scoring:** `0.7 × vector + 0.3 × lexical`, then top-K.
- **Offline embeddings are a hash of tokens,** so the vector term measures
  token overlap, not meaning. The real semantic part arrives with a real
  embedding model.

Two entry points:
- **`searchRunbooks`**, a tool inside the agent loop.
- **`askWithRag`** (`src/ai/bedrock-rag.ts`), a single-shot "retrieve →
  augment → answer with numbered citations" path, used by the GraphQL
  `askRunbooks` query.

### 7. Guardrails: `src/ai/guardrails.ts`

| Where | Check |
|---|---|
| Before the loop | `checkInput`: off-limits topics, the classic injection phrasing, cross-tenant enumeration ("all tenants"); PII redaction |
| Each tool call | `canUseTool`: role check on write tools; plus the loop's "offered only" gate |
| After the loop | `checkOutput`: grounding, which withholds an answer if under 15% of its terms appear in what the tools returned; PII redaction |

These are hand-written stand-ins for the checks Bedrock Guardrails performs,
so each rule stays visible and testable.

### 8. What is deliberately NOT the model's job

- **The daily brief's numbers** come from stored data through a template
  (`src/reporting/daily-brief.ts`), never from a model.
- **Anomalies** are statistics (hour-of-week baselines), explained in words
  generated from the numbers.
- **Alarms and incidents** come from the rules (corroboration across planes,
  topology anchoring). The agent reads them; it never creates or suppresses
  one in the deployed read-only form.

### 9. Measured against the deck's "LLM orchestration" layer

| Deck | Now |
|---|---|
| Model routing | Offline / one Claude model, plus a fallback on refusal. No task-based routing. |
| Prompt management | One system prompt in code. No versioning, no per-tenant or per-persona prompts. |
| Context assembly | ✅ History, question, tool results, trace. |
| Purpose-built agents (5) | One agent whose tools cover all five areas. |
| Audit trail | The trace goes back with every answer; nothing is persisted. |

---

## Part 2 — MCP integration (built: the server, the Gateway front door, the audit trail)

### What the deck asks of MCP

The deck calls MCP an **AI governance protocol**, not a data pipeline:
- tools registered per tenant;
- tenant-scoped context carried by the JWT;
- hard capability boundaries;
- **an audit trail of every interaction**;
- prompt and output filtering.

The in-process tool registry already delivers the first three *in
behaviour*. What MCP adds is:
- **a protocol boundary:** tools become a separate, independently deployed and
  audited service, which any MCP client can use (the agent, another agent, an
  IDE);
- **the audit trail**, in the one place every tool call passes through;
- **a place for AgentCore Gateway**: one governed front door, with token
  checks, metrics and policy outside the agent.

### The target architecture

```
board ──JWT──▶ AgentCore Runtime: AGENT  (today's agent, HTTP protocol, :8080)
                    │  agent loop, unchanged
                    │  tools now reached through an MCP CLIENT, carrying the SAME user token
                    ▼
               AgentCore Runtime: MCP SERVER  (new; protocol MCP, :8000/mcp, stateless streamable HTTP)
                    │  JWT authorizer: the same pool and client
                    │  re-verifies the token (7 checks) → principal
                    │  tools/list  = toolSpecsFor(principal, readOnly)   ← the tenant's tool registration
                    │  tools/call  = the same execute(input, principal) functions as today
                    │  AUDIT: one record per call (tenant, user, tool, argument hash, outcome, time)
                    ▼
               DynamoDB (read-only role) · the knowledge graph (Part 3) · Helix / Splunk registries
```

AgentCore Runtime hosts MCP servers directly (the `MCP` server protocol,
`0.0.0.0:8000`, `POST /mcp`, stateless streamable HTTP), with the same JWT
authorizer our agent already uses. The user's token therefore travels all the
way to the tool. The tenant is derived from the token **at the tool
boundary**, exactly as the rest of the platform does it, and is never taken
from a tool argument.

### Behind the AgentCore Gateway

The first version of this section put Gateway off to a "phase 2". It assumed
that anything behind Gateway is reached with the gateway's own identity,
which would break the tenant boundary. That's true of one of the two ways to
put an MCP server behind Gateway, and not of the other.

| | MCP gateway, "MCP server" target | Gateway with an "AgentCore Runtime" target |
|---|---|---|
| What it is | Aggregates tools from many MCP servers into one virtual server | A governed front door: forwards requests to the runtime unchanged |
| How it reaches our server | IAM, API key, OAuth client credentials, or on-behalf-of exchange | Can **pass the user's token through** (`JWT_PASSTHROUGH`) |
| Who the tool thinks asked | The gateway, unless on-behalf-of exchange works, which needs an IdP implementing RFC 8693/7523. Cognito user pools don't. | **The user**, exactly as without the gateway |
| `tools/list` | Synced by the gateway once, the same for everyone | Our server's, **per caller** (5 tools for a Dallas operator, 13 for an HHS admin) |
| Semantic tool search | Yes | No |
| Token check, metrics, AgentCore Policy, interceptors | Yes | Yes |

**We use the Runtime target.** It adds the front door without giving up the
property the design rests on: the user's own token reaches the tool.

```
board ──JWT──▶ Runtime: AGENT ──same user token──▶ GATEWAY
                                                     │ checks the token itself (same pool, same client)
                                                     │ JWT_PASSTHROUGH: forwards it unchanged
                                                     ▼
                                           Runtime: MCP SERVER
                                                     │ accepts calls from THIS gateway only
                                                     │ re-verifies (7 checks), scopes, audits - as before
```

| Piece | What it does |
|---|---|
| `infra/terraform/agentcore/gateway.tf` | The gateway: `CUSTOM_JWT` inbound, the same pool and `allowed_clients`, and **no** `protocol_type` (Runtime targets can't join an MCP-type gateway). One target, `tools`, of type `http.agentcore_runtime`, pointing at the MCP runtime with `jwt_passthrough`. Its role has **no permissions**: with passthrough the gateway signs nothing and fetches no credential. |
| `mcp.tf`: `allowed_workload_configuration` | The MCP runtime accepts only requests whose identity chain includes this gateway. A front door that can be walked around is decoration: without this, any valid token could call the runtime's own address and skip the gateway. |
| `gatewayTargetUrl` in `src/aws/agentcore-url.ts` | `https://{id}.gateway.bedrock-agentcore.{region}.amazonaws.com/tools/invocations`. It refuses any host that isn't an AgentCore gateway, because this URL is sent the caller's token. |
| `agent-entry.ts` | Prefers `MCP_GATEWAY_URL`/`_TARGET`, falls back to `MCP_RUNTIME_ARN`, then to in-process. The gateway comes first because, once it fronts the runtime, the direct address is refused. |
| `servedBy.toolsRoute` | The answer says **"tools over MCP via Gateway"**. Seeing that on the board proves the front door is in the path. |
| `var.mcp_via_gateway` | Default `true`. `false` removes the gateway and the lock, and the agent calls the runtime directly again. |

**Why "JWT inbound" and not "authenticate only".** `AUTHENTICATE_ONLY` is
SigV4-based and carries no bearer token to pass through. `NONE` would leave
the whole decision to the target. JWT inbound means the gateway makes a
decision of its own before anything reaches our code.

**The caveat, stated rather than hidden.** AWS describes token passthrough as
right for onboarding and recommends on-behalf-of exchange for production,
because the same token is accepted at two hops. That was already true here:
the agent relays the user's token to the MCP runtime. So passthrough adds a
hop that checks the token, not a new place that accepts it. On-behalf-of
exchange is the upgrade once the pool sits behind an IdP that can do it.

**What is still open:**
- **AgentCore Policy (Cedar)** attached to the gateway, as a second
  enforcement of the role rules, outside the agent's environment.
- **Header forwarding.** It isn't documented which headers reach a Runtime
  target. Our server keeps no session state, so a dropped `Mcp-Session-Id`
  would cost speed, not correctness. The first real call confirms it.

### What was built (phase 1)

Phase 1 is in the code. It is hand-rolled, with no MCP SDK. A tools-only
server needs five methods (`initialize`, `ping`, `tools/list`, `tools/call`,
and notifications), and the SDK would have been the first runtime dependency
in `src/`, which the board also bundles.

| Piece | What it does |
|---|---|
| `src/ai/tool-provider.ts` | The seam. `ToolProvider { via, list(), call() }` has two implementations: `inProcessTools` (the tab and the tests) and the MCP client. `runTool` is the one place that does the role check, runs the tool and turns a throw into `ERROR:` text. The in-process provider and the MCP server both call it, so the two routes cannot disagree about what a tool does. |
| `src/ai/agent-core.ts` | `runAgent` takes an optional `callTool`. The loop's own "only what was offered" gate stays, as defence in depth. A provider that throws (MCP server unreachable) becomes a tool result, not the end of the turn. |
| `src/ai/mcp/server.ts` | `handleMcpMessage(msg, principal)`. `initialize` negotiates `2025-06-18` or `2025-03-26`. `tools/list` is `toolSpecsFor(principal, { readOnly: true })`: read tools only, whoever asks. For `tools/call`, a tool that was not listed is JSON-RPC `-32602` (and audited as `refused`), and a failing tool is `isError: true`. Stateless: the principal comes from each request's token. |
| `src/ai/mcp/http.ts` | Streamable HTTP over the same `ResponseSink` as the agent. Order: authenticate, then check `Accept` (406), then `MCP-Protocol-Version` (400), and only then parse. Batches get 400, notifications get 202, requests get 200 JSON, and GET/DELETE get 405. |
| `src/ai/mcp/client.ts` | `createMcpToolProvider({ url, token })`. It does the handshake once and lazily, reuses `Mcp-Session-Id`, and sends `MCP-Protocol-Version`. It reads JSON or SSE responses and retries `-32005` (which arrives as a 200). An `isError` result becomes `ERROR:` text. |
| `src/ai/audit.ts` | One row per call under `TENANT#t#AUDIT`. The row holds `sub`, tool, a **sha256 of the canonical arguments** (never the arguments), outcome, ms, `via` and real time (`wallNow`), with `expiresAt` 90 days out (TTL in `auth/main-table.tf`). `recentAudit` is admin-only and tenant-scoped. An audit write failure is logged loudly and never fails the call. The board reads it through the audit view (below). |
| `src/ai/agent-invocation.ts` | `deps.tools(principal, token)` picks the provider. `servedBy.tools` says `mcp` or `in-process`, and the board shows "tools over MCP". |
| `infra/terraform/agentcore/mcp-entry.ts` | Node, `:8000`, `/mcp` and `/ping`. |
| `infra/terraform/agentcore/agent-entry.ts` | With `MCP_RUNTIME_ARN` set, the tools go over MCP with the caller's token. It keeps one MCP session per user, so follow-ups reuse a warm microVM. |
| `infra/terraform/agentcore/mcp.tf` | The second runtime has `server_protocol = "MCP"` and the same authorizer and header allowlist. Its role can GetItem/Query, and PutItem **only** where `dynamodb:LeadingKeys` matches `TENANT#*#AUDIT`. `use_mcp_tools` (default true) switches the agent over. |
| `scripts/build-agent.mjs` | Builds `agent.js` and `mcp.js` together, so the client and the server are always the same commit. |

The test in `src/ai/mcp/mcp.test.ts` runs the whole route: agent, then MCP
client, then HTTP, then server, then tool. A fake fetch serves `serveMcp`
in-process. The test asserts three things:
- the answer is identical to the in-process run;
- every tool call is audited exactly once;
- each call is audited **as the person who asked**.

`src/ai/mcp/mcp-process.test.ts` does the same across **two processes**. It
starts the local server (below) as a child and runs the agent in the test
process, where nothing has loaded the estate or the runbooks. A single
process can't show whether the agent quietly relies on state the server's
side created. The knowledge base staying empty in the test process while the
answer cites a runbook proves the tools ran in the other process.

To deploy, run `pnpm build:agent`, then `terraform apply` in `auth/` (for the
TTL) and in `agentcore/`. After that, an answer on the board reads
"via AgentCore (…) · tools over MCP". Everything built since is deployed in
one order, set out in `docs/13-deploy-and-verify.md`, with `pnpm smoke:aws`
to prove each step.

### Try it locally: `pnpm mcp`

`scripts/mcp-local.ts` runs the same server (`src/ai/mcp/http.ts`) on
`http://127.0.0.1:8000/mcp`. It uses the in-memory table, filled by the same
code as `pnpm seed:aws` (`scripts/seed-core.ts`), so it answers as the
deployed tools would. It needs no AWS account and no network.

On startup it prints three demo tokens:

| Persona | Tools listed |
|---|---|
| operator, `acme-networks`, Dallas only | 5 network read tools; only Dallas devices |
| admin, `acme-networks`, tenant-wide | the same 5, over the whole estate |
| admin, `hhs-demo` | 13: the network tools, the comms tools, and the three graph tools |

Connect a client:

```bash
# Claude Code - then ask it about the Dallas core switch
claude mcp add --transport http netpulse http://127.0.0.1:8000/mcp \
  --header "Authorization: Bearer <a token it printed>"

# The MCP Inspector - a UI to call each tool by hand
npx @modelcontextprotocol/inspector     # Streamable HTTP, the URL, the Authorization header
```

Things worth trying, because they show the tenant boundary from outside:
- **Out-of-scope data:** as the Dallas operator, call `traceTopology` on
  `dev-cor-aus01-01`. The error lists only Dallas device ids; Austin doesn't
  exist for this caller.
- **A tool you weren't listed:** as the operator, call `listCommsIncidents`.
  You get JSON-RPC `-32602`, and the refusal is audited.
- **A different token:** swap in the HHS token. The same server lists
  different tools.

Every call prints an `audit` line in the server's terminal: tenant, user,
tool, outcome and duration.

The tokens are HS256, signed with the demo secret that is in this repository,
so the script **refuses to bind anything but loopback**. Anyone who can reach
the port could mint an admin token for any tenant. The deployed server
accepts only RS256 tokens from the real pool.

### Reading the trail: the audit view

An audit trail that only exists in DynamoDB isn't one anybody reads. The
board has an **audit** view, next to network and comms, **offered to admins
only**. It names who asked what, which isn't an operator's business about
their colleagues.

| Piece | What it does |
|---|---|
| `auditSnapshot(caller)` in `src/api/board-api.ts` | The view, next to the network and comms views. One implementation, served by the tab and by `GET /audit`. It returns `null` for a non-admin (as comms does for a caller without comms), and the board then offers no tab. |
| `summariseAudit` in `src/ai/audit.ts` | Tallies per outcome and per tool: calls, errors, refusals and **median** time (one 9-second call doesn't become the typical one). It covers the newest 100 rows and says which window, because a total that looked like "all time" couldn't be reconciled with anything. |
| `runToolAs` / `runAudited` in `src/ai/tool-provider.ts` | The outcome is decided where it's known. `refused` means the role check or the tool list said no. Holding only the text, a caller couldn't tell that from a failure, and filing refusals under "error" would hide exactly the rows an access review looks for. The MCP server and the tab both record through `runAudited`. |
| `web/src/AuditBoard.tsx` | Calls newest first: when (real UTC, not the replay's clock), who (you, or the start of the `sub`), tool, outcome, ms, via, and the start of the argument hash. Amber marks `refused` rows only; a tool answering "unknown deviceId" is routine. |

**The source is said out loud.** Over the board API the view reads the MCP
server's rows from DynamoDB: the control. In the tab, with no server, the
tab's own assistant records its calls with `via: 'tab'`, so the view has
something to show offline. That's a **demonstration, never a control**: a
record kept in the caller's own browser is one they could edit. The view
labels it that way, and the rows say `tab`.

To deploy it, run `pnpm build:lambda` (the board API's code), then
`terraform apply` in `auth/`. That adds the `GET /audit` route and the new
Lambda code, plus the TTL if it isn't applied yet.

### Rules to carry into it

- **The tenant is derived from the token at the MCP server.** A `tenantId`
  field in a tool's arguments must never exist.
- **`tools/list` is per caller.** "Tools registered in the tenant's MCP
  config" means the list is computed from the principal, so a network-only
  tenant is never *shown* the comms tools.
- **Audit after the call, hashed arguments, no prompts or responses.** The
  deck asks to log prompts and responses. That is personal data about
  operators and callers, and a decision for HHS rather than a default: it
  would need its own retention and access controls.
- **MCP errors are HTTP 200 with a JSON-RPC error.** A retryable conflict
  (`-32005`, "session operation in progress") must be retried by our client,
  because MCP clients don't retry it on their own.

### Cost and effort

- **Cost:** a second runtime, billed the same way as the agent: CPU only while
  running a tool, memory for the session's life. That's cents at demo volume.
  Audit writes are one small put per tool call.
- **Effort:** roughly the size of the AgentCore agent itself. The tool code
  doesn't change; the work is the provider seam, the server, the audit trail,
  a second runtime and their tests.

---

## Part 3 — The knowledge graph (built)

### What it is for

The deck's centrepiece: "semantic mapping across all 9 data sources" for
**cross-domain reasoning**. Concretely, it's the question no single source
can answer:

> Houston's call quality is degraded. **Why?** Is it the building's network,
> its WAN link, the SBC, the carrier, or a change someone made last night?

Today each domain reasons well **inside itself**:
- the network rules anchor incidents in the topology;
- the comms rules corroborate across services and locate a trunk fault from
  its two ends;
- Helix supplies candidate changes.

Nothing connects **a facility** to **the network that serves it**. That join
is the graph.

### The one prerequisite: a facility on the network side

Comms data is keyed by **facility code** (Entra's `LC=NNNN`, the Webex
location table, Kurmi's department leaf, the Starlink terminal table). The
network estate is keyed by **site** (`dal-01`, …) and is still the Acme-style
generator, even for `hhs-demo`.

The graph needs **every network device to know its facility**. In
production, that's most likely a SolarWinds custom property on each node (for
example `Facility` or a location code), or a tenant table from site to
facility. Which of the two HHS's Orion actually carries has to be confirmed
against the live system, the same way the Kurmi schema had to be. Offline,
the generator gains an `hhs-demo` estate laid out over the facilities the
comms mocks already use (Houston, Lubbock, …).

Without this join, a knowledge graph would be two graphs side by side.

### Nodes and edges

| Node | Key | From |
|---|---|---|
| `Facility` | LC code | comms config (`facilityNames`), Entra placement |
| `Device` | device ID | the estate / SolarWinds |
| `Sbc` | FQDN | Teams Direct Routing, the Helix CI table |
| `Trunk` | SBC + carrier peer | Bandwidth peer table |
| `SatelliteTerminal` | terminal ID | Starlink terminal table |
| `Queue` | Genesys queue ID | Genesys |
| `HelixCi` / `HelixSite` | CI name / site | Helix, through the existing tenant tables |
| `Incident` (network or comms), `Change` | ID | the rules; Helix |

| Edge | Meaning |
|---|---|
| `Device —LOCATED_AT→ Facility` | **the new join** |
| `Device —UPLINKS_TO→ Device` | the existing topology tree |
| `Sbc —RUNS_ON→ Device` | which network box an SBC sits behind |
| `Trunk —TERMINATES_ON→ Sbc` | the carrier's end of the same SBC |
| `SatelliteTerminal —SERVES→ Facility` | a remote site's WAN link |
| `Queue —STAFFED_FROM→ Facility` | where a queue's agents sit, as **counts**, from the workforce split |
| `HelixCi —IS→ Device \| Sbc` | the CI join, through `inventory.peekDevice` and the tenant tables |
| `Incident —AFFECTS→ any node` | time-stamped: opened, resolved |
| `Change —TOUCHES→ HelixCi` | time-stamped: the change window |

**No person nodes.** The workforce roster is never persisted, and the graph
must not become the persisted roster by another name. People appear only as
counts on `Facility` and `Queue`.

*As built*, `Incident` and `Change` are **not** stored in the graph, and two
edges wait for a source. See "Built: phases 1 and 2" below.

### Where it lives: an adjacency list in the existing table

```
PK  TENANT#t#GRAPH#Facility#1455      SK  META                                    {name, counts…}
PK  TENANT#t#GRAPH#Facility#1455      SK  IN#LOCATED_AT#Device#dev-edge-hou01
PK  TENANT#t#GRAPH#Device#dev-edge-hou01  SK  OUT#LOCATED_AT#Facility#1455
PK  TENANT#t#GRAPH#Device#dev-edge-hou01  SK  OUT#UPLINKS_TO#Device#dev-core-hou01
```

Every edge is written **both ways**, so "what's at this facility?" and "where
is this device?" are each **one Query** with a `begins_with` on the sort key.

**Why not Amazon Neptune?** The questions this platform asks are one to three
hops from a known starting node: from an incident's subject, outward. An
adjacency list in DynamoDB answers those in one or two queries. It costs what
it's used, and runs offline through the same in-memory table as everything
else. Neptune earns its keep for deep, unanchored traversals and graph
analytics, and it adds an always-on capacity charge. Revisit it if the
questions change shape, not before.

**It is derived data.** A `buildGraph` step runs after each poll, from the
sources and tenant tables. It's idempotent (edges are overwritten by key) and
rebuildable, like everything else in the main table. Its edges are written
**before** stale ones are deleted, by the same write-first rule the lifecycle
follows.

### The first use: cross-domain candidate causes

This is the deck's "Root Cause Reasoning", done the way this platform treats
Helix: **candidates, never evidence.** They are attached after the rules
decide, and they can never page or suppress anything.

```
correlate(incident):
  start  = the incident's subject node (Facility, Sbc, Trunk, Queue)
  reach  = the network nodes that SERVE it:
             Facility ← LOCATED_AT ← Device        (the building's own network)
             Facility ← SERVES ← SatelliteTerminal (its WAN link)
             Sbc → RUNS_ON → Device → UPLINKS_TO* → …   (UP the chain only)
  window = [incident opened − 15 min, now]
  candidates = incidents / alarms AFFECTING any reached node inside the window
             + changes TOUCHING any reached CI inside the window
  rank by: hop distance (nearer first), time proximity, severity
  attach as "candidate causes" with the path that links them
```

The same directional rule as `recentChanges`: **up the chain, never
sideways.** A sibling access switch shares a parent with the SBC's switch, not
a cause.

What the board would show on Houston's incident:

> **Candidate causes (from the knowledge graph):**
> `dev-edge-hou01` WAN edge — packet loss alarm, opened 6 min before this
> incident · path: Facility 1455 ← LOCATED_AT ← WAN edge
> Change CHG0041 on `dev-core-hou01`, 40 min before · path: … ← UPLINKS_TO ← core

Offline, this is proved the way everything here is: a **planted** scenario.
Houston's call quality degrades while Houston's WAN edge drops packets, and a
test pins that the edge is the top candidate, that a sibling never appears,
and that a node outside the window never appears.

### Agent tools on the graph (read-only, tenant-scoped, MCP-exposed)

| Tool | Returns |
|---|---|
| `whatServes(facility)` | the network devices, WAN links and SBCs behind a facility |
| `explainIncident(incidentId)` | its candidate causes, with paths |
| `neighbours(nodeId, relation?, depth ≤ 2)` | bounded exploration for "Ask Anything" |

Like SPL, **the agent never writes graph queries.** It picks from a fixed
catalogue with typed arguments. A free-form query language handed to a model
is an injection surface, and a depth limit is what keeps a question from
walking the whole estate.

### Phasing

1. **The facility join:** the `hhs-demo` network estate over HHS facilities,
   plus the device → facility mapping and its test. This is the prerequisite,
   and useful on its own: the board can show a facility's network.
2. **`buildGraph` and the adjacency list,** in-memory offline and DynamoDB
   deployed, with rebuild/idempotence tests and the "no person nodes" test.
3. **`correlate` and candidate causes,** with the planted Houston scenario,
   the directional rule and the window, surfaced on the board and in the
   daily brief.
4. **The graph tools,** exposed through MCP (Part 2) so every agent gets them
   with the same audit trail.

### Built: phases 1 and 2

**Phase 1: the facility join.** `hhs-demo` now has its own network estate
(`estateLayout` in `src/data/estate.ts`), laid over the same six facilities
the comms sources use. Houston is `1120` on the network side as it is in
Entra, Webex, Kurmi and the Starlink table. `Site.facility` carries the
code, and `facilityOfDevice` and `devicesAtFacility` (scoped, like every
repository read) are the join.

| Site | Facility | Vendor | Devices |
|---|---|---|---|
| `dal-01` Dallas Regional Office | 1455 | Cisco IOS-XE | 16 |
| `aus-01` Austin Central Office | 0412 | Juniper | 11 |
| `hou-01` Houston Regional Office | 1120 | Cisco IOS-XE | 11 |
| `aus-02` North Austin Campus | 0417 | Juniper | 9 |
| `elp-01` El Paso Field Office | 2031 | Aruba | 7 |
| `lbb-01` Lubbock Field Office | 3308 | Aruba | 6 |

The first two rows are Acme's `dal-01` and `aus-01` unchanged, and that is
load-bearing:
- the SolarWinds fixture resolves HHS's Orion nodes by IP, and IPs follow
  site order;
- the Helix mock's changes name Dallas devices;
- the scenarios pick Dallas's switches and a Juniper access point.

The demo's output changed by exactly one site name. Acme keeps its five
cities.

**Phase 2: the graph.** `src/graph/`:

| File | What it does |
|---|---|
| `model.ts` | Node and relation types. There is no `Person` type, so none can be written. |
| `derive.ts` | `deriveGraph(sources)`: a **pure** function of the estate, the tenant's tables and the per-facility people counts, sorted so the same sources give byte-identical output. |
| `store.ts` | `writeGraph`, `buildGraph`, `graphNode`, `neighbours`: the adjacency list above, every edge stored both ways, one Query per question. |

What it holds for HHS: 80 nodes and 126 edges.
- Every device `LOCATED_AT` its facility, plus the uplink tree.
- Both Starlink terminals `SERVES` their facility; the mobile van isn't in
  the table, so it gets no edge.
- The Bandwidth peers `TERMINATES_ON` their SBC; the legacy PBX peer has no
  SBC, so it gets no edge.
- Helix's CI and site names `IS` our SBCs and facilities.

It's rebuilt by `pnpm seed:aws` (and therefore by `pnpm mcp`) after the
poll. A rebuild is idempotent, and stale items are found through an index
partition rather than a Scan. The order survives a crash anywhere:
1. write the **index** entries first, so no partition can exist that the
   index doesn't know;
2. write everything else;
3. delete what the build didn't write;
4. trim the index **last**. Reads need **tenant** scope, as comms reads do: a scoped view of a
graph that spans sites and facilities needs a facility scope that doesn't
exist yet.

**Deliberate differences from the design above:**
- **Incidents and changes are not graph nodes.** They stay in their own
  stores, and phase 3 joins them at query time. A second, graph-shaped copy
  of every incident would be a consistency bug waiting for its day.
- **`Sbc RUNS_ON Device` is not built.** The SBCs sit in the Austin data
  centre, which isn't a facility and has no site; an invented edge would
  plant a candidate cause that isn't there. It waits for a real source,
  such as the Helix CMDB's relationships or a tenant table.
- **`Queue STAFFED_FROM Facility` is not built.** The workforce split counts
  people per facility and platform, not per queue.
- **Device CIs in Helix** are still joined at query time through the
  inventory aliases (`recentChanges`), as before.

### Built: phase 3, candidate causes

`candidateCauses(principal, incident, network, now)` in
`src/graph/correlate.ts` starts from a comms incident's subject and walks to
the network that serves it:
- **a facility:** its devices (`Facility ← LOCATED_AT ← Device`), one Query;
- **a trunk:** would follow `Sbc RUNS_ON Device`, which has no source yet;
- **a queue:** isn't a place on the network.

On the devices it reaches, it lists the network alarms raised within
**[opened − 15 min, now]**, and the network incidents that are **still
open**, whenever they opened. An outage that began an hour ago and is still
going is the likeliest cause there is; a resolved one is over. It ranks them worst first,
then what paged over what didn't, then nearest in time, and keeps at most
five. A network incident is listed once, not once per alarm inside it.

It gives **four answers**, because "found nothing" must never look like
"couldn't look":
- `found`: the candidates, each with its path;
- `none`: it looked, and says what it searched ("6 network devices at
  Lubbock Field Office, 14:15Z to 14:30Z");
- `no-path`: it says why: a trunk, a queue, a facility with no network
  recorded, or a subject that isn't in the graph (the unmapped Starlink van);
- `unknown`: the graph isn't built, or couldn't be read. A failed read costs
  that incident its candidates, never the comms view or the brief.

**Candidates, never evidence.** It runs after both sets of rules have
decided and changes none of their decisions. A test pins that the planted
Houston WAN alarm is still held back afterwards, that no network incident
was opened for it, and that the comms incident's severity is unchanged.

**The planted pair.** HHS's seventh scenario, `wan-degraded`, exists only
where the estate has a Houston site. Houston's WAN edge reports thousands
of interface errors over SNMP, relayed by SolarWinds. For that, SolarWinds
now reads Orion's `InErrorsThisHour` and `OutErrorsThisHour`, and only on
an up link where they were measured: absent means "not measured", never
zero. Those are running totals for the hour, so they're converted to
errors per 5-minute poll, averaged over the hour so far. Nothing is judged
in the hour's first 10 minutes. Judged raw, severity depended on the
minute: a steady trickle read `ok` at :02 and `critical` at :34. It has one witness, so it's held back and pages
nobody, exactly like the lone port flap. Beside Houston's call-quality
incident, it becomes the top candidate:

```
Call quality degraded at LC=1120
  => wan-hou01-02 (wan-edge): interface errors, critical, held back - one witness
     path: Houston Regional (1120) <- LOCATED_AT <- wan-hou01-02 (wan-edge)
```

**Where it shows:**
- **Comms board:** under each incident, in the Helix colour, never amber.
- **`CommsSnapshot.causes`:** served the same in the tab and by `GET /comms`.
- **The demo:** `pnpm start --only=graph`, section 13.

- **The brief the board builds:** the top candidate, in plain words, on
  the incident's line ("On the building's own network: interface errors on
  its wan edge (wan-hou01-02), reported by the device alone - a candidate,
  not a confirmed cause"). The board computes the causes once and hands the
  same ones to the brief, so the two can't disagree.

**Not yet:**
- **The scheduled brief** (`pnpm start --only=brief`, and in production an
  EventBridge schedule) reads the stored decisions and names no network
  candidate unless its caller supplies causes. It doesn't guess.
- **Helix changes as candidates:** they already reach the incident through
  Helix context, so listing them again from the graph would show each
  change twice.

### Built: phase 4, the graph tools

`src/ai/graph-tools.ts` adds three read-only tools, offered with the comms
tools and to the same callers: a tenant with facilities, and a tenant-wide
principal. They go through `runTool` like every other tool, so behind the
MCP server they are scoped and audited with no extra code.

| Tool | Takes | Returns |
|---|---|---|
| `whatServes` | a facility code **or name** ("Houston") | the building's devices, its satellite WAN, Helix's names for it, and a people **count** |
| `explainIncident` | an incident id, or nothing for every open one | candidate causes with paths, each line saying "CANDIDATE (not evidence)" and whether it paged anyone |
| `graphNeighbours` | `Type#id` or a facility name, an optional relation, a depth | at most 2 hops and 40 nodes; every line past the first hop names the node it hangs off |

Details that matter:
- **A fixed catalogue with typed arguments** (the SPL rule). The agent never
  writes a graph query, and the depth and node caps are enforced by the
  tool, whatever it's asked.
- **Names as well as codes.** A model is told "Houston", not "1120". The
  longest name wins, so "North Austin" isn't Austin, and a code the tenant
  doesn't have isn't a facility.
- **Unmapped is said as unmapped.** `whatServes` says no source maps SBCs to
  buildings ("not 'none exist'"), and a wrong incident id returns the open
  ones, so the model can correct itself.

With these, an HHS admin is offered 13 read tools. The agent's step budget
grows with the tools offered, so the offline model still reaches an answer.

---

## Decisions these designs need from you

| Decision | Why it's yours |
|---|---|
| **The facility source** on the network side: a SolarWinds custom property, or a tenant table | It depends on what HHS's Orion actually carries. |
| **Audit retention**, and whether prompts and responses are logged | It's personal data with its own retention and access obligations. |
| **Token passthrough or on-behalf-of exchange** at the Gateway | Passthrough is built and keeps the user's identity end to end. AWS recommends on-behalf-of exchange for production, which needs an identity provider that supports it (Cognito doesn't). That changes the identity architecture. |
| **Where the SBCs sit on the network** (`Sbc RUNS_ON Device`) | No source carries it: the Helix CMDB's relationships or a tenant table would. Without it, candidate causes stop at the SBC. |
| **One agent with tools, or five purpose-built agents** | The deck names five; the tool-based agent already covers the ground. Separate agents mean separate prompts, budgets and costs. |

## Where to look

| File | What |
|---|---|
| `src/ai/agent-core.ts` | The loop: context, budget, dispatch, guardrails, trace |
| `src/ai/agent-invocation.ts` | One AgentCore invocation: token → principal → history → loop |
| `src/aws/bedrock.ts`, `src/aws/bedrock.sdk.ts` | The model registry: scripted and Claude |
| `src/ai/tools.ts`, `comms-tools.ts`, `itsm-tools.ts` | The tools, and `toolSpecsFor` |
| `src/ai/guardrails.ts`, `knowledge-base.ts`, `bedrock-rag.ts` | Guardrails and retrieval |
| `docs/11-agentcore.md` | How the agent is hosted on AgentCore |
