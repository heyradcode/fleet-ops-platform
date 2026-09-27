/**
 * Where an assistant answer came from, in words - so "is this AgentCore or the
 * tab, and is it Claude or the stand-in?" is answered on the screen rather
 * than by reading network requests. Shared by both assistant panels.
 */
import type { AgentResult } from './transport/index.ts';

export function agentSource(result: AgentResult): string {
  const s = result.servedBy;
  if (!s) return '';
  const model = s.model === 'offline' ? 'offline model' : s.model.replace(/^anthropic\./, '');
  const where = s.host === 'agentcore' ? 'via AgentCore' : 'in this tab';
  // Only said when true: in-process is the default and says nothing new.
  const tools = s.tools === 'mcp' ? ' · tools over MCP' : '';
  // Turn 1 says nothing new; turn 2+ is the visible proof follow-ups work.
  return ' · ' + where + ' (' + model + ')' + tools + (s.turn > 1 ? ' · turn ' + s.turn : '');
}
