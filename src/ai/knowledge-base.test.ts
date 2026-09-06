/**
 * What the retrieval layer actually does - including what it does NOT do.
 *
 * The last test here exists because a comment in knowledge-base.ts claimed the
 * embeddings "understand that 'choppy calls' relates to 'packet loss'". They do
 * not. `embed()` hashes each token into a bucket, so two synonyms sharing no
 * tokens score exactly zero, and nothing in the repository contradicted the
 * claim until someone measured it. A confident sentence about retrieval quality
 * is worth very little; a number is worth having.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkMarkdown, KnowledgeBase } from './knowledge-base.ts';
import { embed, cosineSimilarity } from '../aws/bedrock.ts';
import { setRunbooks } from '../platform/runbook-loader.ts';

const RUNBOOK = `# Runbook: Route deviation

A driver has left their planned corridor.

## Symptoms

A \`route-adherence\` reading above 400m.

## Triage

Check the exception timeline for the driver.
`;

test('chunks split on headings, and carry the titles INTO the embedded text', () => {
  const chunks = chunkMarkdown(RUNBOOK, 'route-deviation.md', 'acme-freight');

  assert.deepEqual(
    chunks.map((c) => c.metadata.section),
    ['Overview', 'Symptoms', 'Triage'],
  );

  // The topic has to live inside the chunk, or a chunk about "check the
  // timeline" matches nothing that mentions route deviation.
  const triage = chunks.find((c) => c.metadata.section === 'Triage');
  assert.ok(triage);
  assert.match(triage.text, /Route deviation/);
  assert.match(triage.text, /## Triage/);
});

test('retrieval is filtered by tenant, always', async () => {
  setRunbooks([{ source: 'route-deviation.md', text: RUNBOOK }]);

  const kb = new KnowledgeBase();
  await kb.ingestRunbooks('acme-freight');
  assert.ok(kb.size > 0);

  const mine = await kb.retrieve('driver off route', { tenantId: 'acme-freight' });
  assert.ok(mine.length > 0);

  // Another carrier's query reaches none of it. Not "ranked lower" - absent.
  const theirs = await kb.retrieve('driver off route', { tenantId: 'northstar-logistics' });
  assert.equal(theirs.length, 0);
});

test('results come back ranked, best first', async () => {
  setRunbooks([{ source: 'route-deviation.md', text: RUNBOOK }]);
  const kb = new KnowledgeBase();
  await kb.ingestRunbooks('acme-freight');

  const hits = await kb.retrieve('symptoms route adherence reading', {
    tenantId: 'acme-freight',
    topK: 3,
  });

  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score, 'scores must descend');
  }
});

test('the offline embedder is lexical, NOT semantic - synonyms score zero', async () => {
  // THE CLAIM THIS FILE EXISTS TO PIN.
  //
  // Shared tokens score; shared MEANING does not. Anyone swapping embed() for
  // Titan should see these two assertions start to disagree with each other,
  // and should then change this test deliberately rather than delete it.
  const synonyms = cosineSimilarity(
    await embed('driver left the planned route'),
    await embed('truck is off course'),
  );
  assert.equal(synonyms, 0, 'no shared tokens, so a hashed bag-of-words sees nothing');

  const overlapping = cosineSimilarity(
    await embed('harsh braking event'),
    await embed('harsh braking review'),
  );
  assert.ok(overlapping > 0.5, 'shared tokens DO score');
});
