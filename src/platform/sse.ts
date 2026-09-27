/**
 * Server-sent events, parsed from a growing buffer. Shared by the board (the
 * agent's streamed steps) and the agent (an MCP server may answer as a stream).
 *
 * A stream arrives in network chunks that do not respect event boundaries:
 * one chunk can hold two events, or half of one. So this takes everything
 * received so far, returns the COMPLETE events, and hands back the unfinished
 * tail to be prefixed to the next chunk. An event ends at a blank line; its
 * payload is its `data:` lines joined.
 */
export function parseSse(buffer: string): { events: unknown[]; rest: string } {
  const normalised = buffer.replace(/\r\n/g, '\n');
  const parts = normalised.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: unknown[] = [];
  for (const part of parts) {
    const data = part.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) events.push(JSON.parse(data));
  }
  return { events, rest };
}
