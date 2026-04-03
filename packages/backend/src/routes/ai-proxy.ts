/**
 * AI Proxy — Transparent Anthropic API proxy with safety pipeline
 *
 * Chatbox sends requests in Anthropic API format to /api/v1/ai/proxy/v1/messages
 * This proxy:
 * 1. Extracts the user message
 * 2. Runs the 4-stage safety pipeline
 * 3. If safe, forwards to real Anthropic API
 * 4. Streams the response back to Chatbox
 * 5. Traces everything in Langfuse
 *
 * This is transparent to Chatbox — it thinks it's talking to Anthropic directly.
 */

import type { FastifyInstance } from 'fastify'
import { runSafetyPipeline } from '../safety/pipeline.js'
import { createTrace, createSafetySpan, createGeneration, endGeneration, flushTraces } from '../observability/langfuse.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com'

export async function aiProxyRoutes(server: FastifyInstance) {
  // Proxy all requests under /ai/proxy/* to Anthropic with safety interception
  server.all('/ai/proxy/*', async (request, reply) => {
    const path = (request.params as Record<string, string>)['*']
    // If path doesn't start with v1/, prepend it (Anthropic SDK sends /messages, we need /v1/messages)
    const normalizedPath = path.startsWith('v1/') ? path : `v1/${path}`
    const targetUrl = `${ANTHROPIC_API_URL}/${normalizedPath}`

    const body = request.body as Record<string, unknown> | undefined

    // Extract user message for safety check (if this is a messages request)
    if ((path === 'v1/messages' || path === 'messages') && body?.messages) {
      const messages = body.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')

      if (lastUserMsg) {
        const userText = typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : lastUserMsg.content?.find(c => c.type === 'text')?.text ?? ''

        if (userText) {
          // Create Langfuse trace
          const trace = createTrace('chatbridge_proxy', {
            userId: 'chatbox-user', // Pseudonymous
            sessionId: 'chatbox-session',
          })

          const safetySpan = createSafetySpan(trace, userText)

          // Run safety pipeline
          const safetyResult = await runSafetyPipeline(userText)

          if (safetySpan) {
            try {
              safetySpan.end({
                output: {
                  severity: safetyResult.severity,
                  category: safetyResult.category,
                  processingTimeMs: safetyResult.processingTimeMs,
                },
              })
            } catch {}
          }

          // Block dangerous content
          if (safetyResult.severity === 'blocked') {
            flushTraces().catch(() => {})
            return reply.status(200).send({
              id: 'msg_blocked',
              type: 'message',
              role: 'assistant',
              content: [{
                type: 'text',
                text: `⚠️ I wasn't able to process that message. It may have contained content that isn't appropriate for a learning environment. Could you try rephrasing your question?`,
              }],
              model: body.model ?? 'claude-haiku-4-5-20251001',
              stop_reason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
            })
          }

          // Crisis — return resources
          if (safetyResult.severity === 'critical') {
            flushTraces().catch(() => {})
            return reply.status(200).send({
              id: 'msg_crisis',
              type: 'message',
              role: 'assistant',
              content: [{
                type: 'text',
                text: `It sounds like you might be going through a difficult time. You're not alone, and there are people who can help:\n\n📞 **988 Suicide & Crisis Lifeline**: Call or text 988\n💬 **Crisis Text Line**: Text HOME to 741741\n📱 **SAMHSA National Helpline**: 1-800-662-4357\n\nPlease reach out to one of these resources. A caring person is ready to talk with you right now.`,
              }],
              model: body.model ?? 'claude-haiku-4-5-20251001',
              stop_reason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
            })
          }

          // PII detected — replace user message with redacted version
          if (safetyResult.redactedMessage !== userText) {
            if (typeof lastUserMsg.content === 'string') {
              lastUserMsg.content = safetyResult.redactedMessage
            } else if (Array.isArray(lastUserMsg.content)) {
              const textPart = lastUserMsg.content.find(c => c.type === 'text')
              if (textPart) textPart.text = safetyResult.redactedMessage
            }
          }

          // Log generation
          const gen = createGeneration(trace, 'anthropic_forward', {
            model: (body.model as string) ?? 'claude-haiku-4-5-20251001',
            messages: messages,
          })

          // Flush traces non-blocking
          flushTraces().catch(() => {})
        }
      }
    }

    // Forward to Anthropic
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': (request.headers['anthropic-version'] as string) ?? '2023-06-01',
    }

    // Pass through API key from request or use server's key
    const apiKey = (request.headers['x-api-key'] as string) ?? process.env.ANTHROPIC_API_KEY
    if (apiKey) {
      headers['x-api-key'] = apiKey
    }

    // Pass through auth token if present
    const authToken = request.headers['authorization'] as string
    if (authToken) {
      headers['authorization'] = authToken
    }

    // Forward any anthropic-beta headers
    const betaHeader = request.headers['anthropic-beta'] as string
    if (betaHeader) {
      headers['anthropic-beta'] = betaHeader
    }

    try {
      const response = await fetch(targetUrl, {
        method: request.method as string,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      })

      // Stream the response back
      const contentType = response.headers.get('content-type') ?? 'application/json'
      reply.header('content-type', contentType)
      reply.status(response.status)

      if (contentType.includes('text/event-stream')) {
        // Streaming response — pipe through
        const origin = request.headers.origin ?? '*'
        reply.raw.writeHead(response.status, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
        })

        const reader = response.body?.getReader()
        if (reader) {
          const decoder = new TextDecoder()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            reply.raw.write(decoder.decode(value, { stream: true }))
          }
        }
        reply.raw.end()
      } else {
        // Non-streaming — send complete response
        const responseBody = await response.text()
        return reply.send(responseBody)
      }
    } catch (err) {
      request.log.error(err, 'AI proxy forward failed')
      return reply.status(502).send({
        id: 'msg_error',
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'text',
          text: "I'm having trouble thinking right now. Please try again in a moment.",
        }],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    }
  })
}
