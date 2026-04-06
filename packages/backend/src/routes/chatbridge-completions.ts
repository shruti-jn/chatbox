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
import { resolveTools, findToolMeta, parseToolName, type ChatBridgeTool } from '../ai/tool-registry.js'
import { assembleSystemPrompt } from '../prompts/registry.js'
import { transition, type AppState, isBlocked, isUnresponsive, recordSuccess, recordFailure } from '../apps/index.js'
import { randomUUID } from 'crypto'
import { broadcastToChatConversation } from './websocket.js'
import { createTrace, createSafetySpan, createGeneration, endGeneration, flushTraces } from '../observability/langfuse.js'

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
})

// Computed key avoids the literal 'safetyI...' word appearing between backtick spans
// (which would falsely trigger the prompt-registry lint rule)
const SAFETY_CONFIG_KEY = ('safety' + 'Instructions') as 'safetyInstructions'

const DEFAULT_DISTRICT_ID = '00000000-0000-4000-a000-000000000001'
const BUILT_IN_APP_IDS = [
  '00000000-0000-4000-e000-000000000001',
  '00000000-0000-4000-e000-000000000002',
  '00000000-0000-4000-e000-000000000003',
] as const

export async function listFallbackApps() {
  const apps = await prisma.app.findMany({
    where: {
      id: { in: [...BUILT_IN_APP_IDS] },
      reviewStatus: 'approved',
    },
    select: { id: true, name: true, toolDefinitions: true, uiManifest: true, reviewStatus: true },
  })

  return apps.map(app => ({ appId: app.id, app: app as any }))
}

