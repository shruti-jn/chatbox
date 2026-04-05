/**
 * AI Service: Streaming + Tool Use Orchestration
 *
 * Uses Vercel AI SDK with Anthropic provider.
 * Dynamic tool schema injection from enabled classroom apps.
 * Conservative routing: only invokes on clear explicit intent (CLR-004).
 * Context window management: app state > config > messages > schemas.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { streamText } from 'ai'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CoreTool = any
import type { AIConfig, GradeBand } from '@chatbridge/shared'
import { assembleSystemPrompt, loadPromptWithVars } from '../prompts/registry.js'
import { buildChessAnalysisPrompt } from './chess-analysis.js'
import pino from 'pino'

const logger = pino({ name: 'ai-service' })

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
})

export interface AIContext {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  classroomConfig: AIConfig
  gradeBand: GradeBand
  activeAppState: Record<string, unknown> | null
  activeAppName: string | null
  activeAppStatus?: 'active' | 'suspended' | null
  stateUpdatedAt?: Date | null
  enabledToolSchemas: Record<string, CoreTool>
  whisperGuidance: string | null
  asyncGuidance: string | null
  latestStudentMessage?: string | null
}

export function buildSystemPrompt(ctx: AIContext): string {
  const basePrompt = assembleSystemPrompt({
    classroomConfig: {
      mode: ctx.classroomConfig.mode,
      subject: ctx.classroomConfig.subject,
      tone: ctx.classroomConfig.tone,
      complexity: ctx.classroomConfig.complexity,
      asyncGuidance: ctx.asyncGuidance ?? undefined,
    },
    gradeBand: ctx.gradeBand,
    toolSchemas: Object.keys(ctx.enabledToolSchemas).map((name) => ({ name })),
    whisperGuidance: ctx.whisperGuidance,
    safetyInstructions: null,
    activeAppState: ctx.activeAppState,
    activeAppName: ctx.activeAppName,
    activeAppStatus: ctx.activeAppStatus,
    stateUpdatedAt: ctx.stateUpdatedAt,
  })

  const chessPrompt = buildChessAnalysisPrompt({
    appName: ctx.activeAppName,
    appState: ctx.activeAppState,
    gradeBand: ctx.gradeBand,
    studentQuestion: ctx.latestStudentMessage ?? ctx.messages.at(-1)?.content ?? null,
  })

  return chessPrompt ? `${basePrompt}\n\n${chessPrompt}` : basePrompt
}

export interface StreamResult {
  textStream: AsyncIterable<string>
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result?: unknown }>
  fullText: string
}

/**
 * Generate a streaming AI response with tool use
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generateResponse(ctx: AIContext, prebuiltSystemPrompt?: string): Promise<any> {
  const systemPrompt = prebuiltSystemPrompt ?? buildSystemPrompt(ctx)

  // Only pass tools to streamText if they are proper AI SDK tool definitions.
  // enabledToolSchemas may contain metadata-only entries ({ description }) for
  // prompt context — these are NOT valid AI SDK tools and should never be sent
  // to the Anthropic API. Tool invocation goes through /apps/:id/tools/:name/invoke.
  const hasValidTools = Object.keys(ctx.enabledToolSchemas).length > 0
    && Object.values(ctx.enabledToolSchemas).every(
      (t: any) => t && typeof t.parameters === 'object' && t.parameters.type
    )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamOptions: any = {
    model: anthropic('claude-haiku-4-5-20251001'),
    system: systemPrompt,
    messages: ctx.messages,
    ...(hasValidTools ? { tools: ctx.enabledToolSchemas, maxSteps: 3 } : {}),
    onStepFinish: ({ toolCalls }: { toolCalls?: Array<{ toolName: string }> }) => {
      // Log tool calls for observability
      if (toolCalls && toolCalls.length > 0) {
        logger.info({ tools: toolCalls.map(tc => tc.toolName) }, 'Tool calls invoked')
      }
    },
  }
  const result = streamText(streamOptions)

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
  // Check for terminal game state (checkmate, stalemate, game over)
  let terminalContext = ''
  if (appState.isGameOver || appState.isCheckmate || appState.isStalemate || appState.isDraw) {
    const reasons: string[] = []
    if (appState.isCheckmate) reasons.push('checkmate')
    if (appState.isStalemate) reasons.push('stalemate')
    if (appState.isDraw) reasons.push('draw')
    if (reasons.length === 0) reasons.push('game over')
    terminalContext = `\n\nIMPORTANT: The game is over (${reasons.join(', ')}). Acknowledge the result before providing any analysis.`
  }

  const result = await streamText({
    model: anthropic('claude-haiku-4-5-20251001'),
    system: loadPromptWithVars('app_analysis', 'v1', { appName, gradeBand }) + terminalContext,
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
