/**
 * ---------------------------------------------------------------------------
 * Amazon Bedrock - text generation + embeddings
 * ---------------------------------------------------------------------------
 * THE REAL CALL. On Bedrock, Claude model IDs carry an `anthropic.` prefix and
 * you use the Bedrock client class rather than the first-party one:
 *
 *   import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
 *   const client = new AnthropicBedrockMantle({ awsRegion: 'us-east-1' });
 *
 *   const res = await client.messages.create({
 *     model: 'anthropic.claude-opus-5',
 *     max_tokens: 16000,
 *     system: SYSTEM_PROMPT,
 *     tools: TOOL_SPECS,            // see ai/tools.ts
 *     messages,
 *   });
 *   // res.stop_reason === 'tool_use'  ->  run the tool, append the result,
 *   //                                     call again. That loop IS the agent;
 *   //                                     see ai/agent-core.ts
 *
 * Embeddings are an Amazon (not Anthropic) model, so they go through the plain
 * bedrock-runtime InvokeModel API:
 *
 *   new InvokeModelCommand({
 *     modelId: 'amazon.titan-embed-text-v2:0',
 *     body: JSON.stringify({ inputText: text, dimensions: 1024 }),
 *   })
 *
 * BELOW is an offline stand-in so the demo runs with no AWS account and no
 * network. The embedding is a real (if crude) deterministic hashing embedding,
 * so vector search genuinely works - retrieval you can watch is worth more for
 * learning than a hard-coded list of "results".
 */
import { sha256 } from '../platform/crypto.ts';
import { log } from '../platform/logger.ts';
import { env } from '../platform/env.ts';

export const MODELS = {
  /** Bedrock IDs are prefixed. The bare `claude-opus-5` is the first-party ID. */
  text: env('BEDROCK_TEXT_MODEL_ID', 'anthropic.claude-opus-5'),
  embed: env('BEDROCK_EMBED_MODEL_ID', 'amazon.titan-embed-text-v2:0'),
};

/** Anthropic Messages API tool spec - identical shape on Bedrock. */
export type ToolSpec = {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
};

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type Message = { role: 'user' | 'assistant'; content: string | ContentBlock[] };

export type ModelResponse = {
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  content: ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
};

/** Track spend the way you would in production: from `response.usage`. */
export const usage = { calls: 0, inputTokens: 0, outputTokens: 0, embeddings: 0 };

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

const EMBED_DIMS = 256;

/**
 * Deterministic bag-of-words embedding. Each token is hashed into a bucket and
 * the vector is L2-normalised, so cosine similarity reduces to a dot product.
 * Titan/Cohere produce dense *semantic* vectors instead - but the interface and
 * all the maths downstream are identical, which is the part worth learning.
 */
export async function embed(text: string): Promise<number[]> {
  usage.embeddings++;
  const vec = new Array<number>(EMBED_DIMS).fill(0);

  for (const token of tokenize(text)) {
    // First 16 bits of the token's SHA-256, as the bucket index.
    const bucket = parseInt(sha256(token).slice(0, 4), 16);
    vec[bucket % EMBED_DIMS] += 1;
  }

  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/** Both vectors are unit length, so the dot product IS the cosine. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was', 'one',
  'our', 'out', 'has', 'with', 'this', 'that', 'from', 'have', 'what', 'when',
  'why', 'how', 'does', 'their', 'they', 'were', 'been', 'into', 'its',
]);

// ---------------------------------------------------------------------------
// Text generation (offline stand-in)
// ---------------------------------------------------------------------------

/**
 * A scripted "model". It reproduces the one behaviour that matters for
 * understanding agents: it either emits a `tool_use` block, or - once the
 * conversation contains enough tool results - emits a final `text` answer.
 *
 * `invokeModel` is a drop-in for `client.messages.create`: same inputs, same
 * `stop_reason` / `content` / `usage` outputs. That means ai/agent-core.ts is
 * written against the real contract and would run unchanged against Bedrock.
 */
export async function invokeModel(req: {
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens?: number;
}): Promise<ModelResponse> {
  usage.calls++;
  const inputTokens = estimateTokens(req.system + JSON.stringify(req.messages));
  usage.inputTokens += inputTokens;

  await new Promise((r) => setTimeout(r, 15)); // pretend network latency

  const planned = plan(req);
  const outputTokens = estimateTokens(JSON.stringify(planned.content));
  usage.outputTokens += outputTokens;
  log.debug('bedrock invokeModel', { model: MODELS.text, stop_reason: planned.stop_reason, inputTokens });

  return { ...planned, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

/** Which tools has the conversation already produced results for? */
function toolsAlreadyRun(messages: Message[]): Set<string> {
  const done = new Set<string>();
  const idToName = new Map<string, string>();

  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') idToName.set(b.id, b.name);
      if (b.type === 'tool_result') {
        const name = idToName.get(b.tool_use_id);
        if (name) done.add(name);
      }
    }
  }
  return done;
}

/**
 * Tools whose side effects a real model would only reach for when the user
 * actually asked for the action. Modelling that here keeps the demo honest:
 * an agent that pages someone because you asked "why is this slow?" is a bug,
 * not a feature.
 */
const ACTION_TOOLS = new Set(['openIncident', 'acknowledgeIncident', 'suppressAlarm']);
const ACTION_INTENT = /\b(open|raise|create|file|page|escalate|acknowledge|dispatch)\b/i;

function plan(req: { system: string; messages: Message[]; tools?: ToolSpec[] }): Omit<ModelResponse, 'usage'> {
  const done = toolsAlreadyRun(req.messages);
  const wantsAction = ACTION_INTENT.test(firstUserText(req.messages));

  const available = (req.tools ?? []).filter(
    (t) => wantsAction || !ACTION_TOOLS.has(t.name),
  );

  // Simulated reasoning: call each eligible tool once, in order, then answer.
  const next = available.find((t) => !done.has(t.name));
  if (next) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'I need ' + next.name + ' to answer this.' },
        { type: 'tool_use', id: 'toolu_' + usage.calls, name: next.name, input: inferArgs(next, req.messages) },
      ],
    };
  }

  return { stop_reason: 'end_turn', content: [{ type: 'text', text: synthesise(req.messages) }] };
}

