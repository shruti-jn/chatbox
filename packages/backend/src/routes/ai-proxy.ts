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

/**
 * Send a safety-blocked/crisis response in the correct format.
 * If the client requested streaming (stream: true), returns SSE events.
 * Otherwise returns a standard JSON message.
 */
function sendSafetyResponse(
  request: any,
  reply: any,
  body: Record<string, unknown> | undefined,
  msgId: string,
  text: string,
) {
  const model = (body?.model as string) ?? 'claude-haiku-4-5-20251001'
  const isStreaming = body?.stream === true

  if (isStreaming) {
    const origin = request.headers.origin ?? '*'
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
    })

    const events = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: text.length } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ]

    for (const event of events) {
      reply.raw.write(event)
    }
    reply.raw.end()
    return
  }

  // Non-streaming: return standard JSON
  return reply.status(200).send({
    id: msgId,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  })
}

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
            const blockedText = `⚠️ I wasn't able to process that message. It may have contained content that isn't appropriate for a learning environment. Could you try rephrasing your question?`
            return sendSafetyResponse(request, reply, body, 'msg_blocked', blockedText)
          }

          // Crisis — return resources
          if (safetyResult.severity === 'critical') {
            flushTraces().catch(() => {})
            const crisisText = `It sounds like you might be going through a difficult time. You're not alone, and there are people who can help:\n\n📞 **988 Suicide & Crisis Lifeline**: Call or text 988\n💬 **Crisis Text Line**: Text HOME to 741741\n📱 **SAMHSA National Helpline**: 1-800-662-4357\n\nPlease reach out to one of these resources. A caring person is ready to talk with you right now.`
            return sendSafetyResponse(request, reply, body, 'msg_crisis', crisisText)
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

    // Inject ChatBridge system prompt with app awareness
    if (body?.messages && Array.isArray(body.messages)) {
      const chatbridgeSystemPrompt = `You are a helpful AI assistant in the ChatBridge K-12 learning platform. You have access to these educational apps that students can use:

1. **Chess** - Interactive chess game. When a student wants to play chess, tell them the chess board is opening and include this exact markdown link: [🎮 Open Chess Board](http://localhost:3001/api/v1/apps/chess/ui/)

2. **Weather** - Weather dashboard. When a student asks about weather, tell them the weather dashboard is opening and include: [🌤️ Open Weather Dashboard](http://localhost:3001/api/v1/apps/weather/ui/?location=CITY) (replace CITY with the requested city)

3. **Spotify** - Playlist creator. When a student wants music, tell them about the Spotify integration and include: [🎵 Open Spotify Playlist Creator](http://localhost:3001/api/v1/apps/spotify/ui/?mock=playlist)

Always be helpful, educational, and age-appropriate. When a student clearly requests an app, respond with a brief message AND include the link to open it.`

      // Prepend as system message if not already present
      const msgs = body.messages as Array<{ role: string; content: string }>
      const hasSystem = msgs.some(m => m.role === 'system' && (m.content as string)?.includes('ChatBridge'))
      if (!hasSystem) {
        body.messages = [{ role: 'user', content: chatbridgeSystemPrompt }, { role: 'assistant', content: 'Understood! I\'m ready to help students learn. I\'ll suggest our apps when appropriate.' }, ...msgs]
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
