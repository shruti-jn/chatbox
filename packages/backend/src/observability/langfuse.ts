/**
 * Langfuse Observability Integration
 *
 * Traces every LLM call with:
 * - prompt, response, latency, tokens, cost, model
 * - tool calls, guardrail results
 * - Pseudonymous user context (NO PII)
 * - Parent-child spans
 *
 * NEVER blocks user-facing requests on observability failures
 */

import { Langfuse } from 'langfuse'

let langfuse: Langfuse | null = null

export function initLangfuse() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  const baseUrl = process.env.LANGFUSE_BASE_URL

  if (!publicKey || !secretKey) {
    console.warn('[Langfuse] Not configured — traces will be skipped')
    return
  }

  langfuse = new Langfuse({
    publicKey,
    secretKey,
    baseUrl: baseUrl ?? 'https://us.cloud.langfuse.com',
  })

  console.log('[Langfuse] Initialized')
}

export interface TraceContext {
  userId: string // Pseudonymous — never PII
  sessionId: string
  conversationId?: string
  classroomId?: string
  districtId?: string
}

/**
 * Create a trace for a conversation turn
 */
export function createTrace(name: string, ctx: TraceContext) {
  if (!langfuse) return null

  try {
    return langfuse.trace({
      name,
      userId: ctx.userId, // Pseudonymous UUID, not student name
      sessionId: ctx.sessionId,
      metadata: {
        conversationId: ctx.conversationId,
        classroomId: ctx.classroomId,
        districtId: ctx.districtId,
      },
    })
  } catch (err) {
    // Never block on observability
    console.error('[Langfuse] Failed to create trace:', err)
    return null
  }
}

/**
 * Create a generation span for an LLM call
 */
export function createGeneration(
  trace: ReturnType<typeof createTrace>,
  name: string,
  input: { model: string; messages: unknown[]; tools?: unknown[] },
) {
  if (!trace) return null

  try {
    return trace.generation({
      name,
      model: input.model,
      input: input.messages,
      metadata: {
        toolCount: input.tools?.length ?? 0,
      },
    })
  } catch {
    return null
  }
}

/**
 * End a generation span with output
 */
export function endGeneration(
  generation: ReturnType<typeof createGeneration>,
  output: {
    response: string
    tokenUsage?: { input: number; output: number }
    toolCalls?: Array<{ name: string; args: unknown }>
    guardrailResult?: { severity: string; category: string }
  },
) {
  if (!generation) return

  try {
    generation.end({
      output: output.response,
      usage: output.tokenUsage
        ? { input: output.tokenUsage.input, output: output.tokenUsage.output }
        : undefined,
      metadata: {
        toolCalls: output.toolCalls,
        guardrailResult: output.guardrailResult,
      },
    })
  } catch {
    // Never block
  }
}

/**
 * Create a span for safety pipeline
 */
export function createSafetySpan(
  trace: ReturnType<typeof createTrace>,
  input: string,
) {
  if (!trace) return null

  try {
    return trace.span({
      name: 'safety_pipeline',
      input: { messageLength: input.length }, // Don't log actual content
    })
  } catch {
    return null
  }
}

/**
 * Flush traces (call before shutdown)
 */
export async function flushTraces() {
  if (!langfuse) return
  try {
    await langfuse.flushAsync()
  } catch {
    // Best effort
  }
}

export function getLangfuse() {
  return langfuse
}
