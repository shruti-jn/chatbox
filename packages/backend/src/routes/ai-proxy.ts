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
import { loadPrompt } from '../prompts/registry.js'
import { prisma } from '../middleware/rls.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com'

function getRequestBaseUrl(request: { protocol: string; headers: Record<string, unknown> }) {
  const forwardedProto = request.headers['x-forwarded-proto']
  const proto = typeof forwardedProto === 'string'
    ? forwardedProto.split(',')[0]?.trim()
    : request.protocol
  const host = String(request.headers.host ?? 'localhost:3001')
  return `${proto}://${host}`
}

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
    const requestBaseUrl = getRequestBaseUrl(request)
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
            const blockedText = loadPrompt('blocked_message', 'v1')
            return sendSafetyResponse(request, reply, body, 'msg_blocked', blockedText)
          }

          // Crisis — return resources
          if (safetyResult.severity === 'critical') {
            flushTraces().catch(() => {})
            const crisisText = loadPrompt('crisis_response', 'v1')
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

    // Inject ChatBridge context prompt with app awareness
    if (body?.messages && Array.isArray(body.messages)) {
      const chatbridgeSystemPrompt = loadPrompt('proxy_system', 'v2')

      // Prepend as system message if not already present
      const msgs = body.messages as Array<{ role: string; content: string }>
      const hasSystem = msgs.some(m => m.role === 'system' && (m.content as string)?.includes('ChatBridge'))
      if (!hasSystem) {
        body.messages = [{ role: 'user', content: chatbridgeSystemPrompt }, { role: 'assistant', content: 'Understood! I\'m ready to help students learn. I\'ll suggest our apps when appropriate.' }, ...msgs]
      }
    }

    // Inject ChatBridge app tools into the Anthropic request
    // The AI will receive real tool definitions and emit tool_use blocks
    if (body && (path === 'v1/messages' || path === 'messages')) {
      try {
        const approvedApps = await prisma.app.findMany({
          where: { reviewStatus: 'approved' },
          select: { name: true, toolDefinitions: true },
        })

        const tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> = []
        for (const app of approvedApps) {
          const defs = app.toolDefinitions as Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>
          if (!Array.isArray(defs)) continue
          for (const t of defs) {
            tools.push({
              name: `${app.name.toLowerCase().replace(/\s+/g, '_')}__${t.name}`,
              description: `[${app.name}] ${t.description}`,
              input_schema: t.inputSchema ?? { type: 'object', properties: {} },
            })
          }
        }

        // Deduplicate by tool name
        const uniqueTools = new Map<string, typeof tools[0]>()
        for (const t of tools) {
          if (!uniqueTools.has(t.name)) uniqueTools.set(t.name, t)
        }
        const dedupedTools = Array.from(uniqueTools.values())

        if (dedupedTools.length > 0 && !body.tools) {
          body.tools = dedupedTools
        }
      } catch (err) {
        request.log.warn(err, 'Failed to inject ChatBridge tools')
      }
    }

    // Forward to Anthropic
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': (request.headers['anthropic-version'] as string) ?? '2023-06-01',
    }

    // Pass through API key from request or use server's key
    // Always use the server's API key for Anthropic — frontend key is ignored.
    // This ensures the proxy works without requiring the frontend to have a key.
    const apiKey = process.env.ANTHROPIC_API_KEY ?? (request.headers['x-api-key'] as string)
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
      const isStreaming = body?.stream === true
      const injectedTools = body?.tools as Array<{ name: string }> | undefined

      // If tools were injected, make the FIRST call non-streaming so we can
      // detect tool_use and execute server-side before streaming the final response
      const firstCallBody = injectedTools?.length
        ? { ...body, stream: false }
        : body

      const response = await fetch(targetUrl, {
        method: request.method as string,
        headers,
        body: firstCallBody ? JSON.stringify(firstCallBody) : undefined,
      })

      // If we injected tools, check for tool_use in the response
      if (injectedTools?.length && response.ok) {
        const firstResult = await response.json() as {
          id: string; model: string; role: string; content: any[]; stop_reason: string; usage: any
        }

        const toolUse = firstResult.content?.find((c: any) => c.type === 'tool_use')

        if (toolUse) {
          // Execute the tool server-side
          request.log.info({ toolName: toolUse.name, toolId: toolUse.id }, 'Executing tool server-side')
          const toolResult = await executeProxyTool(toolUse.name, toolUse.input ?? {})

          // Make a second Anthropic call with the tool result
          const followUpMessages = [
            ...((body?.messages ?? []) as any[]),
            { role: 'assistant', content: firstResult.content },
            {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify({
                  ...toolResult.result,
                  _cbDirective: toolResult.__cbApp
                    ? (() => {
                        const url = toolResult.__cbApp.url as string
                        const fullUrl = url.startsWith('http') ? url : `${requestBaseUrl}${url}`
                        return `The app is now open. Include this exact markdown link in your response so the student can see it: [Open ${toolResult.__cbApp.appName}](${fullUrl})`
                      })()
                    : undefined,
                }),
              }],
            },
          ]

          const followUpBody = {
            ...body,
            messages: followUpMessages,
            // Keep streaming for the final response
          }

          const followUpResponse = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(followUpBody),
          })

          // If the original request was streaming, pipe the follow-up response
          const followUpContentType = followUpResponse.headers.get('content-type') ?? 'application/json'

          if (isStreaming && followUpContentType.includes('text/event-stream')) {
            const origin = request.headers.origin ?? '*'
            reply.raw.writeHead(followUpResponse.status, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
              'access-control-allow-origin': origin,
              'access-control-allow-credentials': 'true',
            })

            const reader = followUpResponse.body?.getReader()
            if (reader) {
              const decoder = new TextDecoder()
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                reply.raw.write(decoder.decode(value, { stream: true }))
              }
            }

            // Inject a deterministic app-card marker AFTER the AI response.
            // This is a standard Anthropic content_block with a hidden marker
            // that the frontend app-card-processor will detect and convert to
            // an inline iframe. The marker is always present when a tool executed.
            if (toolResult.__cbApp) {
              const cb = toolResult.__cbApp as Record<string, unknown>
              const url = (cb.url as string)?.startsWith('http') ? cb.url : `${requestBaseUrl}${cb.url}`
              const marker = `\n\n[Open ${cb.appName}](${url})`

              // Emit as a new content block in Anthropic SSE format
              const idx = 99 // high index to not conflict with existing blocks
              reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } })}\n\n`)
              reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: marker } })}\n\n`)
              reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`)
            }

            reply.raw.end()
            return
          } else {
            // Non-streaming follow-up
            const followUpText = await followUpResponse.text()
            return reply.status(followUpResponse.status).send(followUpText)
          }
        }

        // No tool_use — just return the first result as-is
        if (isStreaming) {
          // Client expected streaming but we made a non-streaming call.
          // Convert to SSE format.
          return sendSafetyResponse(request, reply, body, firstResult.id,
            firstResult.content?.find((c: any) => c.type === 'text')?.text ?? '')
        } else {
          return reply.status(response.status).send(JSON.stringify(firstResult))
        }
      }

      // No tools injected — original transparent proxy behavior
      const contentType = response.headers.get('content-type') ?? 'application/json'
      reply.header('content-type', contentType)
      reply.status(response.status)

      if (contentType.includes('text/event-stream')) {
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

/**
 * Execute a tool call server-side. Returns result + optional __cbApp metadata.
 */
async function executeProxyTool(
  namespacedName: string,
  input: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; __cbApp?: Record<string, unknown> }> {
  // Parse tool name: chess__start_game -> appName=chess, toolName=start_game
  const parts = namespacedName.split('__')
  const toolName = parts.length === 2 ? parts[1] : namespacedName

  // Look up the app — prefer exact name match, fall back to contains
  const appName = parts.length === 2 ? parts[0] : ''
  let app = await prisma.app.findFirst({
    where: { name: { equals: appName, mode: 'insensitive' }, reviewStatus: 'approved' },
    select: { id: true, name: true, uiManifest: true },
  })
  if (!app) {
    app = await prisma.app.findFirst({
      where: { name: { contains: appName, mode: 'insensitive' }, reviewStatus: 'approved' },
      select: { id: true, name: true, uiManifest: true },
    })
  }

  // Execute the tool (mock for now — same as generateToolResult)
  let result: Record<string, unknown>
  switch (toolName) {
    case 'start_game':
      result = {
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        status: 'new_game',
        message: 'Chess game started! White to move.',
      }
      break
    case 'make_move':
      result = {
        fen: input.fen ?? 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        status: 'move_made',
        message: `Move ${input.move ?? 'e4'} played.`,
      }
      break
    case 'get_legal_moves':
      result = {
        fen: input.fen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: ['a3', 'a4', 'b3', 'b4', 'c3', 'c4', 'd3', 'd4', 'e3', 'e4',
                'f3', 'f4', 'g3', 'g4', 'h3', 'h4', 'Na3', 'Nc3', 'Nf3', 'Nh3'],
      }
      break
    default:
      result = { status: 'ok', toolName }
  }

  // Build __cbApp metadata if we found the app
  const uiManifest = app?.uiManifest as { url?: string; height?: number } | null
  const cbApp = app ? {
    appId: app.id,
    appName: app.name,
    url: uiManifest?.url ?? `/api/v1/apps/${appName}/ui/`,
    height: uiManifest?.height ?? 500,
  } : undefined

  return { result, __cbApp: cbApp }
}
