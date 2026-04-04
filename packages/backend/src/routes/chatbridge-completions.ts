/**
 * ChatBridge Native Completions Endpoint
 *
 * POST /api/v1/chatbridge/completions
 *
 * Backend-owned AI generation with server-side tool execution.
 * The frontend sends conversationId + messages. The backend:
 * 1. Loads conversation context (classroom, config, app state)
 * 2. Resolves enabled tools from classroom config
 * 3. Runs safety pipeline
 * 4. Calls Anthropic with real tool definitions
 * 5. Executes tool calls server-side
 * 6. Streams response back as SSE
 *
 * This replaces the transparent /ai/proxy for ChatBridge sessions.
 */

import type { FastifyInstance } from 'fastify'
import { createAnthropic } from '@ai-sdk/anthropic'
import { streamText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { authenticate, getUser } from '../middleware/auth.js'
import { requireCoppaConsent } from '../middleware/coppa.js'
import { withTenantContext, prisma } from '../middleware/rls.js'
import { runSafetyPipeline } from '../safety/pipeline.js'
import { applyOutputGuardrails } from '../safety/output-guardrail.js'
import { loadConversationContext } from '../ai/context-builder.js'
import { resolveTools, findToolMeta, parseToolName } from '../ai/tool-registry.js'
import { assembleSystemPrompt } from '../prompts/registry.js'
import { transition, type AppState } from '../apps/index.js'
import { createTrace, createSafetySpan, createGeneration, endGeneration, flushTraces } from '../observability/langfuse.js'

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
})

