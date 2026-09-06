/**
 * ---------------------------------------------------------------------------
 * Bedrock Knowledge Base - what it does for you, and what it hides
 * ---------------------------------------------------------------------------
 * In production this whole file is a managed service. You point a Bedrock
 * Knowledge Base at an S3 bucket, pick an embedding model and a vector store
 * (OpenSearch Serverless, Aurora pgvector, Pinecone), and call:
 *
 *   import { BedrockAgentRuntimeClient, RetrieveCommand }
 *     from '@aws-sdk/client-bedrock-agent-runtime';
 *
 *   await client.send(new RetrieveCommand({
 *     knowledgeBaseId: process.env.BEDROCK_KNOWLEDGE_BASE_ID,
 *     retrievalQuery: { text: question },
 *     retrievalConfiguration: {
 *       vectorSearchConfiguration: {
 *         numberOfResults: 4,
 *         overrideSearchType: 'HYBRID',       // semantic + keyword
 *         filter: { equals: { key: 'tenantId', value: principal.tenantId } },
 *       },
 *     },
 *   }));
 *
 * That `filter` line is the most important one on the page. A knowledge base is
 * shared infrastructure; without a metadata filter, tenant A's question
 * retrieves tenant B's documents. It is the RAG equivalent of a missing WHERE
 * clause, and it is the multi-tenancy question people forget to ask about AI.
 *
 * The ingestion pipeline it runs for you: chunk -> embed -> upsert -> index.
 * That is implemented below so you can watch it happen.
 */
import { cosineSimilarity, embed, tokenize } from '../aws/bedrock.ts';
import { getRunbooks } from '../platform/runbook-loader.ts';
import type { TenantId } from '../platform/types.ts';
import { log } from '../platform/logger.ts';

export type Chunk = {
  id: string;
  source: string;
  text: string;
  /** Metadata is what makes filtering possible. Always carry the tenant. */
  metadata: { tenantId: TenantId; section: string; docTitle: string };
  embedding: number[];
};

export type RetrievedChunk = Chunk & { score: number };

/**
 * CHUNKING STRATEGY - the decision that determines whether RAG works.
 *
 *   Too small  -> a chunk says "escalate to the carrier NOC" with no clue what
 *                 the symptom was. The model cites it and sounds insane.
 *   Too large  -> one chunk covers three unrelated procedures; the embedding is
 *                 an average of all of them and matches nothing well.
 *
 * Bedrock offers fixed-size, semantic, and HIERARCHICAL chunking. For
 * structured documents like runbooks, split on headings: the author already
 * told you where the semantic boundaries are. Free-form prose needs fixed-size
 * chunks with an overlap so a sentence spanning a boundary survives in one
 * piece.
 */
export function chunkMarkdown(markdown: string, source: string, tenantId: TenantId): Omit<Chunk, 'embedding'>[] {
  const docTitle = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? source;
  const chunks: Omit<Chunk, 'embedding'>[] = [];

  // Split on level-2 headings; keep the heading with its body.
  const sections = markdown.split(/^##\s+/m);
  const preamble = sections.shift() ?? '';

  if (preamble.trim().length > 0) {
    chunks.push({
      id: source + '#overview',
      source,
      text: preamble.trim(),
      metadata: { tenantId, section: 'Overview', docTitle },
    });
  }

  for (const section of sections) {
    const [heading, ...body] = section.split('\n');
    const text = body.join('\n').trim();
    if (text.length === 0) continue;

    chunks.push({
      id: source + '#' + heading.trim().toLowerCase().replace(/\s+/g, '-'),
      source,
      // Prepend the document and section titles. This matters: it puts the
      // topic INSIDE the embedded text, so a chunk about "escalate after 15
      // minutes" still matches a query about route deviation.
      text: '# ' + docTitle + '\n## ' + heading.trim() + '\n' + text,
      metadata: { tenantId, section: heading.trim(), docTitle },
    });
  }

  return chunks;
}

/**
 * The vector store. OpenSearch Serverless does this with HNSW; pgvector with
 * IVFFlat. Both are approximate-nearest-neighbour indexes - they trade a little
 * recall for a lot of speed. Brute force here, because with 15 chunks an index
 * would be slower, and because the maths is clearer without one.
 */
export class KnowledgeBase {
  readonly id: string;
  #chunks: Chunk[] = [];

  constructor(id = process.env.BEDROCK_KNOWLEDGE_BASE_ID ?? 'KB-local') {
    this.id = id;
  }

  get size(): number { return this.#chunks.length; }

  /** The Bedrock "ingestion job", in miniature. */
  async ingestRunbooks(tenantId: TenantId): Promise<void> {
    const docs = getRunbooks();

    for (const doc of docs) {
      for (const chunk of chunkMarkdown(doc.text, doc.source, tenantId)) {
        this.#chunks.push({ ...chunk, embedding: await embed(chunk.text) });
      }
    }
    log.info('knowledge base ingested', { docs: docs.length, chunks: this.#chunks.length });
  }

  /**
   * HYBRID SEARCH: semantic (embeddings) + lexical (keyword overlap).
   *
   * Why both? Embeddings understand that "choppy calls" relates to "packet
   * loss", but they are bad at exact tokens - a model number, an error code,
   * "SFP". Keyword search is the opposite. Bedrock's HYBRID search type does
   * this fusion for you; doing it by hand once makes the tradeoff concrete.
   */
  async retrieve(query: string, opts: { tenantId: TenantId; topK?: number }): Promise<RetrievedChunk[]> {
    const topK = opts.topK ?? 3;
    const queryVector = await embed(query);
    const queryTerms = new Set(tokenize(query));

    const scored = this.#chunks
      // THE TENANT FILTER. Never optional.
      .filter((c) => c.metadata.tenantId === opts.tenantId)
      .map((chunk) => {
        const semantic = cosineSimilarity(queryVector, chunk.embedding);

        const chunkTerms = new Set(tokenize(chunk.text));
        let overlap = 0;
        for (const t of queryTerms) if (chunkTerms.has(t)) overlap++;
        const lexical = queryTerms.size > 0 ? overlap / queryTerms.size : 0;

        // 70/30 in favour of semantic. Tune this against a real eval set, not
        // against a hunch - it is the single biggest quality lever in RAG.
        return { ...chunk, score: 0.7 * semantic + 0.3 * lexical };
      })
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, topK);
  }
}

export const knowledgeBase = new KnowledgeBase();
