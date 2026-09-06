"""
===============================================================================
Bedrock RAG + agent loop, as a Python Lambda
===============================================================================
The JD lists Python first, and in practice AWS AI/ML Lambdas are usually
Python. This is the same design as src/ai/ in TypeScript, written the way you
would actually deploy it: boto3, real API calls, no local fakes.

READ-ONLY REFERENCE. It needs boto3 and real AWS credentials to run; the
TypeScript demo is the part that executes offline.

Three Bedrock APIs are used here and they are easy to confuse:

  bedrock-runtime        InvokeModel / Converse - talk to a model
  bedrock-agent-runtime  Retrieve / RetrieveAndGenerate - talk to a knowledge base
  bedrock-agent          CreateKnowledgeBase / StartIngestionJob - manage them

Note also that Bedrock model IDs carry an `anthropic.` prefix, which the
first-party Anthropic API IDs do not: `anthropic.claude-opus-5`.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Callable

import boto3
from botocore.config import Config

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# -----------------------------------------------------------------------------
# Clients are created at MODULE scope, not inside the handler.
# -----------------------------------------------------------------------------
# A Lambda container is reused across invocations. Module-scope clients are
# constructed once per cold start and then reused for the life of the container,
# which saves the TLS handshake and credential resolution on every warm call.
# Creating a boto3 client inside the handler is one of the most common and most
# expensive Lambda mistakes.

_BOTO_CONFIG = Config(
    retries={
        # "adaptive" adds client-side rate limiting on top of retries, which is
        # what you want against Bedrock: throttling there is common and a naive
        # retry storm makes it worse.
        "max_attempts": 4,
        "mode": "adaptive",
    },
    # Bedrock calls with a large context can genuinely take a while. The default
    # 60s read timeout will cut off a long generation mid-stream.
    read_timeout=300,
    connect_timeout=10,
)

REGION = os.environ.get("AWS_REGION", "us-east-1")

bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION, config=_BOTO_CONFIG)
bedrock_agent_runtime = boto3.client("bedrock-agent-runtime", region_name=REGION, config=_BOTO_CONFIG)
dynamodb = boto3.resource("dynamodb", region_name=REGION)

TABLE = dynamodb.Table(os.environ["TABLE_NAME"])
TEXT_MODEL_ID = os.environ.get("BEDROCK_TEXT_MODEL_ID", "anthropic.claude-opus-5")
KNOWLEDGE_BASE_ID = os.environ["BEDROCK_KNOWLEDGE_BASE_ID"]
GUARDRAIL_ID = os.environ.get("BEDROCK_GUARDRAIL_ID")


# =============================================================================
# Retrieval
# =============================================================================


def retrieve(question: str, tenant_id: str, top_k: int = 4) -> list[dict[str, Any]]:
    """Query the Bedrock Knowledge Base, scoped to one tenant.

    The `filter` is the most important argument on this page. A knowledge base
    is shared infrastructure; without a metadata filter, tenant A's question
    retrieves tenant B's documents. It is the RAG equivalent of a missing WHERE
    clause, and it is the multi-tenancy question people forget to ask about AI.
    """
    response = bedrock_agent_runtime.retrieve(
        knowledgeBaseId=KNOWLEDGE_BASE_ID,
        retrievalQuery={"text": question},
        retrievalConfiguration={
            "vectorSearchConfiguration": {
                "numberOfResults": top_k,
                # HYBRID = semantic (embeddings) + lexical (BM25). Embeddings
                # know that "choppy calls" relates to "packet loss"; BM25 is
                # what actually matches an exact token like a model number or
                # "SFP". You want both.
                "overrideSearchType": "HYBRID",
                "filter": {"equals": {"key": "tenantId", "value": tenant_id}},
            }
        },
    )

    return [
        {
            "text": r["content"]["text"],
            "score": r["score"],
            "source": r["location"]["s3Location"]["uri"],
        }
        for r in response["retrievalResults"]
    ]


def ask_with_rag(question: str, tenant_id: str) -> dict[str, Any]:
    """Single-shot RAG: retrieve, then generate. No tools, no loop.

    The managed one-call alternative is `retrieve_and_generate`, which does the
    retrieval, prompt assembly, generation and citation extraction server-side:

        bedrock_agent_runtime.retrieve_and_generate(
            input={"text": question},
            retrieveAndGenerateConfiguration={
                "type": "KNOWLEDGE_BASE",
                "knowledgeBaseConfiguration": {
                    "knowledgeBaseId": KNOWLEDGE_BASE_ID,
                    "modelArn": TEXT_MODEL_ID,
                },
            },
        )

    Use that for plain Q&A. Do it by hand, as below, when you need to blend
    retrieved text with live telemetry or control the prompt yourself.
    """
    chunks = retrieve(question, tenant_id)
    if not chunks:
        return {"answer": "No runbook covers that. I will not guess a procedure.", "citations": []}

    # Structure matters more than people expect:
    #  - number the sources so the model can cite them by index;
    #  - put the question LAST, after the context, so the instruction is the
    #    most recent thing the model reads;
    #  - state explicitly what to do when the context is insufficient, or the
    #    model will fill the gap from its own priors.
    context = "\n\n".join(
        f"[{i + 1}] {c['source']}\n{c['text']}" for i, c in enumerate(chunks)
    )

    prompt = (
        "Answer using ONLY the sources below. Cite them as [1], [2].\n"
        "If the sources do not contain the answer, say so plainly.\n\n"
        f"<sources>\n{context}\n</sources>\n\n"
        f"Question: {question}"
    )

    response = _invoke(
        system="You are a precise operations assistant. Cite your sources.",
        messages=[{"role": "user", "content": [{"type": "text", "text": prompt}]}],
    )

    answer = "".join(b["text"] for b in response["content"] if b["type"] == "text")
    return {
        "answer": answer,
        "citations": [{"source": c["source"], "score": c["score"]} for c in chunks],
    }


# =============================================================================
# The agent loop - what AgentCore runs for you
# =============================================================================


@dataclass
class Tool:
    """A JSON Schema plus a function.

    The schema is a PROMPT: it is the only thing the model sees, and it decides
    whether the tool gets called and with what arguments. Describe WHEN to use
    the tool, not just what it does, and encode constraints in the schema
    (enums, required, bounds) rather than pleading for them in the prompt.
    """

    name: str
    description: str
    input_schema: dict[str, Any]
    fn: Callable[[dict[str, Any], "Principal"], str]

    def spec(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


@dataclass
class Principal:
    """The verified caller. The agent acts with THESE permissions."""

    sub: str
    tenant_id: str
    roles: list[str] = field(default_factory=lambda: ["viewer"])

    @property
    def can_write(self) -> bool:
        return any(r in ("admin", "operator") for r in self.roles)


def run_agent(
    question: str,
    principal: Principal,
    tools: list[Tool],
    max_iterations: int = 6,
) -> dict[str, Any]:
    """The agent loop.

        invoke model -> stop_reason 'tool_use'? -> run tool -> append result -> repeat
                     -> stop_reason 'end_turn'? -> done

    That is all an agent is. Bedrock AgentCore hosts this loop for you, plus
    session isolation, memory, identity delegation and observability - but the
    crank it turns is exactly the above.

    Four things make it production-grade rather than a toy, all present here:
      1. a hard iteration cap, or a looping model spends your money until the
         Lambda times out;
      2. per-tool authorisation against the CALLER, on every call;
      3. errors returned as tool_result content so the model can self-correct;
      4. a trace, for debugging and for showing the user why.
    """
    by_name = {t.name: t for t in tools}
    messages: list[dict[str, Any]] = [
        {"role": "user", "content": [{"type": "text", "text": question}]}
    ]
    trace: list[dict[str, Any]] = []

    for _ in range(max_iterations):
        response = _invoke(
            system=SYSTEM_PROMPT,
            messages=messages,
            tools=[t.spec() for t in tools],
        )

        # Append the assistant turn VERBATIM, tool_use blocks included. Dropping
        # them breaks the tool_use_id linkage on the next request.
        messages.append({"role": "assistant", "content": response["content"]})

        if response.get("stop_reason") != "tool_use":
            answer = "".join(b["text"] for b in response["content"] if b["type"] == "text")
            return {"answer": answer, "trace": trace, "stopped": "end_turn"}

        # The model may emit several tool_use blocks at once. Every result must
        # come back in ONE user message - splitting them across messages teaches
        # the model to stop making parallel calls.
        results = []
        for block in response["content"]:
            if block["type"] != "tool_use":
                continue

            content, is_error = _execute_tool(by_name, block["name"], block["input"], principal)
            trace.append({"tool": block["name"], "input": block["input"], "error": is_error})

            results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block["id"],
                    "content": content,
                    "is_error": is_error,
                }
            )

        messages.append({"role": "user", "content": results})

    return {"answer": "Could not conclude within the step budget.", "trace": trace, "stopped": "max_iterations"}


def _execute_tool(
    registry: dict[str, Tool],
    name: str,
    args: dict[str, Any],
    principal: Principal,
) -> tuple[str, bool]:
    """Dispatch with authorisation and error containment."""
    tool = registry.get(name)
    if tool is None:
        return f'ERROR: no such tool "{name}".', True

    # THE rule for agentic systems: an agent acts with the permissions of the
    # person who invoked it, never with the permissions of the Lambda it runs
    # in. Get this wrong and prompt injection becomes privilege escalation.
    if name in WRITE_TOOLS and not principal.can_write:
        return f"ERROR: role {principal.roles} may not invoke {name}.", True

    try:
        return tool.fn(args, principal), False
    except Exception as exc:  # noqa: BLE001 - deliberate: hand the model the problem
        logger.warning("tool %s failed: %s", name, exc)
        return f"ERROR: {exc}", True


WRITE_TOOLS = {"openIncident", "acknowledgeIncident", "dispatchEngineer"}

SYSTEM_PROMPT = """You are Meridian, an operations assistant for enterprise
network and contact-centre teams.

