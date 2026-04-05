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
import pino from 'pino'

const logger = pino({ name: 'langfuse' })

// PII patterns — order matters: SSN before phone (SSN is more specific)
const SSN_PATTERN = /\d{3}-\d{2}-\d{4}/g
const EMAIL_PATTERN = /\S+@\S+\.\S+/g
const PHONE_PATTERN = /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/g

/**
 * Scrub PII from a string, replacing emails, SSNs, and phone numbers with [REDACTED].
 */
function scrubPii(text: string): string {
  return text
    .replace(SSN_PATTERN, '[REDACTED]')
    .replace(EMAIL_PATTERN, '[REDACTED]')
    .replace(PHONE_PATTERN, '[REDACTED]')
}

/**
 * Deep-scrub PII from message objects before sending to Langfuse.
 * Handles string content and nested {role, content} message shapes.
 */
function scrubMessages(messages: unknown[]): unknown[] {
  return messages.map((msg) => {
    if (typeof msg === 'string') return scrubPii(msg)
    if (msg && typeof msg === 'object') {
      const record = msg as Record<string, unknown>
      const scrubbed: Record<string, unknown> = { ...record }
      if (typeof scrubbed.content === 'string') {
        scrubbed.content = scrubPii(scrubbed.content)
      }
      return scrubbed
    }
    return msg
  })
}

let langfuse: Langfuse | null = null

export function initLangfuse() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  const baseUrl = process.env.LANGFUSE_BASE_URL

  if (!publicKey || !secretKey) {
    console.warn('[Langfuse] Not configured — traces will be skipped')
    return
  }

  try {
    langfuse = new Langfuse({
      publicKey,
      secretKey,
      baseUrl: baseUrl ?? 'https://us.cloud.langfuse.com',
    })

    // Catch SDK-level errors (network failures, flush errors) so they
    // never bubble as unhandled rejections and never crash the server.
    langfuse.on('error', (err) => {
      logger.warn({ err: err?.message ?? err }, 'Langfuse SDK error (non-fatal)')
    })

    logger.info('Langfuse initialized')
  } catch (err) {
    logger.warn({ err }, 'Langfuse failed to initialize — traces will be skipped')
    langfuse = null
  }
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

  // Block PII in userId — must be pseudonymous (e.g. UUID), never an email
  if (ctx.userId && ctx.userId.includes('@')) {
    console.error('[Langfuse] Rejected trace: userId contains email (PII)')
    return null
  }

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
  input: { model: string; messages: unknown[]; tools?: unknown[]; systemPrompt?: string },
) {
  if (!trace) return null

  try {
    return trace.generation({
      name,
      model: input.model,
      input: scrubMessages(input.messages),
      metadata: {
        toolCount: input.tools?.length ?? 0,
        systemPrompt: input.systemPrompt ? scrubPii(input.systemPrompt) : undefined,
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
      output: scrubPii(output.response),
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
 * Flush traces (call before shutdown).
 * Times out after 3 seconds — never blocks server shutdown if Langfuse is unreachable.
 */
export async function flushTraces() {
  if (!langfuse) return
  try {
    await Promise.race([
      langfuse.flushAsync(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
  } catch {
    // Best effort — observability must never block
  }
}

/**
 * Graceful shutdown: flush pending traces and release the Langfuse client.
 * Safe to call even if Langfuse was never initialized or is unreachable.
 */
export async function shutdownLangfuse() {
  if (!langfuse) return
  try {
    await flushTraces()
    await langfuse.shutdownAsync()
  } catch {
    // Best effort
  } finally {
    langfuse = null
  }
}

export function getLangfuse() {
  return langfuse
}