export async function chatbridgeCompletionsRoutes(server: FastifyInstance) {
  server.post('/chatbridge/completions', {
    // TODO: Add proper auth for ChatBridge native endpoint
    // Currently no auth — the Chatbox frontend can't provide JWT
    // preHandler: [authenticate, requireCoppaConsent],
    schema: {
      body: {
        type: 'object',
        required: ['conversationId', 'messages'],
        properties: {
          conversationId: { type: 'string' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { conversationId, messages } = request.body as {
      conversationId: string
      messages: Array<{ role: string; content: string }>
    }
    // Try to get authenticated user; fall back to default for development
    let user: { userId: string; districtId: string; role: string }
    try {
      user = getUser(request)
    } catch {
      // No auth — use default district for development
      user = { userId: 'anonymous', districtId: '00000000-0000-4000-a000-000000000001', role: 'student' }
    }

    // 1. Load full conversation context
    const ctx = await loadConversationContext(conversationId, user.districtId, user.role)

    // If conversation not found in DB, use a minimal context
    // (Chatbox sessions don't always have a backend conversation)
    if (!ctx.conversation) {
      // Still proceed — load tools from all approved apps
      ctx.enabledApps = await prisma.app.findMany({
        where: { reviewStatus: 'approved' },
        select: { id: true, name: true, toolDefinitions: true, uiManifest: true, reviewStatus: true },
      }).then(apps => apps.map(app => ({ appId: app.id, app: app as any })))
    }

    // 2. Safety pipeline on the latest user message
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    if (lastUserMsg) {
      const safetyResult = await runSafetyPipeline(lastUserMsg.content)

      if (safetyResult.severity === 'blocked') {
        return reply.status(422).send({
          error: 'Message could not be processed',
          category: safetyResult.category,
        })
      }

      if (safetyResult.severity === 'critical') {
        return reply.status(200).send({
          type: 'crisis',
          severity: 'critical',
          crisisResources: safetyResult.crisisResources,
          message: "It sounds like you might be going through a difficult time. Here are some resources that can help:",
        })
      }

      // Replace user message with redacted version if PII found
      if (safetyResult.redactedMessage !== lastUserMsg.content) {
        lastUserMsg.content = safetyResult.redactedMessage
      }
    }

    // 3. Save the student message to DB (only if conversation exists)
    if (ctx.conversation) {
      await withTenantContext(user.districtId, async (tx) => {
        await tx.message.create({
          data: {
            conversationId,
            districtId: user.districtId,
            authorRole: 'student',
            contentParts: [{ type: 'text', text: lastUserMsg?.content ?? '' }],
          },
        })
      })
    }

    // 4. Resolve enabled tools
    const chatbridgeTools = resolveTools(ctx)

    // 5. Tools are passed as raw Anthropic format in step 7 (direct fetch)
    // The AI SDK tool() helper has Zod schema compatibility issues with Anthropic

    // 6. Build message history
    const aiMessages = ctx.recentMessages
      .reverse()
      .map(m => ({
        role: m.authorRole === 'student' ? 'user' as const : 'assistant' as const,
        content: (m.contentParts as any[])?.[0]?.text ?? '',
      }))
      .filter(m => m.content.length > 0) // Anthropic rejects empty content blocks

    // Add the new messages from the request
    const allMessages = [
      ...aiMessages,
      ...messages
        .filter(m => m.content && m.content.length > 0 && m.role !== 'system')
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
    ]

    let systemPrompt = assembleSystemPrompt({
      classroomConfig: ctx.aiConfig,
      gradeBand: ctx.gradeBand as any,
      toolSchemas: chatbridgeTools.map(t => ({ name: t.name })),
      whisperGuidance: ctx.whisperGuidance,
      safetyInstructions: null,
      activeAppState: ctx.activeAppInstance?.status === 'active'
        ? (ctx.activeAppInstance.stateSnapshot as Record<string, unknown> | null)
        : null,
      activeAppName: ctx.activeAppInstance?.status === 'active'
        ? ctx.activeAppInstance.app.name
        : null,
      activeAppStatus: (ctx.activeAppInstance?.status as any) ?? null,
      stateUpdatedAt: ctx.activeAppInstance?.updatedAt ?? null,
    })

    // Tool-use directive: when tools are available, the AI must use them for app requests
    if (chatbridgeTools.length > 0) {
      systemPrompt += '\n\nIMPORTANT: You have tools for interactive apps. When a student explicitly requests an app (e.g., "let\'s play chess", "open the chess board", "start a game"), you MUST call the appropriate tool. Do not just describe the app or give instructions — call the tool so the app opens inline. Available tools: ' + chatbridgeTools.map(t => t.name).join(', ') + '.'
    }

    // 7. Call Anthropic with tools via Vercel AI SDK
    const origin = request.headers.origin ?? '*'
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
    })

    let fullText = ''
    const appCards: Array<Record<string, unknown>> = []

    try {
      // Build raw Anthropic tools (bypass AI SDK tool() which has schema issues)
      const rawTools = chatbridgeTools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema.type ? t.input_schema : { type: 'object', properties: {} },
      }))

      // Deduplicate tools by name
      const uniqueTools = new Map<string, typeof rawTools[0]>()
      for (const t of rawTools) {
        if (!uniqueTools.has(t.name)) uniqueTools.set(t.name, t)
      }
      const dedupedTools = Array.from(uniqueTools.values())

      request.log.info({ toolCount: dedupedTools.length, toolNames: dedupedTools.map(t => t.name) }, 'ChatBridge tools resolved')

      // Call Anthropic directly for the first request (non-streaming to detect tool_use)
      const apiKey = process.env.ANTHROPIC_API_KEY ?? ''
      const firstResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          messages: allMessages,
          ...(dedupedTools.length > 0 ? { tools: dedupedTools } : {}),
        }),
      })

      const firstResult = await firstResponse.json() as any

      if (!firstResponse.ok) {
        request.log.error({ error: firstResult }, 'Anthropic API error')
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: firstResult.error?.message ?? 'API error' })}\n\n`)
        reply.raw.end()
        return
      }

      // Check for tool_use
      const toolUse = firstResult.content?.find((c: any) => c.type === 'tool_use')
      let finalMessages = allMessages
      let streamBody: any = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: allMessages,
        stream: true,
      }

      if (toolUse) {
        // Execute tool server-side
        request.log.info({ toolName: toolUse.name }, 'Executing tool')
        const parsed = parseToolName(toolUse.name)
        const toolResult = parsed ? await executeAppTool(parsed.toolName, toolUse.input ?? {}) : { status: 'unknown' }

        // Find app metadata
        const meta = findToolMeta(chatbridgeTools, toolUse.name)

        // Build follow-up with tool result
        streamBody = {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [
            ...allMessages,
            { role: 'assistant', content: firstResult.content },
            {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify({
                  ...toolResult,
                  _instructions: meta
                    ? `The app is now open. Include this markdown link: [Open ${meta.appName}](http://localhost:3001${meta.uiManifestUrl})`
                    : undefined,
                }),
              }],
            },
          ],
          stream: true,
        }

        // Emit app card event
        if (meta) {
          const url = meta.uiManifestUrl.startsWith('http') ? meta.uiManifestUrl : `http://localhost:3001${meta.uiManifestUrl}`
          appCards.push({
            appId: meta.appId,
            appName: meta.appName,
            url,
            height: meta.uiManifestHeight,
            status: 'active',
          })
        }
      }

      // Stream the final response
      const streamResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(streamBody),
      })

      const reader = streamResponse.body?.getReader()
      if (reader) {
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          reply.raw.write(chunk)

          // Extract text for DB save
          const lines = chunk.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                if (data.delta?.type === 'text_delta') {
                  fullText += data.delta.text
                }
              } catch {}
            }
          }
        }
      }

      // (Old SDK streaming loop removed — now using direct Anthropic fetch above)

      // Save AI response to DB
      const guardrailResult = applyOutputGuardrails(fullText, {
        mode: ctx.aiConfig.mode,
        subject: ctx.aiConfig.subject,
      })

      const contentParts: any[] = [{ type: 'text', text: guardrailResult.text }]

      // Add app-card content parts
      for (const card of appCards) {
        contentParts.push({
          type: 'app-card',
          appId: card.appId,
          appName: card.appName,
          instanceId: card.instanceId,
          status: card.status ?? 'active',
          url: card.url,
          height: card.height,
          summary: card.summary,
          stateSnapshot: card.stateSnapshot,
        })
      }

      if (ctx.conversation) {
        await withTenantContext(user.districtId, async (tx) => {
          await tx.message.create({
            data: {
              conversationId,
              districtId: user.districtId,
              authorRole: 'assistant',
              contentParts,
            },
          })
        })
      }

      flushTraces().catch(() => {})
      reply.raw.end()
    } catch (err) {
      request.log.error(err, 'ChatBridge completions failed')
      const errorEvent = `event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: "I'm having trouble thinking right now. Please try again.",
      })}\n\n`
      reply.raw.write(errorEvent)
      reply.raw.end()
    }
  })
}

/**
 * Execute an app tool server-side.
 * This is the same mock handler as generateToolResult in apps.ts.
 * In production, this would dispatch via CBP Redis.
 */
async function executeAppTool(
  toolName: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case 'start_game':
      return {
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        status: 'new_game',
        message: 'Chess game started! White to move.',
      }
    case 'make_move':
      return {
        fen: params.fen ?? 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        status: 'move_made',
        message: `Move ${params.move ?? 'e4'} played.`,
      }
    case 'get_legal_moves':
      return {
        fen: params.fen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: ['a3', 'a4', 'b3', 'b4', 'c3', 'c4', 'd3', 'd4', 'e3', 'e4',
                'f3', 'f4', 'g3', 'g4', 'h3', 'h4', 'Na3', 'Nc3', 'Nf3', 'Nh3'],
      }
    case 'get_weather':
      return { temperature: 72, conditions: 'Partly cloudy', location: params.location ?? 'New York' }
    case 'search_tracks':
      return { tracks: [{ name: 'Lo-fi Study Beats', artist: 'ChillHop' }], mock: true }
    default:
      return { status: 'ok', toolName }
  }
}