Rules:
- Ground every recommendation in a runbook you retrieved. If no runbook covers
  the situation, say so rather than improvising a procedure.
- Check telemetry before explaining a cause. Do not speculate from the question.
- Before claiming a problem is regional, verify it with a spatial query.
- Cite the site ids and providers your conclusion rests on.
- Never claim to have taken an action you did not take via a tool."""


# =============================================================================
# The model call
# =============================================================================


def _invoke(
    system: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    max_tokens: int = 16000,
) -> dict[str, Any]:
    """Call Claude on Bedrock via InvokeModel.

    Two ways to do this, and it is worth knowing both:

      1. THE ANTHROPIC BEDROCK SDK (preferred for Claude-specific work):

             from anthropic import AnthropicBedrockMantle
             client = AnthropicBedrockMantle(aws_region="us-east-1")
             client.messages.create(model="anthropic.claude-opus-5", ...)

         Typed, and it tracks the Messages API surface exactly.

      2. RAW boto3 InvokeModel, below. No extra dependency in the Lambda
         package, and the body is just the Messages API JSON. Note the
         `anthropic_version` field, which is required and is NOT the model id.
    """
    body: dict[str, Any] = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages,
    }
    if tools:
        body["tools"] = tools

    kwargs: dict[str, Any] = {
        "modelId": TEXT_MODEL_ID,
        "body": json.dumps(body),
        "contentType": "application/json",
    }

    # Guardrails apply to BOTH input and output, and are attached per call.
    # Keeping them here rather than in the prompt means a jailbreak that talks
    # the model round still does not get past the platform check.
    if GUARDRAIL_ID:
        kwargs["guardrailIdentifier"] = GUARDRAIL_ID
        kwargs["guardrailVersion"] = "DRAFT"

    response = bedrock_runtime.invoke_model(**kwargs)
    payload = json.loads(response["body"].read())

    # Log usage, not content. Content may contain customer data; token counts
    # are what you need to see the cost of a feature in CloudWatch.
    usage = payload.get("usage", {})
    logger.info(
        json.dumps(
            {
                "msg": "bedrock_invoke",
                "model": TEXT_MODEL_ID,
                "stop_reason": payload.get("stop_reason"),
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
            }
        )
    )
    return payload


# =============================================================================
# Lambda entry point
# =============================================================================


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Invoked by AppSync (Mutation.askAgent) or by EventBridge.

    Identity comes from the event, never from the request body: AppSync has
    already verified the Cognito token and puts the claims in `identity`.
    """
    identity = event.get("identity", {})
    claims = identity.get("claims", {})

    principal = Principal(
        sub=identity.get("sub", "unknown"),
        tenant_id=claims.get("custom:tenantId", ""),
        roles=identity.get("groups") or ["viewer"],
    )

    if not principal.tenant_id:
        raise PermissionError("no tenant claim on the token")

    question = event["arguments"]["question"]

    # Viewers get the read-only tool set. Least privilege applies to agents too.
    available = TOOLS if principal.can_write else [t for t in TOOLS if t.name not in WRITE_TOOLS]

    return run_agent(question, principal, available)


# The tool registry itself is omitted here - see src/ai/tools.ts for the full
# set (searchRunbooks, querySignals, findNearbySites, listOpenIncidents,
# openIncident) with the same schemas and the same authorisation rules.
TOOLS: list[Tool] = []
