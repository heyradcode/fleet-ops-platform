/**
 * ---------------------------------------------------------------------------
 * Where runbook documents come from
 * ---------------------------------------------------------------------------
 * The knowledge base needs the text of every runbook. On a Lambda that is a
 * `readdirSync` over a bundled directory; in the browser it is a Vite glob
 * import; in a test it is three strings written inline.
 *
 * Rather than branch on the runtime, this module holds a REGISTRY and the
 * runtime fills it. `knowledge-base.ts` reads from here and never learns which
 * of the three it got.
 *
 * THE IMPORTANT PART - why this is not just `if (isNode)`:
 *
 *   A static `import { readFileSync } from 'node:fs'` anywhere in the shared
 *   module graph breaks the browser build, EVEN IF THE FUNCTION IS NEVER
 *   CALLED. Bundlers resolve imports, not call sites. So the Node-only code
 *   lives in its own file (`runbook-loader.node.ts`) that only Node entry
 *   points import, and `node:fs` never enters the graph the browser sees.
 *
 * This is the same reason `crypto.ts` implements SHA-256 by hand instead of
 * branching on `node:crypto`.
 */

export type RunbookDoc = {
  /** File name, e.g. `route-deviation.md`. Becomes the citation source. */
  source: string;
  /** Raw markdown. */
  text: string;
};

let registry: RunbookDoc[] = [];

/** Called once at startup by whichever runtime adapter is in play. */
export function setRunbooks(docs: RunbookDoc[]): void {
  registry = docs;
}

export function getRunbooks(): RunbookDoc[] {
  if (registry.length === 0) {
    // Fail loudly. A silently empty knowledge base makes the agent answer
    // "no runbook matched" for every question, which looks like a retrieval
    // bug and is actually a wiring bug - an hour of debugging the wrong layer.
    throw new Error(
      'No runbooks registered. Call setRunbooks() at startup - see ' +
      'runbook-loader.node.ts for the Node adapter.',
    );
  }
  return registry;
}
