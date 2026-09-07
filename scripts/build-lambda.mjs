/**
 * Bundle a Lambda handler for deployment.
 *
 * WHY A BUILD STEP HERE AND NOWHERE ELSE. Node runs this repo's TypeScript
 * directly via type-stripping, which is why there is no build for the demo or
 * the tests. The Lambda runtime is the one place that will not do it: the
 * runtime resolves a handler by filename, `.ts` is not a filename it looks
 * for, and `--experimental-strip-types` inside a managed runtime is a bet on
 * an unstable flag. Bundling to one `.mjs` is boring and it works.
 *
 * It also solves the packaging problem honestly. The trigger imports
 * `platform/crypto.ts`, which imports more; zipping the source directory would
 * either miss those or ship the whole repo. esbuild follows the graph and
 * emits exactly what runs.
 *
 * esbuild is a devDependency, not a runtime one - `src/` still has zero
 * runtime dependencies, which is the claim that matters.
 */
import { build } from 'esbuild';
import { rm, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every Lambda we actually deploy. Today that is one. */
const FUNCTIONS = [
  {
    name: 'pre-token-generation',
    // NOT the handler itself. This entry wires the DynamoDB membership
    // adapter and re-exports the handler, keeping the AWS SDK out of the
    // shared module graph that the browser also loads.
    entry: 'infra/terraform/auth/lambda-entry.ts',
  },
];

const outRoot = resolve(root, 'infra/terraform/auth/.build');

await rm(outRoot, { recursive: true, force: true });

for (const fn of FUNCTIONS) {
  const outdir = resolve(outRoot, fn.name);
  await mkdir(outdir, { recursive: true });

  await build({
    entryPoints: [resolve(root, fn.entry)],
    outfile: resolve(outdir, 'index.mjs'),
    bundle: true,
    format: 'esm',
    // The Lambda runtime, not the browser. `platform: 'node'` keeps esbuild
    // from shimming things that are already there.
    platform: 'node',
    target: 'node22',
    // The nodejs22.x runtime ships AWS SDK v3, so bundling it would add
    // megabytes to the zip and slow every cold start to ship a copy of what
    // is already on the box. External here, devDependency in package.json -
    // which is also what keeps `src/` free of runtime dependencies.
    //
    // AWS has signalled the SDK may not be bundled in future runtimes. If
    // that happens this line moves to a real dependency, and the only thing
    // that changes is the size of the zip.
    external: ['@aws-sdk/*'],
    // Sourcemaps make a CloudWatch stack trace point at the TypeScript line
    // that caused it rather than at column 4,891 of a bundle.
    sourcemap: 'inline',
    minify: false,
    logLevel: 'warning',
  });

  console.log(`built ${fn.name} -> ${outdir}/index.mjs`);
}
