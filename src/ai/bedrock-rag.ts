/**
 * ---------------------------------------------------------------------------
 * RAG: retrieval-augmented generation, without the agent loop
 * ---------------------------------------------------------------------------
 * Two ways to use a knowledge base on Bedrock. Know when to reach for which:
 *
 *   RetrieveAndGenerate  - one API call. Bedrock retrieves, stuffs the context
 *                          into a prompt, generates, and returns citations.
 *                          Cheap, fast, predictable. Use it for Q&A.
 *   Retrieve + your own   - you get the chunks and build the prompt yourself.
 *   invoke                 Use it when you need to mix retrieved text with
 *                          live data, control the prompt, or feed an agent.
 *
 * This file is the second form, which is also what `searchRunbooks` gives the
 * agent. RAG and agents are not alternatives: RAG is a retrieval strategy, an
 * agent is a control-flow strategy, and the agent uses RAG as one of its tools.
 *
 * The real one-call version:
 *   await client.send(new RetrieveAndGenerateCommand({
 *     input: { text: question },
 *     retrieveAndGenerateConfiguration: {
 *       type: 'KNOWLEDGE_BASE',
 *       knowledgeBaseConfiguration: {
 *         knowledgeBaseId: process.env.BEDROCK_KNOWLEDGE_BASE_ID,
 *         modelArn: 'anthropic.claude-opus-5',
 *         retrievalConfiguration: { vectorSearchConfiguration: {
 *           numberOfResults: 4,
 *           filter: { equals: { key: 'tenantId', value: principal.tenantId } },
 *         }},
 *       },
 *     },
 *   }));
 */
import { invokeModel } from '../aws/bedrock.ts';
import { knowledgeBase, type RetrievedChunk } from './knowledge-base.ts';
import { checkInput, checkOutput } from './guardrails.ts';
import type { Principal } from '../platform/types.ts';

export type RagAnswer = {
  answer: string;
  citations: Array<{ source: string; section: string; score: number; snippet: string }>;
  retrieved: RetrievedChunk[];
};

export async function askWithRag(question: string, principal: Principal): Promise<RagAnswer> {
  const inputCheck = checkInput(question);
  if (!inputCheck.allowed) {
    return { answer: 'Blocked by guardrail: ' + inputCheck.reason, citations: [], retrieved: [] };
  }

  // 1. RETRIEVE - always tenant-filtered.
  const retrieved = await knowledgeBase.retrieve(question, { tenantId: principal.tenantId, topK: 3 });

  if (retrieved.length === 0) {
    return { answer: 'No runbook covers that. I will not guess a procedure.', citations: [], retrieved: [] };
  }

  // 2. AUGMENT. Structure matters more than people expect:
  //    - number the sources so the model can cite them by index;
  //    - put the question LAST, after the context, so the instruction is the
  //      most recent thing the model read;
  //    - state explicitly what to do when the context is insufficient,
  //      otherwise the model fills the gap from its own priors.
  const context = retrieved
    .map((c, i) => '[' + (i + 1) + '] ' + c.source + ' - ' + c.metadata.section + '\n' + c.text)
    .join('\n\n');

  const prompt = [
    'Answer using ONLY the sources below. Cite them as [1], [2].',
    'If the sources do not contain the answer, say so plainly.',
    '',
    '<sources>',
    context,
    '</sources>',
    '',
    'Question: ' + (inputCheck.redactedText ?? question),
  ].join('\n');

  // 3. GENERATE. No tools - this is a single-shot call, not an agent.
  const response = await invokeModel({
    system: 'You are a precise operations assistant. Cite your sources.',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 16000,
  });

  const answer = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n');

  // 4. VERIFY grounding before returning.
  const outCheck = checkOutput(answer, retrieved.map((c) => c.text));

  return {
    answer: outCheck.allowed ? outCheck.redactedText ?? answer : 'Answer withheld: ' + outCheck.reason,
    citations: retrieved.map((c) => ({
      source: c.source,
      section: c.metadata.section,
      score: Number(c.score.toFixed(3)),
      snippet: c.text.replace(/\s+/g, ' ').slice(0, 140) + '...',
    })),
    retrieved,
  };
}
