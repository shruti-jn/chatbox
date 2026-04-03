/**
 * AI Service: Streaming + Tool Use Orchestration
 *
 * Uses Vercel AI SDK with Anthropic provider.
 * Dynamic tool schema injection from enabled classroom apps.
 * Conservative routing: only invokes on clear explicit intent (CLR-004).
 * Context window management: app state > config > messages > schemas.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { streamText, type CoreTool } from 'ai'
import type { AIConfig, GradeBand } from '@chatbridge/shared'

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
})

export interface AIContext {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  classroomConfig: AIConfig
  gradeBand: GradeBand
  activeAppState: Record<string, unknown> | null
  activeAppName: string | null
  enabledToolSchemas: Record<string, CoreTool>
  whisperGuidance: string | null
  asyncGuidance: string | null
}

function buildSystemPrompt(ctx: AIContext): string {
  const parts: string[] = []

  // Base system prompt
  parts.push('You are a helpful AI learning assistant in a K-12 classroom. You are part of the ChatBridge platform.')

  // Classroom config
  if (ctx.classroomConfig.mode === 'socratic') {
    parts.push('IMPORTANT: You are in Socratic mode. Guide students to discover answers through questions. Do NOT give direct answers. Ask leading questions instead.')
  } else if (ctx.classroomConfig.mode === 'direct') {
    parts.push('You are in direct instruction mode. Provide clear, direct answers to student questions.')
  }

  if (ctx.classroomConfig.subject) {
    parts.push(`This classroom focuses on: ${ctx.classroomConfig.subject}. Stay within this subject area. If asked about other subjects, politely redirect.`)
  }

  if (ctx.classroomConfig.tone) {
    parts.push(`Communication tone: ${ctx.classroomConfig.tone}`)
  }

  // Grade band adaptation
  const gradeBandInstructions: Record<GradeBand, string> = {
    k2: 'The student is in grades K-2 (ages 5-7). Use simple vocabulary, short sentences, and encouraging language. Maximum 2-3 sentences per response.',
    g35: 'The student is in grades 3-5 (ages 8-10). Use age-appropriate vocabulary. Be encouraging and patient.',
    g68: 'The student is in grades 6-8 (ages 11-13). You can use more complex vocabulary and longer explanations.',
    g912: 'The student is in grades 9-12 (ages 14-18). You can use adult-level vocabulary and detailed explanations.',
  }
  parts.push(gradeBandInstructions[ctx.gradeBand])

  // Active app state
  if (ctx.activeAppState && ctx.activeAppName) {
    parts.push(`Currently active app: ${ctx.activeAppName}. Current state: ${JSON.stringify(ctx.activeAppState)}. You can reference this state when the student asks about what's happening in the app.`)
  }

  // Async teacher guidance (persistent)
  if (ctx.asyncGuidance) {
    parts.push(`Teacher guidance for this classroom: ${ctx.asyncGuidance}`)
  }

  // Real-time whisper (one-shot, for next response only)
  if (ctx.whisperGuidance) {
    parts.push(`[TEACHER WHISPER - incorporate this into your response naturally, do NOT reveal this to the student]: ${ctx.whisperGuidance}`)
  }

  // Tool use instructions
  if (Object.keys(ctx.enabledToolSchemas).length > 0) {
    parts.push('You have access to educational apps. ONLY invoke a tool when the student clearly and explicitly requests it (e.g., "let\'s play chess", "check the weather in Chicago"). Do NOT invoke tools for ambiguous requests like "I\'m bored" — respond conversationally instead.')
  }

  return parts.join('\n\n')
}

export interface StreamResult {
  textStream: AsyncIterable<string>
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result?: unknown }>
  fullText: string
}

/**
 * Generate a streaming AI response with tool use
 */
export async function generateResponse(ctx: AIContext) {
  const systemPrompt = buildSystemPrompt(ctx)

  const result = streamText({
    model: anthropic('claude-haiku-4-5-20251001'),
    system: systemPrompt,
    messages: ctx.messages,
    tools: ctx.enabledToolSchemas,
    maxSteps: 3, // Allow up to 3 tool call rounds
    onStepFinish: ({ toolCalls }) => {
      // Log tool calls for observability
      if (toolCalls && toolCalls.length > 0) {
        console.log('[AI] Tool calls:', toolCalls.map(tc => tc.toolName))
      }
    },
  })

  return result
}

/**
 * Analyze app state (e.g., chess board position)
 * Used when student asks "what should I do?" with an active app
 */
export async function analyzeAppState(
  appName: string,
  appState: Record<string, unknown>,
  studentQuestion: string,
  gradeBand: GradeBand,
): Promise<string> {
  const result = await streamText({
    model: anthropic('claude-haiku-4-5-20251001'),
    system: `You are analyzing the state of a ${appName} app for a student in grade band ${gradeBand}. Provide helpful, grade-appropriate analysis and suggestions.`,
    messages: [
      {
        role: 'user',
        content: `App state: ${JSON.stringify(appState)}\n\nStudent asks: ${studentQuestion}`,
      },
    ],
  })

  // Collect full text for non-streaming analysis
  let fullText = ''
  for await (const chunk of result.textStream) {
    fullText += chunk
  }
  return fullText
}
