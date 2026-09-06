# Enterprise AI Fabric

> **Scope of this document.** This is an architecture write-up of the platform,
> expressed in the AWS serverless / Bedrock vocabulary used by the reference
> implementation in this repository. Where a detail is an illustrative sizing
> assumption rather than a fact, it is marked *(assumption)*. Replace those, and
> any vendor or service choice that differs from what was actually built, before
> using this anywhere it will be read as a record.

An enterprise AI gateway and governance platform. It sits between every internal
consumer of AI and every model, tool and data source they might reach, and makes
that traffic **governed, observable and auditable** without making it slow.

The one-line framing: *a service mesh for AI traffic — identity, policy,
routing, retries and telemetry factored out of every application that would
otherwise reimplement them badly.*

---

## The problem it solves

Without a fabric, every team that wants to ship an AI feature independently
solves the same eight problems, and gets several of them wrong:

| Problem | What happens when each team solves it alone |
|---|---|
| Model access | Credentials scattered across teams; no way to answer "who can call what" |
| Cost attribution | One shared bill, no idea which product drives it |
| Policy | Guardrails expressed as prompt instructions an attacker can argue with |
| Tool authorisation | Agents run with the *application's* permissions, not the *user's* |
| Auditability | No record of what was asked, what was returned, or what the agent did |
| Provider failover | Hard-coded to one model; an outage is a product outage |
| Evaluation | No regression suite, so a model upgrade is a leap of faith |
| Data isolation | Retrieval that can cross business-unit boundaries |

The fabric's value is that those become **platform properties** rather than
per-application discipline.

---

## Architecture

```
   Internal apps ─┐   Agents ─┐   Notebooks ─┐   CI/CD ─┐
                  │           │              │          │
                  └───────────┴──────┬───────┴──────────┘
                                     │  OIDC / SAML (enterprise SSO)
                          ┌──────────▼───────────┐
                          │   Identity & Policy  │
                          │  • verify token      │
                          │  • resolve Principal │  ← who is calling, as whom,
                          │  • BU + role claims  │    with what authority
                          └──────────┬───────────┘
                                     │
   ┌─────────────────────────────────▼──────────────────────────────────┐
   │                          AI FABRIC (control plane)                 │
   │                                                                    │
   │  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────────────┐   │
   │  │  Policy  │  │  Routing  │  │  Budget  │  │  Tool Registry   │   │
   │  │  engine  │  │  + fallb. │  │  + quota │  │  + authorisation │   │
   │  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └────────┬─────────┘   │
   └───────┼──────────────┼─────────────┼─────────────────┼─────────────┘
           │              │             │                 │
           ▼              ▼             ▼                 ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │                          data plane                               │
   │   Bedrock (Claude, Titan)   │   internal models   │   MCP tools   │
   │   Knowledge Bases (RAG)     │   3rd-party APIs    │   databases   │
   └───────────────────────────────────────────────────────────────────┘
           │
           │  every request and response, structured
           ▼
   ┌───────────────┐   ┌──────────────┐   ┌─────────────────────────┐
   │  EventBridge  │──▶│  Firehose    │──▶│ S3 (immutable audit)    │
   │  audit stream │   │              │   │ + Athena / QuickSight   │
   └───────┬───────┘   └──────────────┘   └─────────────────────────┘
           │
           ├──▶ cost attribution (per BU, per product, per model)
           ├──▶ policy violations → security review queue
           └──▶ anomaly detection → on-call
```

---

## How the reference implementation maps onto this

The repo in this directory is a small working model of the same patterns.

| Reference file | Fabric equivalent |
|---|---|
| `src/ai/agent-core.ts` | The hosted agent loop. Iteration caps, tool dispatch, trace emission — done once, for everyone. |
| `src/ai/guardrails.ts` | The policy engine. Input filters, PII handling, output grounding, **tool authorisation**. |
| `src/ai/tools.ts` | The tool registry. Schema + executor + who may call it. |
| `src/integrations/connector.ts` | **Model routing.** One interface, many providers, with retry, jitter and a circuit breaker per provider. |
| `src/integrations/registry.ts` | The provider catalogue — adding a model is a registration, not an architecture change. |
| `src/platform/tenancy.ts` | Business-unit isolation. `Principal` carries the BU; nothing accepts a bare id. |
| `src/ai/knowledge-base.ts` | Per-BU RAG with the metadata filter that keeps corpora apart. |
| `src/aws/eventbridge.ts` | The audit fan-out — many consumers of one event stream, none aware of the others. |
| `src/platform/logger.ts` | Structured, correlated telemetry on every hop. |

---

## The five design decisions worth defending

### 1. The gateway is a *broker*, not a proxy

A proxy forwards bytes. This resolves an identity, evaluates policy, chooses a
model, enforces a budget, executes tools under the caller's authority, and emits
an audit record. Applications get an SDK that looks like a model client and get
governance for free — which is the only way adoption happens. A governance layer
teams have to opt into is a governance layer teams route around.

### 2. An agent acts with the **caller's** permissions, never the platform's

This is the load-bearing decision of the whole system.

An agent whose tools can move money, change infrastructure or read customer data
must not have more authority than the human who invoked it. Get this wrong and
prompt injection stops being a content problem and becomes **privilege
escalation**: hostile text in a retrieved document persuades the model to call a
write tool, and because the *service* is permitted to, it happens.

So authorisation is checked in the tool, against the caller's roles, not
requested in the prompt:

```
canUseTool(principal, 'issueRefund')  →  denied for a viewer,
                                          regardless of what the model was told
```

The worst case becomes a refused tool call and an audit record. That is a
containable incident; the alternative is not.

→ modelled in `src/ai/guardrails.ts`, with the test that proves it in
`src/pipeline/pipeline.test.ts`

