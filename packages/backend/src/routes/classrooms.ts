import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole, getUser } from '../middleware/auth.js'
import { withTenantContext, prisma } from '../middleware/rls.js'
import crypto from 'crypto'

export async function classroomRoutes(server: FastifyInstance) {
  // POST /classrooms — Create classroom
  server.post('/classrooms', {
    preHandler: [authenticate, requireRole('teacher')],
    schema: {
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

    const classroom = await prisma.classroom.create({
      data: {
        districtId: user.districtId,
        schoolId: user.schoolId ?? null,
        teacherId: user.userId,
        name,
        joinCode,
        gradeBand,
        aiConfig: aiConfig ?? { mode: 'socratic' },
      },
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
    preHandler: [authenticate],
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string }
    const user = getUser(request)

    const classroom = await withTenantContext(user.districtId, async (tx) => {
      return tx.classroom.findUnique({
        where: { id },
        select: { gradeBand: true, aiConfig: true, joinCode: true, name: true },
      })
    })

    if (!classroom) {
      return { error: 'Classroom not found' }
    }

    return classroom
  })

  // PATCH /classrooms/:id/config — Update classroom config
  server.patch('/classrooms/:id/config', {
    preHandler: [authenticate, requireRole('teacher')],
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object', properties: { aiConfig: { type: 'object' }, asyncGuidance: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string }
    const { aiConfig, asyncGuidance } = request.body as {
      aiConfig?: Record<string, unknown>
      asyncGuidance?: string
    }

    const update: Record<string, unknown> = {}
    if (aiConfig) {
      // Merge with existing config
      const existing = await prisma.classroom.findUnique({ where: { id }, select: { aiConfig: true } })
      update.aiConfig = { ...(existing?.aiConfig as Record<string, unknown> ?? {}), ...aiConfig }
    }
    if (asyncGuidance !== undefined) {
      const existing = await prisma.classroom.findUnique({ where: { id }, select: { aiConfig: true } })
      update.aiConfig = { ...(existing?.aiConfig as Record<string, unknown> ?? {}), asyncGuidance }
    }

    const classroom = await prisma.classroom.update({
      where: { id },
      data: update,
    })

    return { id: classroom.id, aiConfig: classroom.aiConfig }
  })

  // GET /classrooms/:id/apps — List apps for classroom (from district catalog)
  server.get('/classrooms/:id/apps', {
    preHandler: [authenticate],
  }, async (request) => {
    const { id } = request.params as { id: string }
    const user = getUser(request)

    // Get district-approved apps with classroom-level enable/disable
    const catalogEntries = await withTenantContext(user.districtId, async (tx) => {
      return tx.districtAppCatalog.findMany({
        where: { districtId: user.districtId, status: 'approved' },
        include: {
          app: { select: { id: true, name: true, description: true, toolDefinitions: true, uiManifest: true, interactionModel: true } },
        },
      })
    })

    // Get classroom-specific enable/disable
    const classroomConfigs = await prisma.classroomAppConfig.findMany({
      where: { classroomId: id },
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
      body: { type: 'object', properties: { enabled: { type: 'boolean' } } },
    },
  }, async (request) => {
    const { id, appId } = request.params as { id: string; appId: string }
    const { enabled } = request.body as { enabled: boolean }
    const user = getUser(request)

    await prisma.classroomAppConfig.upsert({
      where: { classroomId_appId: { classroomId: id, appId } },
      update: { enabled },
      create: {
        classroomId: id,
        appId,
        districtId: user.districtId,
        enabled,
      },
    })

    return { classroomId: id, appId, enabled }
  })

  // POST /classrooms/:id/students/:studentId/whisper — Teacher whisper
  server.post('/classrooms/:id/students/:studentId/whisper', {
    preHandler: [authenticate, requireRole('teacher')],
    schema: {
      body: { type: 'object', required: ['guidance'], properties: { guidance: { type: 'string', maxLength: 2000 } } },
    },
  }, async (request) => {
    const { id, studentId } = request.params as { id: string; studentId: string }
    const { guidance } = request.body as { guidance: string }
    const user = getUser(request)

    // Store whisper as a teacher_whisper message in the student's active conversation
    const conversation = await prisma.conversation.findFirst({
      where: { classroomId: id, studentId },
      orderBy: { updatedAt: 'desc' },
    })

    if (!conversation) {
      return { error: 'No active conversation for this student' }
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        districtId: user.districtId,
        authorRole: 'teacher_whisper',
        contentParts: [{ type: 'text', text: guidance }],
        whisperAuthorId: user.userId,
      },
    })

    return { success: true, conversationId: conversation.id }
  })
}