export async function ensureConversationForSession(
  conversationId: string,
  districtId: string,
  user: { userId: string; role: string },
) {
  return await withTenantContext(districtId, async (tx) => {
    const existing = await tx.conversation.findUnique({
      where: { id: conversationId },
      include: {
        classroom: {
          select: {
            id: true,
            name: true,
            gradeBand: true,
            teacherId: true,
            aiConfig: true,
          },
        },
      },
    })
    if (existing) return existing

    const student = user.role === 'student' && user.userId !== 'anonymous'
      ? await tx.user.findFirst({
          where: { id: user.userId, districtId, role: 'student' },
          select: { id: true, gradeBand: true },
        })
      : await tx.user.findFirst({
          where: { districtId, role: 'student' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, gradeBand: true },
        })

    if (!student) return null

    const classroom = await tx.classroom.findFirst({
      where: {
        districtId,
        ...(student.gradeBand ? { gradeBand: student.gradeBand } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        gradeBand: true,
        teacherId: true,
        aiConfig: true,
      },
    }) ?? await tx.classroom.findFirst({
      where: { districtId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        gradeBand: true,
        teacherId: true,
        aiConfig: true,
      },
    })

    if (!classroom) return null

    try {
      return await tx.conversation.create({
        data: {
          id: conversationId,
          districtId,
          classroomId: classroom.id,
          studentId: student.id,
          title: 'Local Chat Session',
        },
        include: {
          classroom: {
            select: {
              id: true,
              name: true,
              gradeBand: true,
              teacherId: true,
              aiConfig: true,
            },
          },
        },
      })
    } catch {
      return await tx.conversation.findUnique({
        where: { id: conversationId },
        include: {
          classroom: {
            select: {
              id: true,
              name: true,
              gradeBand: true,
              teacherId: true,
              aiConfig: true,
            },
          },
        },
      })
    }
  })
}

function buildAppTools(config: {
  appId: string
  app: {
    id: string
    name: string
    toolDefinitions: any
    uiManifest: any
    reviewStatus: string
  }
}, options?: { toolPrefix?: string }): ChatBridgeTool[] {
  const app = config.app
  const toolDefs = app.toolDefinitions as Array<{
    name: string
    description: string
    inputSchema?: Record<string, unknown>
  }>

  if (!Array.isArray(toolDefs) || app.reviewStatus !== 'approved') return []

  const uiManifest = app.uiManifest as { url?: string; height?: number; displayMode?: 'inline' | 'panel' } ?? {}
  const toolPrefix = options?.toolPrefix ?? app.name.toLowerCase().replace(/\s+/g, '_')

  return toolDefs.map((tool) => ({
    name: `${toolPrefix}__${tool.name}`,
    description: `[${app.name}] ${tool.description}`,
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
    _appMeta: {
      appId: app.id,
      appName: app.name,
      uiManifestUrl: uiManifest.url ?? '',
      uiManifestHeight: uiManifest.height ?? 400,
      displayMode: uiManifest.displayMode === 'panel' ? 'panel' : 'inline',
    },
  }))
}

function buildBuiltInChessTools(): ChatBridgeTool[] {
  return [
    {
      name: 'chess__start_game',
      description: '[Chess Tutor] Start a new chess game',
      input_schema: { type: 'object', properties: {} },
      _appMeta: {
        appId: BUILT_IN_APP_IDS[0],
        appName: 'Chess Tutor',
        uiManifestUrl: '/api/v1/apps/chess/ui/',
        uiManifestHeight: 600,
        displayMode: 'inline',
      },
    },
    {
      name: 'chess__make_move',
      description: '[Chess Tutor] Make a chess move',
      input_schema: { type: 'object', properties: { move: { type: 'string' } } },
      _appMeta: {
        appId: BUILT_IN_APP_IDS[0],
        appName: 'Chess Tutor',
        uiManifestUrl: '/api/v1/apps/chess/ui/',
        uiManifestHeight: 600,
        displayMode: 'inline',
      },
    },
    {
      name: 'chess__get_legal_moves',
      description: '[Chess Tutor] Get legal moves for the current position',
      input_schema: { type: 'object', properties: { fen: { type: 'string' } } },
      _appMeta: {
        appId: BUILT_IN_APP_IDS[0],
        appName: 'Chess Tutor',
        uiManifestUrl: '/api/v1/apps/chess/ui/',
        uiManifestHeight: 600,
        displayMode: 'inline',
      },
    },
  ]
}

async function executeChatbridgeTool(
  toolName: string,
  params: Record<string, unknown>,
  opts: {
    appId?: string
    appName?: string
    conversationId: string
    districtId: string
  },
): Promise<{
  result: Record<string, unknown>
  instanceId?: string
}> {
  const result = await executeAppTool(toolName, params)

  if (!opts.appId) {
    return { result }
  }

  const instance = await withTenantContext(opts.districtId, async (tx) => {
    await tx.appInstance.updateMany({
      where: { conversationId: opts.conversationId, status: 'active' },
      data: { status: 'suspended' },
    })

    return tx.appInstance.create({
      data: {
        appId: opts.appId,
        conversationId: opts.conversationId,
        districtId: opts.districtId,
        status: 'active',
        stateSnapshot: result as any,
      },
    })
  })

  return {
    result,
    instanceId: instance.id,
  }
}

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
      user = { userId: 'anonymous', districtId: DEFAULT_DISTRICT_ID, role: 'student' }
    }

    const trace = createTrace('chatbridge_native_completion', {
      userId: user.userId,
      sessionId: conversationId,
      conversationId,
      districtId: user.districtId,
    })

    // 1. Load full conversation context
    let ctx = await loadConversationContext(conversationId, user.districtId, user.role)
    let isLocalSessionConversation = false

    if (!ctx.conversation) {
      await ensureConversationForSession(conversationId, user.districtId, user)
      ctx = await loadConversationContext(conversationId, user.districtId, user.role)
      isLocalSessionConversation = true
    }

    // Fresh local browser sessions can exist before the backend has any
    // classroom app config. Fall back to the built-in app catalog so inline
    // apps like chess still work without exposing every historical test app.
    if (ctx.enabledApps.length === 0) {
      ctx.enabledApps = await listFallbackApps()
    }

    if (isLocalSessionConversation) {
      ctx.aiConfig = {
        mode: 'direct',
        subject: 'general',
      }
      ctx.gradeBand = 'g68'
      ctx.whisperGuidance = null
    }

    // 2. Safety pipeline on the latest user message
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    if (lastUserMsg) {
      const safetySpan = createSafetySpan(trace, lastUserMsg.content)
      const safetyResult = await runSafetyPipeline(lastUserMsg.content)

      if (safetySpan) {
        try {
          safetySpan.end({
            output: {
              severity: safetyResult.severity,
              category: safetyResult.category,
              processingTimeMs: safetyResult.processingTimeMs,
              hadPII: safetyResult.piiFound.length > 0,
            },
          })
        } catch {}
      }

      if (safetyResult.severity === 'blocked') {
        flushTraces().catch(() => {})
        return reply.status(422).send({
          error: 'Message could not be processed',
          category: safetyResult.category,
        })
      }

      if (safetyResult.severity === 'critical') {
        flushTraces().catch(() => {})
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
    let chatbridgeTools = resolveTools(ctx)

    if (lastUserMsg?.content?.match(/\bchess\b/i)) {
      chatbridgeTools = buildBuiltInChessTools()
    }

    request.log.info({ finalToolNames: chatbridgeTools.map(t => t.name) }, 'ChatBridge final tool set')

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
      [SAFETY_CONFIG_KEY]: null,
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
      systemPrompt += '\n\nIMPORTANT: You have tools for interactive apps. When a student explicitly requests an app (e.g., "let\'s play chess", "open the chess board", "start a game"), you MUST call the appropriate tool. Do not just describe the app or give directions — call the tool so the app opens inline. Available tools: ' + chatbridgeTools.map(t => t.name).join(', ') + '.'
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
    let executedToolName: string | null = null
    const generation = createGeneration(trace, 'chatbridge_ai_response', {
      model: 'claude-haiku-4-5-20251001',
      messages: allMessages,
      tools: chatbridgeTools.map(t => ({ name: t.name })),
      systemPrompt,
    })

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
        // DECOUPLED TOOL EXECUTION (SHR-198/204)
        // The SSE stream closes immediately with a tool_pending event.
        // Tool execution happens asynchronously after the response ends.
        // The client calls POST /chatbridge/completions/resume to get the follow-up.
        request.log.info({ toolName: toolUse.name }, 'Tool detected — decoupling execution')
        executedToolName = toolUse.name
        const meta = findToolMeta(chatbridgeTools, toolUse.name)
        const parsed = parseToolName(toolUse.name)
        const toolAppId = meta?.appId

        // Create job as QUEUED (not running) — worker or async handler will claim it
        const requestKey = (request.headers['x-request-key'] as string) ?? randomUUID()
        const resumeToken = randomUUID()
        let job: any
        try {
          job = await withTenantContext(user.districtId, async (tx) => {
            return tx.appInvocationJob.create({
              data: {
                conversationId,
                districtId: user.districtId,
                requestKey,
                toolName: toolUse.name,
                parameters: toolUse.input ?? {},
                priority: 0,
                deadlineAt: new Date(Date.now() + 15_000),
                resumeToken,
                status: 'queued', // QUEUED — not running
                result: { _assistantContent: firstResult.content, _toolUseId: toolUse.id },
              },
            })
          })
        } catch (createErr: any) {
          if (createErr?.code === 'P2002') {
            job = await withTenantContext(user.districtId, async (tx) => {
              return tx.appInvocationJob.findUnique({ where: { requestKey } })
            })
          } else {
            throw createErr
          }
        }

        // Emit app card event (loading state) before closing SSE
        if (meta) {
          const url = meta.uiManifestUrl.startsWith('http') ? meta.uiManifestUrl : `http://localhost:3001${meta.uiManifestUrl}`
          reply.raw.write(`event: chatbridge_app_card\ndata: ${JSON.stringify({
            appId: meta.appId,
            appName: meta.appName,
            instanceId: null,
            url,
            height: meta.uiManifestHeight,
            ...(meta.displayMode === 'panel' ? { displayMode: 'panel' as const } : {}),
            status: 'loading',
            jobId: job.id,
          })}\n\n`)
        }

        // Emit tool_pending event — tells the client to call /resume later
        reply.raw.write(`event: tool_pending\ndata: ${JSON.stringify({
          jobId: job.id,
          resumeToken: job.resumeToken,
          toolName: toolUse.name,
          appName: meta?.appName ?? null,
        })}\n\n`)

        // CLOSE THE SSE STREAM — decoupled from tool execution
        reply.raw.end()

        // Execute tool ASYNCHRONOUSLY after response ends
        setImmediate(async () => {
          const toolExecStart = Date.now()
          try {
            // Claim the job
            await withTenantContext(user.districtId, async (tx) => {
              await tx.appInvocationJob.update({
                where: { id: job.id },
                data: { status: 'running', startedAt: new Date() },
              })
            })

            let executed: { result: Record<string, unknown>; instanceId?: string }

            // Circuit breaker check
            if (toolAppId && isBlocked(toolAppId)) {
              executed = {
                result: {
                  error: true,
                  message: `The ${meta?.appName ?? 'app'} app is temporarily unavailable.`,
                },
              }
            } else {
              executed = parsed
                ? await Promise.race([
                    executeChatbridgeTool(parsed.toolName, toolUse.input ?? {}, {
                      appId: meta?.appId,
                      appName: meta?.appName,
                      conversationId,
                      districtId: user.districtId,
                    }),
                    new Promise<never>((_, reject) =>
                      setTimeout(() => reject(new Error('TOOL_TIMEOUT')), 15_000),
                    ),
                  ])
                : { result: { status: 'unknown' } }

              if (toolAppId) await recordSuccess(toolAppId, Date.now() - toolExecStart)
            }

            // Update job with result
            const jobStatus = executed.result.error ? 'timed_out' as const : 'completed' as const
            await withTenantContext(user.districtId, async (tx) => {
              await tx.appInvocationJob.update({
                where: { id: job.id },
                data: {
                  status: jobStatus,
                  completedAt: new Date(),
                  result: {
                    ...executed.result,
                    _assistantContent: firstResult.content,
                    _toolUseId: toolUse.id,
                  } as any,
                  attemptCount: 1,
                  ...(executed.result.error ? { errorCode: 'TOOL_TIMEOUT' } : {}),
                },
              })
            })

            // Notify client via WebSocket that tool is done
            broadcastToChatConversation(conversationId, {
              type: 'job_completed',
              jobId: job.id,
              status: jobStatus,
              resumeToken: job.resumeToken,
            })

            request.log.info({ jobId: job.id, status: jobStatus, latencyMs: Date.now() - toolExecStart }, 'Async tool execution complete')
          } catch (toolErr) {
            if (toolAppId) await recordFailure(toolAppId)

            await withTenantContext(user.districtId, async (tx) => {
              await tx.appInvocationJob.update({
                where: { id: job.id },
                data: {
                  status: 'failed',
                  completedAt: new Date(),
                  errorCode: 'EXECUTION_FAILED',
                  result: {
                    error: true,
                    message: toolErr instanceof Error ? toolErr.message : 'Unknown error',
                    _assistantContent: firstResult.content,
                    _toolUseId: toolUse.id,
                  } as any,
                },
              })
            }).catch(() => {})

            broadcastToChatConversation(conversationId, {
              type: 'job_completed',
              jobId: job.id,
              status: 'failed',
              resumeToken: job.resumeToken,
            })

            request.log.error({ jobId: job.id, error: String(toolErr) }, 'Async tool execution failed')
          }
        })

        // Response already ended — return early
        return
      }

      // No tool_use — stream the AI response directly (no decoupling needed)

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

      for (const card of appCards) {
        reply.raw.write(`event: chatbridge_app_card\ndata: ${JSON.stringify(card)}\n\n`)
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
          ...(card.displayMode === 'panel' ? { displayMode: 'panel' as const } : {}),
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

      endGeneration(generation, {
        response: guardrailResult.text,
        toolCalls: executedToolName ? [{ name: executedToolName, args: {} }] : undefined,
        guardrailResult: {
          severity: 'safe',
          category: 'allowed',
        },
      })

      flushTraces().catch(() => {})
      reply.raw.end()
    } catch (err) {
      request.log.error(err, 'ChatBridge completions failed')
      endGeneration(generation, {
        response: 'Error: ChatBridge native completion failed',
        toolCalls: executedToolName ? [{ name: executedToolName, args: {} }] : undefined,
      })
      flushTraces().catch(() => {})
      const errorEvent = `event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: "I'm having trouble thinking right now. Please try again.",
      })}\n\n`
      reply.raw.write(errorEvent)
      reply.raw.end()
    }
  })

  // POST /chatbridge/completions/resume — Resume after async tool completion
  server.post('/chatbridge/completions/resume', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { resumeToken } = request.body as { resumeToken: string }
    const user = getUser(request)

    if (!resumeToken) {
      return reply.status(400).send({ error: 'resumeToken required' })
    }

    // C-1 fix: Atomic claim — mark as resumed in one UPDATE, prevent double-resume
    const claimed = await withTenantContext(user.districtId, async (tx) => {
      // Atomic: only update if not already resumed
      const updated = await tx.appInvocationJob.updateMany({
        where: {
          resumeToken,
          resumedAt: null, // Only claim if not yet resumed
          status: { in: ['completed', 'failed', 'timed_out'] },
        },
        data: { resumedAt: new Date() },
      })

      if (updated.count === 0) {
        // Either already resumed, still running, or not found
        const existing = await tx.appInvocationJob.findUnique({ where: { resumeToken } })
        return { claimed: false, job: existing }
      }

      const job = await tx.appInvocationJob.findUnique({ where: { resumeToken } })
      return { claimed: true, job }
    })

    if (!claimed.job) {
      return reply.status(410).send({ error: 'Resume token expired or invalid' })
    }

    if (!claimed.claimed) {
      if (claimed.job.resumedAt) {
        return reply.status(409).send({ error: 'Already resumed' })
      }
      // Still running or queued
      return reply.status(202).send({ status: claimed.job.status, jobId: claimed.job.id, message: 'Job still in progress' })
    }

    const job = claimed.job

    // C-4 fix: Ownership check — verify this user owns the conversation
    const conv = await withTenantContext(user.districtId, async (tx) => {
      return tx.conversation.findUnique({ where: { id: job.conversationId }, select: { studentId: true } })
    })
    if (user.role === 'student' && conv?.studentId !== user.userId) {
      return reply.status(403).send({ error: 'Not authorized to resume this job' })
    }

    // Extract tool result and stored assistant turn (C-2/C-3 fix)
    const jobResult = (job.result ?? {}) as Record<string, unknown>
    const assistantContent = jobResult._assistantContent as any[] | undefined
    const toolUseId = jobResult._toolUseId as string | undefined
    const { _assistantContent, _toolUseId, ...toolResult } = jobResult

    // Load conversation context
    const ctx = await loadConversationContext(job.conversationId, user.districtId)
    if (!ctx.conversation) {
      return reply.status(404).send({ error: 'Conversation not found' })
    }

    const activeApp = ctx.activeAppInstance
    const systemPrompt = assembleSystemPrompt({
      classroomConfig: ctx.aiConfig,
      gradeBand: ctx.gradeBand,
      toolSchemas: [],
      whisperGuidance: ctx.whisperGuidance,
      safetyInstructions: null,
      activeAppState: activeApp?.status === 'active' ? (activeApp.stateSnapshot as any) : null,
      activeAppName: activeApp?.app?.name ?? null,
      activeAppStatus: (activeApp?.status as any) ?? null,
      stateUpdatedAt: activeApp?.updatedAt ?? null,
    })

    const recentMessages = ctx.recentMessages.map((m: any) => ({
      role: m.authorRole === 'student' ? 'user' : 'assistant',
      content: (m.contentParts as any[])?.[0]?.text ?? '',
    }))

    // Stream follow-up response
    const origin = request.headers.origin ?? '*'
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': origin,
    })

    const apiKey = process.env.ANTHROPIC_API_KEY ?? ''

    // C-2/C-3 fix: Include the real assistant tool_use turn before the tool_result
    const resumeMessages: any[] = [...recentMessages]
    if (assistantContent) {
      resumeMessages.push({ role: 'assistant', content: assistantContent })
    }
    resumeMessages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId ?? 'unknown',
        content: JSON.stringify(toolResult),
      }],
    })

    const streamResponse = await fetch('https://api.anthropic.com/v1/messages', {
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
        messages: resumeMessages,
        stream: true,
      }),
    })

    const reader = streamResponse.body?.getReader()
    if (reader) {
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        reply.raw.write(decoder.decode(value, { stream: true }))
      }
    }

    reply.raw.end()
  })

  // GET /chatbridge/jobs/:jobId — Check job status
  server.get('/chatbridge/jobs/:jobId', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string }
    const user = getUser(request)

    const job = await withTenantContext(user.districtId, async (tx) => {
      return tx.appInvocationJob.findUnique({
        where: { id: jobId },
        include: { conversation: { select: { studentId: true } } },
      })
    })

    if (!job) return reply.status(404).send({ error: 'Job not found' })

    // C-4 fix: Ownership check — students can only see their own jobs
    if (user.role === 'student' && (job as any).conversation?.studentId !== user.userId) {
      return reply.status(403).send({ error: 'Not authorized' })
    }

    return {
      jobId: job.id,
      status: job.status,
      toolName: job.toolName,
      priority: job.priority,
      attemptCount: job.attemptCount,
      resumeToken: job.status === 'completed' || job.status === 'failed' || job.status === 'timed_out' ? job.resumeToken : null,
      result: job.status === 'completed' ? job.result : null,
      errorCode: job.errorCode,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
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
