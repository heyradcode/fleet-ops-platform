/**
 * ---------------------------------------------------------------------------
 * Bedrock Guardrails
 * ---------------------------------------------------------------------------
 * A managed policy layer you attach to a model invocation by ID:
 *
 *   client.messages.create({ ..., guardrailIdentifier, guardrailVersion })
 *
 * It applies to BOTH directions - input and output - and covers:
 *   - denied topics        (define by natural-language description)
 *   - content filters      (hate, violence, sexual, prompt attacks) with
 *                          per-category HIGH/MEDIUM/LOW strength
 *   - word filters         (profanity, competitor names)
 *   - PII                  (BLOCK or ANONYMIZE; ~30 built-in types plus regex)
 *   - contextual grounding (score the answer against the retrieved context and
 *                           block it if it is not supported - the closest thing
 *                           to a managed hallucination check)
 *
 * The local version below exists to make the CONCEPT concrete and to enforce
 * the one rule that is genuinely ours rather than the platform's: an agent
 * whose tools can change infrastructure must not act beyond the caller's role.
 * That check belongs in code, not in a prompt - a guardrail you can only
 * express as an instruction is a guardrail an attacker can argue with.
 */
import type { Principal } from '../platform/types.ts';

export type GuardrailVerdict = { allowed: boolean; reason?: string; redactedText?: string };

/** PII redaction, mirroring the ANONYMIZE action. */
const PII_PATTERNS: Array<[label: string, re: RegExp]> = [
  ['EMAIL', /[\w.+-]+@[\w-]+\.[\w.]{2,}/g],
  ['PHONE', /\b(?:\+?1[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/g],
  ['IPV4', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['AWS_KEY', /\bAKIA[0-9A-Z]{16}\b/g],
];

export function redactPii(text: string): string {
  let out = text;
  for (const [label, re] of PII_PATTERNS) out = out.replace(re, '[' + label + '_REDACTED]');
  return out;
}

/** Input guardrail: what the user is allowed to ask for. */
export function checkInput(question: string): GuardrailVerdict {
  // Denied-topic equivalent: this agent answers operational questions only.
  const denied = [
    /\b(credit card|ssn|social security)\b/i,
    /\b(fire|terminate|discipline)\s+(the\s+)?(agent|employee|staff)/i,
  ];
  for (const re of denied) {
    if (re.test(question)) {
      return { allowed: false, reason: 'denied topic: outside the operational scope of this assistant' };
    }
  }

  // Prompt-attack filter equivalent. Crude on purpose: the real defence is that
  // tools enforce their own authorisation, not that we can spot every phrasing.
  if (/ignore (all |your )?(previous|prior) instructions/i.test(question)) {
    return { allowed: false, reason: 'prompt injection pattern detected' };
  }

  return { allowed: true, redactedText: redactPii(question) };
}

/** Output guardrail: what the model is allowed to say back. */
export function checkOutput(answer: string, retrievedContext: string[]): GuardrailVerdict {
  const redacted = redactPii(answer);

  /**
   * CONTEXTUAL GROUNDING, in miniature. Bedrock scores the answer against the
   * source passages and blocks below a threshold you set. Here: if the answer
   * makes a confident claim but shares almost no vocabulary with anything we
   * retrieved, it is probably invented.
   */
  if (retrievedContext.length > 0) {
    const contextTerms = new Set(retrievedContext.join(' ').toLowerCase().split(/\W+/));
    const answerTerms = answer.toLowerCase().split(/\W+/).filter((t) => t.length > 4);
    const grounded = answerTerms.filter((t) => contextTerms.has(t)).length;
    const ratio = answerTerms.length > 0 ? grounded / answerTerms.length : 1;

    if (ratio < 0.15) {
      return { allowed: false, reason: 'failed contextual grounding: answer not supported by retrieved sources' };
    }
  }

  return { allowed: true, redactedText: redacted };
}

/**
 * Authorisation for tools. THE rule for agentic systems:
 *
 *   An agent acts with the permissions of the person who invoked it,
 *   never with the permissions of the Lambda it happens to run in.
 *
 * Get this wrong and prompt injection becomes privilege escalation: a hostile
 * string in a vendor payload persuades the model to call `openIncident`, and
 * because the Lambda role can do it, it happens. Checking the caller's role
 * here means the worst case is a refused tool call.
 */
export function canUseTool(principal: Principal, toolName: string): GuardrailVerdict {
  const writeTools = new Set(['openIncident', 'acknowledgeIncident', 'dispatchEngineer']);

  if (writeTools.has(toolName) && !principal.roles.some((r) => r === 'admin' || r === 'operator')) {
    return {
      allowed: false,
      reason: 'role ' + principal.roles.join('/') + ' may not invoke the write tool ' + toolName,
    };
  }
  return { allowed: true };
}
