# Bedrock: RAG, agents and guardrails

## The three Bedrock APIs

Easy to confuse, so be precise:

| Client | Purpose |
|---|---|
| `bedrock-runtime` | Talk to a **model** — `InvokeModel`, `Converse` |
| `bedrock-agent-runtime` | Talk to a **knowledge base** — `Retrieve`, `RetrieveAndGenerate` |
| `bedrock-agent` | **Manage** them — `CreateKnowledgeBase`, `StartIngestionJob` |

Also worth knowing: on Bedrock, Claude model IDs carry an `anthropic.` prefix
(`anthropic.claude-opus-5`), which the first-party Anthropic API IDs do not.
Either use the Bedrock client class from the Anthropic SDK:

```ts
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
const client = new AnthropicBedrockMantle({ awsRegion: 'us-east-1' });
```

…or call `InvokeModel` directly with the Messages API JSON as the body — in
which case remember `"anthropic_version": "bedrock-2023-05-31"`, which is
required and is *not* the model ID.

---

## RAG in four steps

**Retrieval-augmented generation** = give the model the right documents at
question time instead of hoping it memorised them.

```
1. INGEST   chunk documents → embed each chunk → store vectors + metadata
2. RETRIEVE embed the question → find the nearest chunks
3. AUGMENT  build a prompt containing those chunks
4. GENERATE call the model, then verify the answer is grounded in them
```

Bedrock Knowledge Bases manage steps 1 and 2 for you: point one at an S3 bucket,
pick an embedding model and a vector store, and it handles chunking, embedding,
indexing and re-indexing.

### Chunking is the biggest quality lever

- **Too small** → a chunk says "escalate to the carrier NOC" with no clue what
  the symptom was. The model cites it and sounds unhinged.
- **Too large** → one chunk covers three unrelated procedures, so its embedding
  is an average of all three and matches nothing well.

Bedrock offers `FIXED_SIZE`, `SEMANTIC` and `HIERARCHICAL`. For structured
documents like runbooks, **split on headings** — the author already told you
where the semantic boundaries are. Free prose needs fixed-size chunks with
overlap so a sentence spanning a boundary survives intact.

One trick worth stealing: **prepend the document and section titles into the
chunk text** before embedding. Then a chunk about "escalate after 15 minutes"
still matches a query about packet loss, because the topic is inside the
embedded text.
→ `chunkMarkdown` in `src/ai/knowledge-base.ts`

### Hybrid search

`overrideSearchType: 'HYBRID'` fuses two different things:

- **Semantic** (embeddings) knows "choppy calls" relates to "packet loss", but
  is bad at exact tokens — a model number, an error code, "SFP".
- **Lexical** (BM25) is exactly the opposite.

You want both. The weighting is tunable and should be tuned against a real eval
set, not a hunch — it is the single biggest retrieval-quality dial after
chunking.

### The tenant filter is not optional

```ts
retrievalConfiguration: {
  vectorSearchConfiguration: {
    numberOfResults: 4,
    overrideSearchType: 'HYBRID',
    filter: { equals: { key: 'tenantId', value: principal.tenantId } },
  },
}
```

A knowledge base is shared infrastructure. Without that filter, tenant A's
question retrieves tenant B's documents. It is the RAG equivalent of a missing
`WHERE` clause, and it is the multi-tenancy question people forget to ask about
AI systems.

### `Retrieve` vs `RetrieveAndGenerate`

`RetrieveAndGenerate` is one call: Bedrock retrieves, builds the prompt,
generates, and returns citations. Cheap, fast, predictable — use it for Q&A.

`Retrieve` + your own model call is what you want when you need to mix retrieved
text with **live data** (telemetry, in this case), control the prompt, or feed
an agent. → `src/ai/bedrock-rag.ts`

### Prompt structure for RAG

```
Answer using ONLY the sources below. Cite them as [1], [2].
If the sources do not contain the answer, say so plainly.

<sources>
[1] wan-packet-loss.md — Triage
…
</sources>

Question: <the user's question>
```

Three deliberate choices: number the sources so citation is possible; put the
question **last**, so the instruction is the most recent thing the model reads;
and state explicitly what to do when the context is insufficient, or the model
fills the gap from its own priors.

---

## Agents

### The loop

