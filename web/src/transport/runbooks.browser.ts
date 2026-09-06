/**
 * The browser adapter for the runbook registry.
 *
 * The mirror of `src/platform/runbook-loader.node.ts`, which reads the same
 * files with `readdirSync`. Neither knows about the other; both fill the same
 * registry, and `knowledge-base.ts` never learns which one it got.
 *
 * This is the payoff for the shape chosen in Phase 1. Had the knowledge base
 * imported `node:fs` directly - the obvious way to write it - the front end
 * would have needed either a server in front of the agent or a second copy of
 * the runbooks. Bundlers resolve imports whether or not the code path runs, so
 * a single static `node:fs` anywhere in the graph would have made this
 * impossible rather than merely awkward.
 *
 * `eager: true` inlines the markdown at build time. Four runbooks is a few KB
 * and the knowledge base needs all of them to index anything, so there is
 * nothing to gain from lazy loading and a race to lose.
 */
import { setRunbooks, type RunbookDoc } from '../../../src/platform/runbook-loader.ts';

const FILES = import.meta.glob('../../../src/data/runbooks/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export function loadRunbooksFromBundle(): RunbookDoc[] {
  const docs: RunbookDoc[] = Object.entries(FILES)
    .map(([path, text]) => ({ source: path.split('/').pop() ?? path, text }))
    // Same deterministic ingestion order as the Node adapter. Chunk ids derive
    // from position, so an unstable order would mean unstable citations.
    .sort((a, b) => a.source.localeCompare(b.source));

  setRunbooks(docs);
  return docs;
}
