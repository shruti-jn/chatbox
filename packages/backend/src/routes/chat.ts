import type { FastifyInstance } from 'fastify'
import { authenticate, getUser } from '../middleware/auth.js'
import { requireCoppaConsent } from '../middleware/coppa.js'
import { prisma, withTenantContext } from '../middleware/rls.js'
import { runSafetyPipeline } from '../safety/pipeline.js'
import { createTrace, createSafetySpan, createGeneration, endGeneration, flushTraces } from '../observability/langfuse.js'
import { generateResponse, type AIContext } from '../ai/service.js'
import { assembleSystemPrompt } from '../prompts/registry.js'
import { applyOutputGuardrails } from '../safety/output-guardrail.js'

export async function chatRoutes(server: FastifyInstance) {
  // POST /conversations/:id/messages — Send a message
  server.post('/conversations/:conversationId/messages', {
    preHandler: [authenticate, requireCoppaConsent],
    schema: {
      params: { type: 'object', properties: { conversationId: { type: 'string' } } },
      body: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 4000 } } },
    },
  }, async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string }
    const { text } = request.body as { text: string }
    const user = getUser(request)

    // Create Langfuse trace for this conversation turn
    const trace = createTrace('conversation_turn', {
      userId: user.userId, // Pseudonymous UUID, not PII
      sessionId: conversationId,
      conversationId,
      districtId: user.districtId,
    })

    // Safety span
    const safetySpan = createSafetySpan(trace, text)

    // Run 4-stage safety pipeline
    const safetyResult = await runSafetyPipeline(text)

    // End safety span with result
    if (safetySpan) {
      try {
        safetySpan.end({
          output: {
            severity: safetyResult.severity,
            category: safetyResult.category,
            processingTimeMs: safetyResult.processingTimeMs,
            hadPII: safetyResult.piiFound.length > 0,
            // Do NOT log actual message content — only metadata
          },
        })
      } catch {}
    }

    // Log safety event if not safe
    if (safetyResult.severity !== 'safe') {
      await withTenantContext(user.districtId, async (tx) => {
        await tx.safetyEvent.create({
          data: {
            districtId: user.districtId,
            userId: user.userId,
            eventType: safetyResult.category === 'crisis' ? 'crisis_detected'
              : safetyResult.category === 'injection_detected' ? 'injection_detected'
              : safetyResult.category === 'pii_detected' ? 'pii_detected'
              : 'content_blocked',
            severity: safetyResult.severity,
            messageContextRedacted: safetyResult.redactedMessage.slice(0, 500),
            actionTaken: safetyResult.severity === 'blocked' ? 'message_rejected'
              : safetyResult.severity === 'critical' ? 'crisis_resources_returned'
              : 'message_processed_with_warning',
          },
        })
      })
    }

    // Handle blocked messages
    if (safetyResult.severity === 'blocked') {
      // Flush traces before responding
      flushTraces().catch(() => {})
      return reply.status(422).send({
        error: 'Message could not be processed',
        category: safetyResult.category,
      })
    }

    // Handle crisis — return resources immediately
    if (safetyResult.severity === 'critical') {
      await withTenantContext(user.districtId, async (tx) => {
        await tx.message.create({
          data: {
            conversationId,
            districtId: user.districtId,
            authorRole: 'student',
            contentParts: [{ type: 'text', text: safetyResult.redactedMessage }],
            safetyVerdict: {
              severity: safetyResult.severity,
              category: safetyResult.category,
              piiFound: safetyResult.piiFound,
            },
          },
        })
      })

      flushTraces().catch(() => {})
      return reply.status(200).send({
        severity: 'critical',
        crisisResources: safetyResult.crisisResources,
        message: "It sounds like you might be going through a difficult time. Here are some resources that can help:",
      })
    }

    // Safe or warning — save message and generate AI response
    const studentMessage = await withTenantContext(user.districtId, async (tx) => {
      return tx.message.create({
        data: {
          conversationId,
          districtId: user.districtId,
          authorRole: 'student',
          contentParts: [{ type: 'text', text: safetyResult.redactedMessage }],
          safetyVerdict: safetyResult.severity !== 'safe' ? {
            severity: safetyResult.severity,
            category: safetyResult.category,
            piiFound: safetyResult.piiFound,
          } : undefined,
        },
      })
    })

    // Get conversation context for AI
    const recentMessages = await withTenantContext(user.districtId, async (tx) => {
      return tx.message.findMany({
        where: { conversationId, authorRole: { not: 'teacher_whisper' } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
    })

    // Get classroom config
    const conversation = await withTenantContext(user.districtId, async (tx) => {
      return tx.conversation.findUnique({
        where: { id: conversationId },
        include: { classroom: true },
      })
    })

    // Get any pending whisper
    const whisper = await withTenantContext(user.districtId, async (tx) => {
      return tx.message.findFirst({
        where: {
          conversationId,
          authorRole: 'teacher_whisper',
          createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) }, // Last 5 minutes
        },
        orderBy: { createdAt: 'desc' },
      })
    })

    // Build AI context
    const aiConfig = (conversation?.classroom?.aiConfig as Record<string, any>) ?? { mode: 'direct' }
    const gradeBand = conversation?.classroom?.gradeBand ?? 'g68'

    const aiMessages = recentMessages.reverse().map(m => ({
      role: m.authorRole === 'student' ? 'user' as const : 'assistant' as const,
      content: (m.contentParts as any[])?.[0]?.text ?? '',
    }))

    // Create Langfuse generation span for AI call
    const generation = createGeneration(trace, 'ai_response', {
      model: 'claude-haiku-4-5-20251001',
      messages: aiMessages,
    })

    try {
      // Generate AI response
      const result = await generateResponse({
        messages: aiMessages,
        classroomConfig: {
          mode: aiConfig.mode ?? 'direct',
          subject: aiConfig.subject,
          tone: aiConfig.tone,
          complexity: aiConfig.complexity,
          asyncGuidance: aiConfig.asyncGuidance,
        },
        gradeBand: gradeBand as any,
        activeAppState: null,
        activeAppName: null,
        enabledToolSchemas: {},
        whisperGuidance: whisper ? ((whisper.contentParts as any[])?.[0]?.text ?? null) : null,
        asyncGuidance: aiConfig.asyncGuidance ?? null,
      })

      // Collect full response
      let fullText = ''
      for await (const chunk of result.textStream) {
        fullText += chunk
      }

      // Apply output guardrails on AI response
      const guardrailResult = applyOutputGuardrails(fullText, {
        mode: aiConfig.mode,
        subject: aiConfig.subject,
      })
      fullText = guardrailResult.text

      // End generation span
      endGeneration(generation, {
        response: fullText,
        tokenUsage: undefined, // Would come from result.usage when available
        guardrailResult: {
          severity: safetyResult.severity,
          category: safetyResult.category,
        },
      })

      // Save AI response
      const aiMessage = await withTenantContext(user.districtId, async (tx) => {
        return tx.message.create({
          data: {
            conversationId,
            districtId: user.districtId,
            authorRole: 'assistant',
            contentParts: [{ type: 'text', text: fullText }],
          },
        })
      })

      // Flush traces (non-blocking)
      flushTraces().catch(() => {})

      return reply.status(200).send({
        messageId: studentMessage.id,
        aiMessageId: aiMessage.id,
        response: fullText,
        safetyVerdict: safetyResult.severity !== 'safe' ? {
          severity: safetyResult.severity,
          category: safetyResult.category,
        } : undefined,
      })
    } catch (err) {
      // AI failed — still return the student message but note the failure
      request.log.error(err, 'AI response generation failed')

      endGeneration(generation, {
        response: 'Error: AI generation failed',
      })
      flushTraces().catch(() => {})

      return reply.status(200).send({
        messageId: studentMessage.id,
        response: "I'm having trouble thinking right now. Please try again in a moment.",
        error: 'ai_generation_failed',
      })
    }
  })

  // GET /conversations/:id/messages — Get conversation history
  server.get('/conversations/:conversationId/messages', {
    preHandler: [authenticate, requireCoppaConsent],
    schema: {
      params: { type: 'object', properties: { conversationId: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 50 },
          before: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { conversationId } = request.params as { conversationId: string }
    const { limit = 50, before } = request.query as { limit?: number; before?: string }
    const user = getUser(request)

    const messages = await withTenantContext(user.districtId, async (tx) => {
      return tx.message.findMany({
        where: {
          conversationId,
          ...(before ? { createdAt: { lt: new Date(before) } } : {}),
          ...(user.role === 'student' ? { authorRole: { not: 'teacher_whisper' } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
      })
    })

    const hasMore = messages.length > limit
    const result = hasMore ? messages.slice(0, limit) : messages

    return {
      messages: result.reverse(),
      hasMore,
    }
  })

  // GET /conversations — List conversations for authenticated user
  server.get('/conversations', {
    preHandler: [authenticate, requireCoppaConsent],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          classroomId: { type: 'string' },
          limit: { type: 'integer', default: 50 },
          offset: { type: 'integer', default: 0 },
        },
      },
    },
  }, async (request) => {
    const { classroomId, limit = 50, offset = 0 } = request.query as {
      classroomId?: string
      limit?: number
      offset?: number
    }
    const user = getUser(request)

    const conversations = await withTenantContext(user.districtId, async (tx) => {
      return tx.conversation.findMany({
        where: {
          studentId: user.userId,
          ...(classroomId ? { classroomId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: limit + 1,
        skip: offset,
        include: {
          classroom: { select: { id: true, name: true } },
          _count: { select: { messages: true } },
        },
      })
    })

    const hasMore = conversations.length > limit
    const result = hasMore ? conversations.slice(0, limit) : conversations

    return {
      conversations: result.map(c => ({
        id: c.id,
        classroomId: c.classroomId,
        classroom: c.classroom,
        title: c.title,
        messageCount: c._count.messages,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
      hasMore,
      total: result.length,
    }
  })

  // POST /conversations — Create a new conversation
  server.post('/conversations', {
    preHandler: [authenticate, requireCoppaConsent],
    schema: {
      body: {
        type: 'object',
        required: ['classroomId'],
        properties: {
          classroomId: { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { classroomId, title } = request.body as { classroomId: string; title?: string }
    const user = getUser(request)

    const conversation = await withTenantContext(user.districtId, async (tx) => {
      return tx.conversation.create({
        data: {
          districtId: user.districtId,
          classroomId,
          studentId: user.userId,
          title,
        },
      })
    })

    return reply.status(201).send({
      id: conversation.id,
      classroomId: conversation.classroomId,
      title: conversation.title,
    })
  })
}
