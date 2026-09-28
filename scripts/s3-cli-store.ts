/**
 * An ObjectStore that writes through the AWS CLI - for Node scripts a person
 * runs with their own AWS setup (`pnpm seed:aws`).
 *
 * WHY THE CLI, not @aws-sdk/client-s3: the one writer that exists today is
 * that script, run on a workstation where the CLI is already configured -
 * profile, SSO, whatever the person uses - and the CLI resolves credentials
 * exactly as they expect. It costs no new dependency. A SCHEDULED poller in
 * Lambda has no CLI; it needs an SDK adapter (aws/s3.sdk.ts, the shape of
 * aws/dynamodb.sdk.ts) - the ObjectStore interface is the same, so nothing
 * above it changes.
 *
 * The body goes through a temporary file (the CLI reads `--body` from a
 * path), deleted afterwards whether the upload worked or not. A failed
 * upload rejects with the CLI's own message, which the archive reports - it
 * never fails the poll.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObjectStore } from '../src/aws/s3.ts';

function aws(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('aws', args, { encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error('aws ' + args.slice(0, 2).join(' ') + ' failed: ' + (stderr.trim() || err.message).split('\n')[0]));
      else resolve(stdout);
    });
  });
}

export function createCliObjectStore(bucket: string): ObjectStore {
  return {
    name: bucket,
    async put(key, body, contentType) {
      const dir = await mkdtemp(join(tmpdir(), 'netpulse-archive-'));
      const file = join(dir, 'body');
      try {
        await writeFile(file, body, 'utf8');
        await aws(['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', file, '--content-type', contentType, '--output', 'json']);
        return 's3://' + bucket + '/' + key;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
