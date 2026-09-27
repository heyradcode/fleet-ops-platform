/**
 * The runbooks, as `pnpm build:agent` embeds them (scripts/build-agent.mjs).
 * A build-time module: the AgentCore zip has no src/data/runbooks directory
 * to read at run time, so the text goes into the bundle itself.
 */
declare module 'netpulse:runbooks' {
  const docs: Array<{ source: string; text: string }>;
  export default docs;
}
