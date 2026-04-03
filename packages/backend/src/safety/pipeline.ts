/**
 * 4-Stage Content Safety Pipeline
 *
 * Stage 1: PII Detection (regex, <50ms)
 * Stage 2: Injection Detection (regex, <20ms)
 * Stage 3: LLM Classification (Claude Sonnet, <500ms)
 * Stage 4: Crisis Detection (keyword, <10ms) — ALWAYS runs
 *
 * Total budget: <600ms
 * Sequential execution
 */

import { detectAndRedactPII, type PIIDetectionResult } from './pii-detector.js'
import { detectInjection, type InjectionResult } from './injection-detector.js'
import { detectCrisis, type CrisisResult, CRISIS_RESOURCES } from './crisis-detector.js'

export type Severity = 'safe' | 'warning' | 'blocked' | 'critical'
export type Category = 'safe' | 'pii_detected' | 'injection_detected' | 'violence' | 'sexual_content' | 'hate_speech' | 'self_harm' | 'off_topic' | 'crisis'

export interface ClassificationResult {
  severity: Severity
  category: Category
  originalIntent: string | null
  redactedMessage: string
  crisisResources: string[]
  piiFound: string[]
  processingTimeMs: number
  stages: {
    pii: PIIDetectionResult
    injection: InjectionResult
    llmClassification: { category: string; severity: Severity } | null
    crisis: CrisisResult
  }
}

/**
 * LLM Classification (Stage 3)
 * Uses Claude Sonnet to classify content safety
 * Returns null if LLM is unavailable (fallback: conservative block)
 */
async function classifyWithLLM(text: string): Promise<{ category: string; severity: Severity } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || apiKey === 'placeholder-set-real-key') {
    // LLM unavailable — apply conservative fallback
    return null
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `Classify this student message for content safety in a K-12 education platform. Respond with ONLY a JSON object: {"category": "<safe|violence|sexual_content|hate_speech|self_harm|off_topic>", "severity": "<safe|warning|blocked>"}

Message: "${text.slice(0, 500)}"`,
        }],
      }),
      signal: AbortSignal.timeout(3000), // 3s timeout for classification
    })

    if (!response.ok) return null

    const data = await response.json() as { content: Array<{ text: string }> }
    const resultText = data.content?.[0]?.text
    if (!resultText) return null

    const parsed = JSON.parse(resultText)
    return {
      category: parsed.category ?? 'safe',
      severity: parsed.severity ?? 'safe',
    }
  } catch {
    return null // LLM failure — handled by fallback
  }
}

/**
 * Run the full 4-stage pipeline
 */
export async function runSafetyPipeline(text: string): Promise<ClassificationResult> {
  const start = Date.now()

  // Stage 1: PII Detection (<50ms)
  const pii = detectAndRedactPII(text)

  // Stage 2: Injection Detection (<20ms)
  const injection = detectInjection(pii.redactedMessage)

  // If injection detected and no real intent extracted, block immediately
  if (injection.isInjection && !injection.extractedIntent) {
    // Stage 4: Crisis detection ALWAYS runs
    const crisis = detectCrisis(text)

    if (crisis.isCrisis) {
      return {
        severity: 'critical',
        category: 'crisis',
        originalIntent: null,
        redactedMessage: pii.redactedMessage,
        crisisResources: crisis.resources,
        piiFound: pii.piiFound.map(p => p.type),
        processingTimeMs: Date.now() - start,
        stages: { pii, injection, llmClassification: null, crisis },
      }
    }

    return {
      severity: 'blocked',
      category: 'injection_detected',
      originalIntent: injection.extractedIntent,
      redactedMessage: pii.redactedMessage,
      crisisResources: [],
      piiFound: pii.piiFound.map(p => p.type),
      processingTimeMs: Date.now() - start,
      stages: { pii, injection, llmClassification: null, crisis },
    }
  }

  // Stage 3: LLM Classification (<500ms)
  const textToClassify = injection.extractedIntent ?? pii.redactedMessage
  const llmClassification = await classifyWithLLM(textToClassify)

  // Stage 4: Crisis Detection — ALWAYS runs regardless of prior stages
  const crisis = detectCrisis(text)

  // Determine final severity
  let severity: Severity = 'safe'
  let category: Category = 'safe'

  // Crisis overrides everything
  if (crisis.isCrisis) {
    severity = 'critical'
    category = 'crisis'
  } else if (llmClassification) {
    if (llmClassification.severity === 'blocked') {
      severity = 'blocked'
      category = llmClassification.category as Category
    } else if (llmClassification.severity === 'warning') {
      severity = 'warning'
      category = llmClassification.category as Category
    }
  } else if (injection.isInjection) {
    // LLM unavailable + injection detected = conservative block
    severity = 'blocked'
    category = 'injection_detected'
  }

  // PII found is always at least a warning
  if (pii.hadPII && severity === 'safe') {
    severity = 'warning'
    category = 'pii_detected'
  }

  return {
    severity,
    category,
    originalIntent: injection.extractedIntent,
    redactedMessage: pii.redactedMessage,
    crisisResources: crisis.isCrisis ? crisis.resources : [],
    piiFound: pii.piiFound.map(p => p.type),
    processingTimeMs: Date.now() - start,
    stages: { pii, injection, llmClassification, crisis },
  }
}
