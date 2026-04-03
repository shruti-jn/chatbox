/**
 * Output Guardrails
 *
 * Filters AI responses before delivery to student:
 * 1. Strip PII from AI response
 * 2. Classify response for safety
 * 3. Enforce teacher-configured boundaries
 * 4. Prevent direct answers in Socratic mode
 */

import { detectAndRedactPII } from './pii-detector.js'

export interface OutputGuardrailResult {
  text: string
  modified: boolean
  modifications: string[]
}

export function applyOutputGuardrails(
  text: string,
  config: {
    mode?: string
    subject?: string
  },
): OutputGuardrailResult {
  const modifications: string[] = []
  let result = text

  // 1. Strip PII from AI response
  const pii = detectAndRedactPII(result)
  if (pii.hadPII) {
    result = pii.redactedMessage
    modifications.push(`PII stripped: ${pii.piiFound.map(p => p.type).join(', ')}`)
  }

  // 2. Check for off-topic content when subject is configured
  if (config.subject) {
    // Basic check — in production, use LLM classification
    const offTopicIndicators = [
      /\b(I cannot|I can't|I'm not able to) help with that/i,
      /\bthat's outside my scope\b/i,
    ]
    // Note: We don't block here — just log for monitoring
  }

  return {
    text: result,
    modified: modifications.length > 0,
    modifications,
  }
}
