/**
 * Stage 4: Crisis Detection
 * Budget: <10ms
 * ALWAYS runs regardless of prior stage results
 * Detects self-harm/suicidal ideation keywords
 * Returns crisis resources immediately
 */

const CRISIS_KEYWORDS = [
  /\b(want\s+to\s+)?kill\s+my\s*self\b/i,
  /\bsuicid(e|al)\b/i,
  /\bself[\s-]?harm\b/i,
  /\bcut(ting)?\s+my\s*self\b/i,
  /\bend\s+(my\s+)?life\b/i,
  /\bwant\s+to\s+die\b/i,
  /\bnot\s+worth\s+living\b/i,
  /\bno\s+(reason|point)\s+to\s+live\b/i,
  /\bhurt\s+my\s*self\b/i,
  /\bdon'?t\s+want\s+to\s+(be\s+)?alive\b/i,
]

export const CRISIS_RESOURCES = [
  '988 Suicide & Crisis Lifeline: Call or text 988',
  'Crisis Text Line: Text HOME to 741741',
  'SAMHSA National Helpline: 1-800-662-4357',
  'Trevor Project (LGBTQ+ Youth): 1-866-488-7386',
]

export interface CrisisResult {
  isCrisis: boolean
  matchedKeywords: string[]
  resources: string[]
}

export function detectCrisis(text: string): CrisisResult {
  const matchedKeywords: string[] = []

  for (const pattern of CRISIS_KEYWORDS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) {
      matchedKeywords.push(pattern.source)
    }
  }

  return {
    isCrisis: matchedKeywords.length > 0,
    matchedKeywords,
    resources: matchedKeywords.length > 0 ? CRISIS_RESOURCES : [],
  }
}