```
      user question
            │
            ▼
   ┌─▶ invoke model with (system, messages, tools)
   │        │
   │        ├─ stop_reason 'end_turn'  → done, return the text
   │        │
   │        └─ stop_reason 'tool_use'  → execute the tool(s)
   │                    │
   └──────── append tool_result blocks to messages
```

That is the entire idea. **AWS Bedrock AgentCore** is the managed runtime that
hosts this loop for you, and adds: an isolated microVM per session, short- and
long-term memory, identity delegation, a Gateway that turns existing APIs into
tools, and observability. But the crank it turns is exactly the above.

→ `src/ai/agent-core.ts` implements it in ~90 lines against the real Messages
API contract.

### Four things that make it production-grade

1. **A hard iteration cap.** A model that keeps calling tools will otherwise
   spend your money until the Lambda times out.
2. **Per-tool authorisation, against the caller.** See below.
3. **Errors returned as `tool_result` content**, not thrown. `ERROR: unknown
   siteId "xyz-99". Valid ids: dal-01, aus-01, …` lets the model fix its own
   call. A thrown exception just kills the turn.
4. **A trace.** For debugging, and as a product feature — users trust an agent
   far more when they can see which tools it called.

### Two protocol details that bite

- **Append the assistant turn verbatim**, `tool_use` blocks included. Dropping
  them breaks the `tool_use_id` linkage on the next request.
- **All `tool_result` blocks for one turn go in ONE user message.** Splitting
  them across messages silently teaches the model to stop making parallel calls.

### Writing a good tool

The schema **is** a prompt — it is the only thing the model sees.

```ts
{
  name: 'searchRunbooks',
  description:
    'Search the operational runbook library for triage steps, resolution ' +
    'procedures and escalation thresholds. Use this whenever the user asks ' +
    'how to fix, triage, or escalate a problem, or why something is happening. ' +
    'Always call this before recommending an action.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: '…' } },
    required: ['query'],
  },
}
```

Three rules:

1. Describe **when** to use it, not just what it does. "Search runbooks" is
   weak; "use this when the user asks how to fix a problem" is a trigger
   condition the model can act on.
2. Make bad calls impossible **in the schema** — enums, `required`, bounds. A
   constraint in the schema beats a plea in the prompt.
3. Return errors as data.

→ `src/ai/tools.ts`

---

## Security: the rule that matters

> **An agent acts with the permissions of the person who invoked it, never with
> the permissions of the Lambda it happens to run in.**

Get this wrong and prompt injection becomes **privilege escalation**: a hostile
string in a vendor payload persuades the model to call `openIncident`, and
because the Lambda's execution role permits it, it happens.

Check authorisation **in the tool**, against the caller's roles:

```ts
const verdict = canUseTool(principal, 'openIncident');
if (!verdict.allowed) return 'ERROR: ' + verdict.reason;
```

The worst case is then a refused tool call. Also give viewers a smaller tool set
than operators — least privilege applies to agents too.

→ `src/ai/guardrails.ts`, and the test in `src/pipeline/pipeline.test.ts` that
proves a viewer is refused even when the write tool is deliberately offered.

---

## Bedrock Guardrails

A managed policy layer attached by ID to a model invocation, applying to **both**
input and output:

| Policy | Covers |
|---|---|
| Denied topics | Defined in natural language |
| Content filters | Hate, violence, sexual, **prompt attacks**; per-category HIGH/MEDIUM/LOW |
| Word filters | Profanity, competitor names |
| PII | ~30 built-in types plus regex; `BLOCK` or `ANONYMIZE` |
| Contextual grounding | Scores the answer against retrieved context and blocks below a threshold |

**Contextual grounding is the closest thing to a managed hallucination check**,
and it is essential when an agent's output drives operational decisions.

Prefer `ANONYMIZE` over `BLOCK` for things like email and IP: an operator
legitimately needs to discuss a device by IP, so blocking makes the assistant
useless, while masking in the stored transcript keeps it safe.

→ `infra/terraform/modules/s3-bedrock-kb/main.tf`, `src/ai/guardrails.ts`

---

## Where the AI sits in this product

Notice what the AI is **not** doing: it does not decide whether an incident is
real. That is deterministic rules in `src/pipeline/steps.ts`, because detection
must be testable and explainable at 3am, and because a rule that fires the same
way every time is auditable in a way a model is not.

The model's job starts **after** the rules have decided something is real:
explain it, ground the explanation in a runbook, and cite the evidence. That
division — deterministic decisions, AI explanations — is the design point worth
defending.
