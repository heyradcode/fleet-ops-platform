/**
 * Write web/.env.cognito.local from the Terraform outputs.
 *
 *   pnpm web:env        # after `terraform apply` in infra/terraform/auth
 *
 * A script rather than a one-liner in the README because the one-liner is a
 * quoting puzzle that differs between bash and PowerShell, and a mistyped
 * value here is the "nobody can sign in" class of bug - a wrong issuer fails
 * every token check with a sentence that points at the token.
 *
 * The values are PUBLIC client identifiers (pool domain, client id, issuer,
 * API URL): they are compiled into every build of the board anyway. The file
 * is gitignored because it is per-environment, not because it is secret.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'web/.env.cognito.local');

let raw;
try {
  raw = execFileSync('terraform', ['-chdir=' + resolve(root, 'infra/terraform/auth'), 'output', '-json', 'vercel_env'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
} catch {
  console.error('\nCould not read the Terraform outputs. Has infra/terraform/auth been applied, and is terraform on PATH?');
  process.exit(1);
}

const values = JSON.parse(raw);

// The assistant on AgentCore, if infra/terraform/agentcore has been applied.
// Optional: without it the assistant runs in the tab, which is a working
// board rather than a broken one.
try {
  const agent = execFileSync('terraform', ['-chdir=' + resolve(root, 'infra/terraform/agentcore'), 'output', '-json', 'web_env'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  Object.assign(values, JSON.parse(agent));
} catch {
  console.log('(no AgentCore outputs - the assistant will run in the tab; see docs/11-agentcore.md)');
}
const lines = Object.entries(values).map(([k, v]) => k + '=' + v);
writeFileSync(target, '# Written by `pnpm web:env` from `terraform output vercel_env`. Public identifiers, per environment.\n' +
  lines.join('\n') + '\n');
console.log('wrote ' + target + '\n  ' + Object.keys(values).join('\n  '));
