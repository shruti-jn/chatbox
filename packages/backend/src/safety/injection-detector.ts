/**
 * Stage 2: Injection Detection
 * Budget: <20ms
 * 13 compiled regex patterns for prompt injection markers
 * Extracts real user intent when possible
 */

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(your\s+)?instructions/i,
  /ignore\s+(your\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?prior\s+(instructions|rules|guidelines)/i,
  /you\s+are\s+now\s+(a|an)\b/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /\bjailbreak\b/i,
  /\bdan\s+mode\b/i,
  /\bno\s+restrictions\b/i,
  /bypass\s+(your\s+)?(filters|rules|safety|restrictions)/i,
  /override\s+(your\s+)?(rules|instructions|programming)/i,
  /disregard\s+(your\s+)?(rules|instructions|guidelines)/i,
  /forget\s+(your\s+)?(rules|instructions|training|programming)/i,
  /act\s+as\s+if\s+you\s+(have\s+)?no\s+(rules|restrictions|limitations)/i,
  /system\s*prompt/i,
]

// Try to extract the real question from an injection wrapper
const INTENT_EXTRACTION = /(?:but\s+)?(?:actually|really|just)\s+(?:tell\s+me|answer|help\s+(?:me\s+)?with)\s+(.+)/i

export interface InjectionResult {
  isInjection: boolean
  matchedPatterns: string[]
  extractedIntent: string | null
}

export function detectInjection(text: string): InjectionResult {
  const matchedPatterns: string[] = []

  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) {
      matchedPatterns.push(pattern.source)
    }
  }

  let extractedIntent: string | null = null
  if (matchedPatterns.length > 0) {
    const intentMatch = INTENT_EXTRACTION.exec(text)
    if (intentMatch) {
      extractedIntent = intentMatch[1].trim()
    }
  }

  return {
    isInjection: matchedPatterns.length > 0,
    matchedPatterns,
    extractedIntent,
  }
}
