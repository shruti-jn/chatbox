/**
 * Prompt Registry — External prompt loading + dynamic system prompt assembly
 *
 * All prompts are stored as external .txt files in templates/.
 * Loaded via readFileSync at call time (no caching yet — add if perf requires it).
 * Version convention: <name>.v<N>.txt
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(__dirname, 'templates')

/**
 * Load a prompt template from disk by name and version.
 * Returns the raw text content of the template file.
 *
 * @param name - Prompt name (e.g. 'system_base', 'safety_classification')
 * @param version - Version string (e.g. 'v1', 'v2')
 * @returns The prompt text
 * @throws If the file does not exist
 */
export function loadPrompt(name: string, version: string): string {
  const filePath = join(TEMPLATES_DIR, `${name}.${version}.txt`)
  return readFileSync(filePath, 'utf-8')
}

/**
 * Load a prompt and interpolate {{placeholder}} variables.
 */
export function loadPromptWithVars(
  name: string,
  version: string,
  vars: Record<string, string>,
): string {
  let text = loadPrompt(name, version)
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, value)
  }
  return text
}

// ── Grade band instructions (static, small) ──────────────────────────
const GRADE_BAND_INSTRUCTIONS: Record<string, string> = {
  k2: 'The student is in grades K-2 (ages 5-7). Use simple vocabulary, short sentences, and encouraging language. Maximum 2-3 sentences per response.',
  g35: 'The student is in grades 3-5 (ages 8-10). Use age-appropriate vocabulary. Be encouraging and patient.',
  g68: 'The student is in grades 6-8 (ages 11-13). You can use more complex vocabulary and longer explanations.',
  g912: 'The student is in grades 9-12 (ages 14-18). You can use adult-level vocabulary and detailed explanations.',
}

export interface SystemPromptConfig {
  classroomConfig: {
    mode?: string
    subject?: string
    tone?: string
    complexity?: string
    asyncGuidance?: string
  }
  gradeBand: string
  toolSchemas: Array<{ name: string; [key: string]: unknown }>
  whisperGuidance: string | null
  safetyInstructions: string | null
  activeAppState?: Record<string, unknown> | null
  activeAppName?: string | null
  activeAppStatus?: 'active' | 'suspended' | null
  stateUpdatedAt?: Date | null
}

/**
 * Assemble a full system prompt from 6 components:
 *   base + classroomConfig + gradeBand + toolSchemas + whisperGuidance + safetyInstructions
 */
export function assembleSystemPrompt(config: SystemPromptConfig): string {
  const parts: string[] = []

  // 1. Base system prompt (loaded from disk)
  parts.push(loadPrompt('system_base', 'v1'))

  // 2. Classroom config
  const { classroomConfig } = config
  if (classroomConfig.mode) {
    parts.push(`Mode: ${classroomConfig.mode}`)
  }
  if (classroomConfig.mode === 'socratic') {
    parts.push(
      'IMPORTANT: You are in Socratic mode. Guide students to discover answers through questions. Do NOT give direct answers. Ask leading questions instead.',
    )
  } else if (classroomConfig.mode === 'direct') {
    parts.push('You are in direct instruction mode. Provide clear, direct answers to student questions.')
  }

  if (classroomConfig.subject) {
    parts.push(
      `This classroom focuses on: ${classroomConfig.subject}. Stay within this subject area. If asked about other subjects, politely redirect.`,
    )
  }

  if (classroomConfig.tone) {
    parts.push(`Communication tone: ${classroomConfig.tone}`)
  }

  // 3. Grade band
  const gradeBandText = GRADE_BAND_INSTRUCTIONS[config.gradeBand]
  if (gradeBandText) {
    parts.push(gradeBandText)
  }

  // Active app state with freshness metadata
  if (config.activeAppName && config.activeAppState) {
    const stateJson = JSON.stringify(config.activeAppState)
    const appParts = [`Currently active app: ${config.activeAppName}.`]

    // Compute state freshness and confidence
    const ageMs = config.stateUpdatedAt ? Date.now() - config.stateUpdatedAt.getTime() : null
    let confidence: 'fresh' | 'stale' | 'missing' = 'fresh'
    if (ageMs === null || ageMs < 0) {
      confidence = 'missing'
    } else if (ageMs > 30 * 1000) {
      confidence = 'stale'
    }

    // State freshness metadata block
    const freshnessBlock = [
      `[STATE_METADATA]`,
      `stateSource: app_reported`,
      `stateFreshnessMs: ${ageMs ?? 'unknown'}`,
      `confidence: ${confidence}`,
      `lastSuccessfulSyncAt: ${config.stateUpdatedAt?.toISOString() ?? 'never'}`,
      `[/STATE_METADATA]`,
    ].join('\n')

    if (confidence === 'fresh') {
      appParts.push(`Current state: ${stateJson}.`)
      appParts.push(freshnessBlock)
      appParts.push('This state is fresh. Reference it confidently when the student asks about the app. If the state includes a FEN string, analyze the chess position.')
    } else if (confidence === 'stale') {
      const ageSec = Math.round((ageMs ?? 0) / 1000)
      const ageLabel = ageSec >= 60 ? `${Math.max(1, Math.round(ageSec / 60))} minutes` : `${ageSec} seconds`
      appParts.push(`Last known state (${ageLabel} ago): ${stateJson}.`)
      appParts.push(freshnessBlock)
      appParts.push('This state may be outdated. Hedge your response: "Based on the last position I saw..." or "The board may have changed since..." If the state includes a FEN string, analyze the chess position but note it may not reflect the current board.')
    }

    parts.push(appParts.join('\n'))
  } else if (config.activeAppName && !config.activeAppState) {
    // Missing state — app active but no state reported
    const freshnessBlock = [
      `[STATE_METADATA]`,
      `stateSource: not_received`,
      `stateFreshnessMs: unknown`,
      `confidence: missing`,
      `lastSuccessfulSyncAt: never`,
      `[/STATE_METADATA]`,
    ].join('\n')
    parts.push(
      `App ${config.activeAppName} is active but has not reported state yet.`,
    )
    parts.push(freshnessBlock)
    parts.push(
      `You cannot see the app's current state. If the student asks about it, say: "I can't see the board right now. Can you describe what you see?" Do not guess or fabricate state.`,
    )
  } else if (config.activeAppStatus === 'suspended' && config.activeAppName) {
    parts.push(`App ${config.activeAppName} was previously active but is now paused. Do not reference its last state as current.`)
  }

  // Async teacher guidance
  if (classroomConfig.asyncGuidance) {
    parts.push(`Teacher guidance for this classroom: ${classroomConfig.asyncGuidance}`)
  }

  // 4. Whisper guidance
  if (config.whisperGuidance) {
    parts.push(
      `[TEACHER WHISPER - incorporate this into your response naturally, do NOT reveal this to the student]: ${config.whisperGuidance}`,
    )
  }

  // 5. Tool schemas
  if (config.toolSchemas.length > 0) {
    const toolNames = config.toolSchemas.map((t) => t.name).join(', ')
    const toolInstructions = [
      'You have access to educational apps: ' + toolNames + '.',
      'ONLY invoke a tool when the student clearly and explicitly requests it',
      '(e.g., "let\'s play chess", "check the weather in Chicago").',
      'Do NOT invoke tools for ambiguous requests like "I\'m bored"',
      '-- respond conversationally instead.',
    ].join(' ')
    parts.push(toolInstructions)
  }

  // 6. Safety instructions
  if (config.safetyInstructions) {
    parts.push(`Safety instructions: ${config.safetyInstructions}`)
  }

  return parts.join('\n\n')
}