### 3. Policy is code and configuration, not prompt text

Anything expressible only as an instruction is something an attacker can argue
with. The layers, in order of trustworthiness:

| Layer | Mechanism | Bypassable by prompt? |
|---|---|---|
| Tool authorisation | Code, against `Principal` roles | No |
| IAM | Scoped model/KB/tool ARNs on the execution role | No |
| Retrieval filter | Metadata filter pinned to the BU | No |
| Bedrock Guardrails | Managed input/output policy | No |
| System prompt | Instructions | **Yes** |

System prompts shape behaviour. They do not enforce anything. Treat them as UX,
not as security.

### 4. Multi-provider from day one, because the reason is not redundancy

The obvious argument is outage resilience. The stronger ones are **negotiating
position**, **cost/quality routing** (cheap model for classification, capable
model for reasoning), and **not being unable to adopt a better model** because
three hundred call sites hard-coded a client.

The connector pattern from the reference implementation is exactly this: eight
vendors with eight auth schemes and eight payload shapes, normalised at the edge
into one canonical type so nothing downstream knows or cares. Swap "vendor" for
"model provider" and it is the same design.

Per-provider circuit breakers matter here for a reason specific to AI: when a
provider degrades, you are burning wall-clock *and tokens* collecting timeouts,
and adding load to someone else's incident.

### 5. The audit trail is the product

For a governance platform, the log is not observability — it is the deliverable.
Every interaction emits a structured record:

```
who (principal, BU, on whose behalf) · what (prompt hash, not prompt text by
default) · which model and version · which tools, with what arguments and
outcome · which documents were retrieved · policy decisions and why · tokens
in/out and cost · latency per hop · correlation id spanning the whole chain
```

Two deliberate choices in there:

- **Hash prompts by default, store content only where policy permits.** A
  regulated BU may forbid content retention entirely; the audit record must
  still exist and still be useful for cost and access questions.
- **Record policy decisions, including allows.** "Nothing was blocked" is not
  evidence that the policy ran.

---

## Request flow

```
1. App calls the fabric SDK with a user's token and a request.

2. IDENTITY. Verify the JWT (signature, issuer, audience, expiry, token_use,
   algorithm). Resolve a Principal: subject, business unit, roles, and — if the
   call is on a user's behalf — the delegation chain.

3. ADMISSION. Budget and quota for this BU and this product. A runaway agent
   loop is a cost incident; the cap belongs here, before the first token.

4. INPUT POLICY. Guardrails: denied topics, prompt-attack detection, PII
   handling. Decision recorded either way.

5. ROUTE. Pick a model from the request's class-of-service, the BU's allow-list,
   and current provider health. Emit which one and why.

6. EXECUTE. If tools are in play, run the agent loop:
      invoke → stop_reason 'tool_use'? → authorise against the CALLER →
      execute → append tool_result → repeat, under a hard iteration cap.
   Retrieval, if any, is filtered to the BU's corpus.

7. OUTPUT POLICY. PII redaction and contextual grounding — block answers the
   retrieved sources do not support.

8. AUDIT. One structured event to EventBridge. Consumers: cost attribution,
   the security review queue, anomaly detection, and the analytics archive.
   None of them know about each other; adding a fourth is a rule.
```

Steps 2–5 are on the critical path of every call, so they are the ones to keep
under a few tens of milliseconds — policy evaluation cached, provider health
kept in memory and refreshed out of band, identity verified against a cached
JWKS rather than a network round trip.

---

## Cost control

Cost is a first-class platform concern here, not an afterthought, because the
failure mode is silent: an agent loop that retries tools costs money at machine
speed and nothing alerts until the bill arrives.

| Lever | Where it lives |
|---|---|
| Hard iteration caps on agent loops | The loop itself, non-negotiable |
| Per-BU / per-product budgets and quotas | Admission control, before token one |
| Prompt caching | Stable prefix first, volatile content last — verified by watching `cache_read_input_tokens`, not assumed |
| Class-of-service routing | Cheap model for extraction and classification; capable model for reasoning |
| Effort / verbosity tuning | Per route, measured on real traffic rather than set globally |
| Semantic caching | Identical or near-identical questions, where staleness is acceptable |
| Token attribution from `response.usage` | Not estimated — measured, and tagged for cost allocation |

The single most useful metric is **cost per completed task**, not cost per
request. A cheaper model that needs three more turns to finish the job is not
cheaper.

---

## Evaluation

A gateway that cannot tell whether a change made things worse is a gateway
nobody will let you upgrade.

- A **regression suite per high-traffic route**, built from real (de-identified)
  traffic rather than synthetic prompts.
- **Model upgrades are a hill-climb, not a swap.** Run the candidate against the
  suite, compare on quality *and* cost per completed task, and keep a
  train/validation split so you are not tuning against your own scoreboard.
- **Prompt changes go through the same gate as code**, because they behave like
  code and fail like configuration.

---

## Open questions worth flagging

Things a reviewer will ask, and which are genuinely unsettled in most
organisations at this stage:

- **Delegation depth.** When an agent calls a tool that invokes another agent,
  how far does the caller's authority propagate, and where is the chain
  recorded? Unbounded delegation is a hole; no delegation makes composition
  impossible.
- **Content retention vs auditability.** Regulated units may forbid storing
  prompt content. The audit record must remain useful without it.
- **Where the loop runs.** A managed agent runtime removes a lot of undifferentiated
  work; hosting it yourself keeps the tool sandbox and the data path inside your
  own boundary. This is a per-workload decision, not a platform-wide one.
- **Tool sprawl.** A registry with 400 tools makes model tool-selection worse,
  not better. Scoping tool sets per agent profile is a product problem before it
  is a technical one.
