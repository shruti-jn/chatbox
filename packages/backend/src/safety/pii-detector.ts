/**
 * Stage 1: PII Detection
 * Budget: <50ms
 * Detects phone, email, SSN, address patterns and redacts to [REDACTED]
 */

export interface PIIMatch {
  type: 'phone' | 'email' | 'ssn' | 'address'
  original: string
  start: number
  end: number
}

const PII_PATTERNS: { type: PIIMatch['type']; pattern: RegExp }[] = [
  // Phone numbers: various US formats
  { type: 'phone', pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g },
  // Email addresses
  { type: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  // SSN: XXX-XX-XXXX
  { type: 'ssn', pattern: /\b\d{3}[-]?\d{2}[-]?\d{4}\b/g },
  // Simple address pattern (number + street name)
  { type: 'address', pattern: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Ct|Court|Pl|Place)\b/gi },
]

export interface PIIDetectionResult {
  redactedMessage: string
  piiFound: PIIMatch[]
  hadPII: boolean
}

export function detectAndRedactPII(text: string): PIIDetectionResult {
  const piiFound: PIIMatch[] = []
  let redacted = text

  for (const { type, pattern } of PII_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      piiFound.push({
        type,
        original: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
    redacted = redacted.replace(pattern, '[REDACTED]')
  }

  return {
    redactedMessage: redacted,
    piiFound,
    hadPII: piiFound.length > 0,
  }
}
