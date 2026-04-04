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
import { streamText, stepCountIs } from 'ai'
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
    preHandler: [authenticate, requireCoppaConsent],
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
    const user = getUser(request)

    // 1. Load full conversation context
    const ctx = await loadConversationContext(conversationId, user.districtId, user.role)

    if (!ctx.conversation) {
      return reply.status(404).send({ error: 'Conversation not found' })
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

    // 3. Save the student message to DB
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

    // 4. Resolve enabled tools
    const chatbridgeTools = resolveTools(ctx)

    // 5. Build AI SDK tools with server-side execute functions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aiTools: Record<string, any> = {}
    for (const cbTool of chatbridgeTools) {
      const meta = cbTool._appMeta
      const parsed = parseToolName(cbTool.name)

      aiTools[cbTool.name] = {
        description: cbTool.description,
        parameters: z.object({}),
        execute: async (args: Record<string, unknown>) => {
          if (!parsed) return { error: 'Invalid tool name' }

          // Find the app by ID
          const app = await prisma.app.findUnique({ where: { id: meta.appId } })
          if (!app) return { error: 'App not found' }

          // Create or find app instance
          let instance = await withTenantContext(user.districtId, async (tx) => {
            // Suspend currently active instances (single-active)
            await tx.appInstance.updateMany({
              where: { conversationId, status: 'active' },
              data: { status: 'suspended' },
            })

            return tx.appInstance.create({
              data: {
                appId: meta.appId,
                conversationId,
                districtId: user.districtId,
                status: 'loading',
              },
            })
          })

          // Execute the tool (mock path for now — same as generateToolResult)
          const toolResult = await executeAppTool(parsed.toolName, args)

          // Transition instance to active
          await withTenantContext(user.districtId, async (tx) => {
            await tx.appInstance.update({
              where: { id: instance.id },
              data: {
                status: 'active' as any,
                stateSnapshot: toolResult as any,
              },
            })
          })

          // Return result with __cbApp metadata for frontend rendering
          return {
            ...toolResult,
            __cbApp: {
              appId: meta.appId,
              appName: meta.appName,
              instanceId: instance.id,
              url: meta.uiManifestUrl,
              height: meta.uiManifestHeight,
            },
          }
        },
      }
    }

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
        .filter(m => m.content && m.content.length > 0)
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
    ]

    const systemPrompt = assembleSystemPrompt({
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

    // 7. Call Anthropic with tools via Vercel AI SDK
    const origin = request.headers.origin ?? '*'
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
    })

    try {
      const result = streamText({
        model: anthropic('claude-haiku-4-5-20251001'),
        system: systemPrompt,
        messages: allMessages,
        tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
        stopWhen: stepCountIs(4), // Up to 3 tool calls + 1 final response
      })

      // Stream the response back as SSE
      let fullText = ''
      const appCards: Array<Record<string, unknown>> = []

      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta') {
          fullText += chunk.text
          const event = `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: chunk.text },
          })}\n\n`
          reply.raw.write(event)
        } else if (chunk.type === 'tool-result') {
          // Tool was executed server-side. Check for __cbApp metadata.
          const toolResult = chunk.output as Record<string, unknown>
          if (toolResult?.__cbApp) {
            const appCard = toolResult.__cbApp as Record<string, unknown>
            appCards.push(appCard)

            // Emit custom app-card event
            const event = `event: chatbridge_app_card\ndata: ${JSON.stringify({
              type: 'app_card',
              ...appCard,
              status: 'active',
            })}\n\n`
            reply.raw.write(event)
          }
        }
      }

      // Final message stop event
      reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)

      // Save AI response to DB
      const guardrailResult = applyOutputGuardrails(fullText, {
        mode: ctx.aiConfig.mode,
        subject: ctx.aiConfig.subject,
      })

      const contentParts: any[] = [{ type: 'text', text: guardrailResult.text }]

      // Add app-card content parts
      for (const card of appCards) {
        contentParts.push({
          type: 'app_invocation',
          appName: card.appName,
          instanceId: card.instanceId,
          url: card.url,
        })
      }

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