/** Pull plausible arguments out of the user's question, for the demo. */
function inferArgs(tool: ToolSpec, messages: Message[]): Record<string, unknown> {
  const question = firstUserText(messages);
  const args: Record<string, unknown> = {};

  for (const key of tool.input_schema.required ?? []) {
    if (key === 'query' || key === 'question') args[key] = question;
    else if (key === 'deviceId') args[key] = extractDeviceId(question);
    else if (key === 'deviceIds') args[key] = [extractDeviceId(question)];
    else if (key === 'siteId') args[key] = extractSiteId(question);
    else if (key === 'severity') args[key] = 'critical';
    else if (key === 'minutes') args[key] = 60;
    else if (key === 'hours') args[key] = 6;
    else if (key === 'reason') args[key] = question;
    else if (key === 'title') args[key] = question;
    else args[key] = question;
  }
  return args;
}

/**
 * Guess a device id from the question.
 *
 * A REAL model reads the tool's schema and picks an argument. This stand-in
 * cannot, so it pattern-matches - and the fallback matters more than it looks:
 * passing the whole question through as a `deviceId` produces a tool error on
 * every turn, which makes the demo's agent trace look broken when the thing
 * being demonstrated is the loop, not the model.
 */
function extractDeviceId(text: string): string {
  const explicit = /\b(dev-[a-z]{3}-[a-z0-9]+-\d{2})\b/i.exec(text);
  if (explicit) return explicit[1].toLowerCase();

  // An engineer usually says a place and a role, not an id. Composing one from
  // whichever it mentions is enough to make the scripted agent behave
  // plausibly against the generated estate.
  const sites: Record<string, string> = {
    dallas: 'dal01', austin: 'aus01', denver: 'den01',
    chicago: 'chi01', phoenix: 'phx01',
  };
  const roles: Array<[word: string, prefix: string, first: number]> = [
    ['core', 'cor', 1],
    ['distribution', 'dis', 3],
    ['access', 'acc', 5],
    ['edge', 'wan', 2],
    ['switch', 'cor', 1],
  ];

  const lower = text.toLowerCase();
  const site = Object.entries(sites).find(([name]) => lower.includes(name))?.[1]
    ?? Object.entries(sites).find(([, id]) => lower.includes(id))?.[1]
    ?? 'dal01';
  const role = roles.find(([word]) => lower.includes(word)) ?? roles[0];

  return 'dev-' + role[1] + '-' + site + '-' + String(role[2]).padStart(2, '0');
}

function extractSiteId(text: string): string {
  const explicit = /\b([a-z]{3}-\d{2})\b/i.exec(text);
  if (explicit) return explicit[1].toLowerCase();

  const sites: Record<string, string> = {
    dallas: 'dal-01', austin: 'aus-01', denver: 'den-01',
    chicago: 'chi-01', phoenix: 'phx-01',
  };
  const lower = text.toLowerCase();
  return Object.entries(sites).find(([name]) => lower.includes(name))?.[1] ?? 'dal-01';
}

function firstUserText(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  return first.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join(' ');
}

/** Compose a final answer out of everything the tools returned. */
function synthesise(messages: Message[]): string {
  const results: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') results.push(b.content);
    }
  }

  // The runbook advice only when a runbook was actually retrieved. Offered
  // unconditionally, it told a contact-centre lead to "confirm the device is
  // safe" about a Genesys queue - an ungrounded recommendation, the one thing
  // the output guardrail exists to catch in a real model.
  const hadRunbook = results.some((r) => r.startsWith('SOURCE '));
  return [
    'Root-cause summary, grounded in ' + results.length + ' tool call(s):',
    ...results.map((r) => '  - ' + oneLine(r)),
    ...(hadRunbook ? [
      '',
      'Recommended action: follow the retrieved runbook - work its triage steps',
      'in order, and confirm the device is safe before deciding anything about',
      'the load.',
    ] : []),
  ].join('\n');
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 170 ? flat.slice(0, 167) + '...' : flat;
}

/** Rough token estimate. In production: client.messages.countTokens(). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
