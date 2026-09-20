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

const RUNBOOK = `# Runbook: Link down

An interface has stopped forwarding.

## Symptoms

A \`link-state\` event with state down.

## Triage

Check the alarm timeline for the device.
`;

test('chunks split on headings, and carry the titles INTO the embedded text', () => {
  const chunks = chunkMarkdown(RUNBOOK, 'link-down.md', 'acme-networks');

  assert.deepEqual(
    chunks.map((c) => c.metadata.section),
    ['Overview', 'Symptoms', 'Triage'],
  );

  // The topic has to live inside the chunk, or a chunk about "check the
  // timeline" matches nothing that mentions a link going down.
  const triage = chunks.find((c) => c.metadata.section === 'Triage');
  assert.ok(triage);
  assert.match(triage.text, /Link down/);
  assert.match(triage.text, /## Triage/);
});

test('retrieval is filtered by tenant, always', async () => {
  setRunbooks([{ source: 'link-down.md', text: RUNBOOK }]);

  const kb = new KnowledgeBase();
  await kb.ingestRunbooks('acme-networks');
  assert.ok(kb.size > 0);

  const mine = await kb.retrieve('interface stopped forwarding', { tenantId: 'acme-networks' });
  assert.ok(mine.length > 0);

  // Another customer's query reaches none of it. Not "ranked lower" - absent.
  const theirs = await kb.retrieve('interface stopped forwarding', { tenantId: 'northwind-utilities' });
  assert.equal(theirs.length, 0);
});

test('results come back ranked, best first', async () => {
  setRunbooks([{ source: 'link-down.md', text: RUNBOOK }]);
  const kb = new KnowledgeBase();
  await kb.ingestRunbooks('acme-networks');

  const hits = await kb.retrieve('symptoms link state event down', {
    tenantId: 'acme-networks',
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
    await embed('link down'),
    await embed('interface stopped forwarding'),
  );
  assert.equal(synonyms, 0, 'no shared tokens, so a hashed bag-of-words sees nothing');

  const overlapping = cosineSimilarity(
    await embed('optical degradation warning'),
    await embed('optical degradation review'),
  );
  assert.ok(overlapping > 0.5, 'shared tokens DO score');
});
