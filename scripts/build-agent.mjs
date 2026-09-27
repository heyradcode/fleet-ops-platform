/**
 * Bundle the AgentCore agent: infra/terraform/agentcore/agent-entry.ts ->
 * infra/terraform/agentcore/.build/agent/agent.js. Terraform zips that file
 * and uploads it; AgentCore runs `node agent.js` in an arm64 microVM.
 *
 *   pnpm build:agent
 *
 * DIFFERENT FROM build-lambda.mjs IN TWO WAYS, both deliberate:
 *
 *   The AWS SDK is BUNDLED. Lambda's Node runtime ships it; AgentCore's
 *   NODE_22 runtime ships nothing, so an `external` SDK would be a
 *   `Cannot find module` at the first request - after a deploy that
 *   reported success.
 *
 *   CommonJS, not ESM. The entry point must be a `.js` file, which Node
 *   reads as CommonJS without a package.json saying otherwise - and ADOT
 *   auto-instrumentation, if it is ever added, only patches `require()`.
 *
 * The runbooks are EMBEDDED through a virtual module, `netpulse:runbooks`:
 * the zip has no src/data/runbooks directory for the Node loader to read.
 *
 * Pure JavaScript only: AgentCore rejects a package containing a native
 * `.node` binary built for the wrong architecture, and a single bundled file
 * contains none.
 */
import { build } from 'esbuild';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'infra/terraform/agentcore/.build/agent');
const runbookDir = resolve(root, 'src/data/runbooks');

const runbooksPlugin = {
  name: 'netpulse-runbooks',
  setup(b) {
    b.onResolve({ filter: /^netpulse:runbooks$/ }, () => ({ path: 'runbooks', namespace: 'netpulse' }));
    b.onLoad({ filter: /.*/, namespace: 'netpulse' }, async () => {
      const files = (await readdir(runbookDir)).filter((f) => f.endsWith('.md')).sort();
      if (files.length === 0) throw new Error('no runbooks in ' + runbookDir + ' - the agent would answer "no runbook matched" to everything');
      const docs = await Promise.all(files.map(async (f) => ({ source: f, text: await readFile(join(runbookDir, f), 'utf8') })));
      return { contents: 'module.exports = ' + JSON.stringify(docs) + ';', loader: 'js', watchFiles: files.map((f) => join(runbookDir, f)) };
    });
  },
};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'infra/terraform/agentcore/agent-entry.ts')],
  outfile: resolve(outdir, 'agent.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  plugins: [runbooksPlugin],
  // A CloudWatch stack trace should point at the TypeScript line.
  sourcemap: 'inline',
  minify: false,
  logLevel: 'warning',
  metafile: true,
});

// SAYS it is CommonJS rather than relying on there being no package.json
// above it. Node decides by the NEAREST package.json: in the zip there is
// none, but run locally the repo root's "type": "module" wins and the bundle
// dies on its first require() - a local test that fails for a reason the
// deployed agent never meets, or the reverse. Shipped in the zip beside it.
await writeFile(resolve(outdir, 'package.json'), JSON.stringify({ type: 'commonjs', engines: { node: '>=22' } }) + '\n');

const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log('built agent -> ' + resolve(outdir, 'agent.js') + ' (' + (bytes / 1024 / 1024).toFixed(1) + ' MB with sourcemap)');
