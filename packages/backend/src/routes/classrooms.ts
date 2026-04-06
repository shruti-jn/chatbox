import type { FastifyInstance } from 'fastify'
import type { InputJsonValue } from '@prisma/client/runtime/library'
import { Severity } from '@prisma/client'
import { authenticate, requireRole, getUser } from '../middleware/auth.js'
import { withTenantContext, prisma, ownerPrisma } from '../middleware/rls.js'
import { AIConfigSchema } from '@chatbridge/shared'
import { detectAndRedactPII } from '../safety/pii-detector.js'
import crypto from 'crypto'

export async function classroomRoutes(server: FastifyInstance) {
  // GET /classroom-context — Public endpoint to resolve classroom badge info from join code
  // No auth required: join codes are shared with students to enter classrooms
  server.get('/classroom-context', {
    schema: {
      querystring: {
        type: 'object',
        required: ['joinCode'],
        properties: {
          joinCode: { type: 'string', minLength: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            classroom: { type: 'string' },
            gradeBand: { type: 'string' },
          },
        },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { joinCode } = request.query as { joinCode: string }

    // ownerPrisma bypasses RLS — join code lookup is cross-tenant by design
    const classroom = await ownerPrisma.classroom.findUnique({
      where: { joinCode },
      select: { name: true, gradeBand: true },
    })

    if (!classroom) {
      return reply.status(404).send({ error: 'Classroom not found' })
    }

    return { classroom: classroom.name, gradeBand: classroom.gradeBand }
  })

  // POST /classrooms — Create classroom
  server.post('/classrooms', {
    preHandler: [authenticate, requireRole('teacher')],
    schema: {
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'gradeBand'],
        properties: {
          name: { type: 'string', minLength: 1 },
          gradeBand: { type: 'string', enum: ['k2', 'g35', 'g68', 'g912'] },
          aiConfig: { type: 'object' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            joinCode: { type: 'string' },
            gradeBand: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const user = getUser(request)
    const { name, gradeBand, aiConfig } = request.body as {
      name: string
      gradeBand: 'k2' | 'g35' | 'g68' | 'g912'
      aiConfig?: Record<string, unknown>
    }

    const joinCode = crypto.randomBytes(4).toString('hex').toUpperCase()

    const classroom = await withTenantContext(user.districtId, async (tx) => {
      return tx.classroom.create({
        data: {
          districtId: user.districtId,
          schoolId: user.schoolId ?? null,
          teacherId: user.userId,
          name,
          joinCode,
          gradeBand,
          aiConfig: (aiConfig ?? { mode: 'socratic' }) as InputJsonValue,
        },
      })
    })

    return reply.status(201).send({
      id: classroom.id,
      name: classroom.name,
      joinCode: classroom.joinCode,
      gradeBand: classroom.gradeBand,
    })
  })

  // GET /classrooms/:id/config — Get classroom config
  server.get('/classrooms/:id/config', {
    preHandler: [authenticate, requireRole('teacher')],
    schema: {
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = getUser(request)

    const classroom = await withTenantContext(user.districtId, async (tx) => {
      return tx.classroom.findFirst({
        where: { id, districtId: user.districtId },
        select: { gradeBand: true, aiConfig: true, joinCode: true, name: true },
      })
    })

    if (!classroom) {
      return reply.status(404).send({ error: 'Classroom not found' })
    }

    return classroom
  })

  // PATCH /classrooms/:id/config — Update classroom config
  server.patch('/classrooms/:id/config', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
    schema: {
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object', properties: { aiConfig: { type: 'object' }, asyncGuidance: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = getUser(request)
    const { aiConfig, asyncGuidance } = request.body as {
      aiConfig?: Record<string, unknown>
      asyncGuidance?: string
    }

    // F3: Validate aiConfig fields against shared schema
    if (aiConfig) {
      const result = AIConfigSchema.partial().safeParse(aiConfig)
      if (!result.success) {
        return reply.status(400).send({ error: 'Invalid aiConfig', details: result.error.issues })
      }
    }

    // F1: Use withTenantContext + districtId filter for RLS enforcement
    const classroom = await withTenantContext(user.districtId, async (tx) => {
      const existing = await tx.classroom.findFirst({
        where: { id, districtId: user.districtId },
        select: { aiConfig: true },
      })
      if (!existing) return null

      const existingConfig = (existing.aiConfig as Record<string, unknown>) ?? {}
      let mergedConfig: Record<string, unknown> = { ...existingConfig }
      if (aiConfig) {
        mergedConfig = { ...mergedConfig, ...aiConfig }
      }
      if (asyncGuidance !== undefined) {
        mergedConfig = { ...mergedConfig, asyncGuidance }
      }

      return tx.classroom.update({
        where: { id },
        data: { aiConfig: mergedConfig as InputJsonValue },
      })
    })

    if (!classroom) {
      return reply.status(404).send({ error: 'Classroom not found' })
    }

    return { id: classroom.id, aiConfig: classroom.aiConfig }
  })

  // GET /classrooms/:id/apps — List apps for classroom (from district catalog)
  server.get('/classrooms/:id/apps', {
    preHandler: [authenticate],
    schema: {
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = getUser(request)

    // Verify classroom belongs to this tenant before returning apps
    const classroom = await withTenantContext(user.districtId, async (tx) => {
      return tx.classroom.findFirst({
        where: { id, districtId: user.districtId },
        select: { id: true },
      })
    })

    if (!classroom) {
      return reply.status(404).send({ error: 'Classroom not found' })
    }

    // Get district-approved apps with classroom-level enable/disable
    const catalogEntries = await withTenantContext(user.districtId, async (tx) => {
      return tx.districtAppCatalog.findMany({
        where: { districtId: user.districtId, status: 'approved' },
        include: {
          app: { select: { id: true, name: true, description: true, toolDefinitions: true, uiManifest: true, interactionModel: true } },
        },
      })
    })

    // Get classroom-specific enable/disable (uses tenant context for RLS)
    const classroomConfigs = await withTenantContext(user.districtId, async (tx) => {
      return tx.classroomAppConfig.findMany({
        where: { classroomId: id },
      })
    })

    const configMap = new Map(classroomConfigs.map(c => [c.appId, c.enabled]))

    return catalogEntries.map(entry => ({
      ...entry.app,
      enabled: configMap.get(entry.appId) ?? true, // Default enabled if in catalog
    }))
  })

  // PATCH /classrooms/:id/apps/:appId — Toggle app enabled/disabled
  server.patch('/classrooms/:id/apps/:appId', {
    preHandler: [authenticate, requireRole('teacher')],
    schema: {
      security: [{ bearerAuth: [] }],
      body: { type: 'object', properties: { enabled: { type: 'boolean' } } },
    },
  }, async (request, reply) => {
    const { id, appId } = request.params as { id: string; appId: string }
    const { enabled } = request.body as { enabled: boolean }
    const user = getUser(request)

    // F1: Use withTenantContext for RLS enforcement
    const result = await withTenantContext(user.districtId, async (tx) => {
      // Verify classroom exists within tenant (districtId filter for RLS)
      const classroom = await tx.classroom.findFirst({ where: { id, districtId: user.districtId }, select: { id: true } })
      if (!classroom) return { error: 'classroom_not_found' as const }

      // F4: Check catalog status — reject if app is not approved
      const catalogEntry = await tx.districtAppCatalog.findFirst({
        where: { districtId: user.districtId, appId, status: 'approved' },
      })
      if (!catalogEntry) return { error: 'app_not_found' as const }

      // F5: Set enabled_by audit trail
      const config = await tx.classroomAppConfig.upsert({
        where: { classroomId_appId: { classroomId: id, appId } },
        update: { enabled, enabledBy: user.userId },
        create: {
          classroomId: id,
          appId,
          districtId: user.districtId,
          enabled,
          enabledBy: user.userId,
        },
      })

      return { config }
    })

    if (result.error === 'classroom_not_found' || result.error === 'app_not_found') {
      return reply.status(404).send({ error: result.error === 'classroom_not_found' ? 'Classroom not found' : 'App not found in approved catalog' })
    }

    const config = result.config!
    return { classroomId: id, appId, enabled: config.enabled, enabledBy: config.enabledBy }
  })

  // GET /classrooms/by-join-code/:joinCode/tool-manifest — Public tool manifest for a classroom
  // No auth required: join codes are semi-public; manifest is read-only metadata
  server.get('/classrooms/by-join-code/:joinCode/tool-manifest', {
    schema: {
      params: {
        type: 'object',
        required: ['joinCode'],
        properties: {
          joinCode: { type: 'string', minLength: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            classroomId: { type: 'string' },
            classroomName: { type: 'string' },
            tools: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  appId: { type: 'string' },
                  appName: { type: 'string' },
                  toolName: { type: 'string' },
                  description: { type: 'string' },
                  parameters: { type: 'object', additionalProperties: true },
                  uiManifest: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { joinCode } = request.params as { joinCode: string }

    // ownerPrisma bypasses RLS — join code lookup is cross-tenant by design
    const classroom = await ownerPrisma.classroom.findUnique({
      where: { joinCode },
      select: {
        id: true,
        name: true,
        districtId: true,
        appConfigs: {
          where: { enabled: true },
          select: {
            app: {
              select: {
                id: true,
                name: true,
                toolDefinitions: true,
                uiManifest: true,
                reviewStatus: true,
              },
            },
          },
        },
      },
    })

    if (!classroom) {
      return reply.status(404).send({ error: 'Classroom not found' })
    }

    // Flatten enabled + approved apps into individual tool entries
    const tools: Array<{
      appId: string
      appName: string
      toolName: string
      description: string
      parameters: Record<string, unknown>
      uiManifest: { url: string | null; height: number; width?: number; displayMode: 'inline' | 'panel' }
    }> = []

    for (const config of classroom.appConfigs) {
      const app = config.app
      // Only include approved apps
      if (app.reviewStatus !== 'approved') continue

      const toolDefs = app.toolDefinitions as Array<{
        name: string
        description?: string
        inputSchema?: Record<string, unknown>
      }>
      const manifest = app.uiManifest as { url?: string; height?: number; width?: number; displayMode?: 'inline' | 'panel' } | null

      if (!Array.isArray(toolDefs)) continue

      for (const tool of toolDefs) {
        tools.push({
          appId: app.id,
          appName: app.name,
          toolName: tool.name,
          description: tool.description ?? '',
          parameters: tool.inputSchema ?? { type: 'object' },
          uiManifest: {
            url: manifest?.url ?? null,
            height: manifest?.height ?? 400,
            width: manifest?.width,
            displayMode: manifest?.displayMode === 'panel' ? 'panel' : 'inline',
          },
        })
      }
    }

    return {
      classroomId: classroom.id,
      classroomName: classroom.name,
      tools,
    }
  })

  // GET /classrooms/:id/students — Mission Control student list
  server.get('/classrooms/:id/students', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = getUser(request)

    const ACTIVE_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
    const now = Date.now()

    const students = await withTenantContext(user.districtId, async (tx) => {
      const memberships = await tx.classroomMembership.findMany({
        where: { classroomId: id, districtId: user.districtId },
        include: {
          student: { select: { id: true, displayName: true } },
        },
      })

      return Promise.all(memberships.map(async (m) => {
        const [lastMsg, recentFlag] = await Promise.all([
          tx.message.findFirst({
            where: {
              conversation: { classroomId: id, studentId: m.studentId },
              authorRole: 'student',
            },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          }),
          tx.safetyEvent.findFirst({
            where: {
              userId: m.studentId,
              districtId: user.districtId,
              severity: { in: [Severity.blocked, Severity.critical] },
              createdAt: { gte: new Date(now - ACTIVE_WINDOW_MS) },
            },
            select: { id: true },
          }),
        ])

        const lastActivity = lastMsg?.createdAt ?? m.joinedAt
        let status: 'active' | 'idle' | 'flagged' = 'idle'
        if (recentFlag) {
          status = 'flagged'
        } else if (lastMsg && (now - lastMsg.createdAt.getTime()) < ACTIVE_WINDOW_MS) {
          status = 'active'
        }

        return {
          id: m.student.id,
          displayName: m.student.displayName,
          status,
          lastActivity: lastActivity.toISOString(),
        }
      }))
    })

    return { students }
  })

  // POST /classrooms/:id/students/:studentId/whisper — Teacher whisper
  server.post('/classrooms/:id/students/:studentId/whisper', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
    schema: {
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          guidance: { type: 'string', maxLength: 2000 },
          text: { type: 'string', maxLength: 2000 },
        },
        anyOf: [
          { required: ['guidance'] },
          { required: ['text'] },
        ],
      },
    },
  }, async (request, reply) => {
    const { id, studentId } = request.params as { id: string; studentId: string }
    const { guidance, text } = request.body as { guidance?: string; text?: string }
    const user = getUser(request)
    const whisperText = typeof text === 'string' && text.trim().length > 0
      ? text.trim()
      : typeof guidance === 'string' && guidance.trim().length > 0
        ? guidance.trim()
        : null

    if (!whisperText) {
      return reply.status(400).send({ error: 'Whisper text is required' })
    }

    const pii = detectAndRedactPII(whisperText)
    const storedText = pii.hadPII ? pii.redactedMessage : whisperText

    // Store whisper as a teacher_whisper message in the student's active conversation
    // Use withTenantContext for RLS enforcement + filter by classroomId to prevent cross-district whisper
    const result = await withTenantContext(user.districtId, async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { classroomId: id, studentId, districtId: user.districtId },
        orderBy: { updatedAt: 'desc' },
      })

      if (!conversation) {
        return { error: 'no_conversation' as const }
      }

      await tx.message.create({
        data: {
          conversationId: conversation.id,
          districtId: user.districtId,
          authorRole: 'teacher_whisper',
          contentParts: [{
            type: 'text',
            text: storedText,
            ...(pii.hadPII ? { redactionApplied: true, piiTypes: pii.piiFound.map((match) => match.type) } : {}),
          }],
          whisperAuthorId: user.userId,
        },
      })

      return { success: true, conversationId: conversation.id, redacted: pii.hadPII }
    })

    if (result.error === 'no_conversation') {
      return reply.status(404).send({ error: 'No active conversation for this student' })
    }

    return { success: true, conversationId: result.conversationId, redacted: result.redacted }
  })
}
