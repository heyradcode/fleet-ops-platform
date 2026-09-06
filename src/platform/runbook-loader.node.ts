/**
 * The Node adapter for the runbook registry.
 *
 * This file is the ONLY place in `src/` that touches the filesystem, and it is
 * imported exclusively by Node entry points (`demo.ts`, the test setup). Keeping
 * `node:fs` out of every other module is what lets the whole backend run in a
 * browser - see the header of `runbook-loader.ts`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setRunbooks, type RunbookDoc } from './runbook-loader.ts';

/** ESM has no __dirname - derive it from import.meta.url. */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const RUNBOOK_DIR = join(HERE, '..', 'data', 'runbooks');

export function loadRunbooksFromDisk(): RunbookDoc[] {
  const docs = readdirSync(RUNBOOK_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()                                   // deterministic ingestion order
    .map((source) => ({
      source,
      text: readFileSync(join(RUNBOOK_DIR, source), 'utf8'),
    }));

  setRunbooks(docs);
  return docs;
}
