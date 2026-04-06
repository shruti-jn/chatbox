import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole, getUser } from '../middleware/auth.js'
import { withTenantContext, ownerPrisma } from '../middleware/rls.js'
import { getHealthStatus } from '../apps/index.js'
import { getQueueStats } from '../lib/queue-admission.js'
import { preWarmClassroom } from '../lib/session-pool.js'

export async function adminRoutes(server: FastifyInstance) {
  // POST /admin/apps/:appId/suspend — Suspend app district-wide
  server.post('/admin/apps/:appId/suspend', {
    preHandler: [authenticate, requireRole('district_admin')],
  }, async (request) => {
    const { appId } = request.params as { appId: string }
    const user = getUser(request)

    // Terminate all active instances in this district
    await withTenantContext(user.districtId, async (tx) => {
      await tx.appInstance.updateMany({
        where: { appId, status: { in: ['loading', 'active', 'suspended'] } },
        data: { status: 'terminated', terminatedAt: new Date() },
      })

      // Update district catalog
      await tx.districtAppCatalog.updateMany({
        where: { appId, districtId: user.districtId },
        data: { status: 'suspended' },
      })

      // Remove from all classroom configs
      await tx.classroomAppConfig.updateMany({
        where: { appId, districtId: user.districtId },
        data: { enabled: false },
      })
    })

    return { appId, status: 'suspended', districtId: user.districtId }
  })

  // GET /admin/safety-events — Safety event audit trail
  server.get('/admin/safety-events', {
    preHandler: [authenticate, requireRole('district_admin')],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 50 },
          severity: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const user = getUser(request)
    const { limit = 50, severity } = request.query as { limit?: number; severity?: string }

    const events = await withTenantContext(user.districtId, async (tx) => {
      return tx.safetyEvent.findMany({
        where: {
          ...(severity ? { severity: severity as any } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
    })

    return { events, total: events.length }
  })

  // GET /admin/audit-trail — FERPA audit trail
  server.get('/admin/audit-trail', {
    preHandler: [authenticate, requireRole('district_admin')],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          studentId: { type: 'string' },
          limit: { type: 'integer', default: 50 },
        },
      },
    },
  }, async (request) => {
    const user = getUser(request)
    const { studentId, limit = 50 } = request.query as { studentId?: string; limit?: number }

    const events = await withTenantContext(user.districtId, async (tx) => {
      return tx.auditEvent.findMany({
        where: {
          ...(studentId ? { userId: studentId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
    })

    return { events, total: events.length }
  })

  // GET /admin/apps — List all apps with reviewStatus
  server.get('/admin/apps', {
    preHandler: [authenticate, requireRole('district_admin')],
  }, async () => {

    const apps = await ownerPrisma.app.findMany({ orderBy: { createdAt: 'desc' } })
    return {
      apps: apps.map((app) => ({
        ...app,
        healthStatus: getHealthStatus(app.id),
      })),
    }
  })

  // GET /admin/apps/:id — Get app detail
  server.get('/admin/apps/:id', {
    preHandler: [authenticate, requireRole('district_admin')],
  }, async (request) => {
    const { id } = request.params as { id: string }

    const app = await ownerPrisma.app.findUnique({ where: { id } })
    if (!app) {
      throw { statusCode: 404, message: 'App not found' }
    }
    return app
  })

  // POST /admin/apps/:id/approve — Approve app
  server.post('/admin/apps/:id/approve', {
    preHandler: [authenticate, requireRole('district_admin')],
  }, async (request) => {
    const { id } = request.params as { id: string }

    const app = await ownerPrisma.app.update({
      where: { id },
      data: { reviewStatus: 'approved' },
    })
    return { id: app.id, reviewStatus: app.reviewStatus }
  })

  // GET /admin/analytics — Pseudonymous analytics (no PII)
  server.get('/admin/analytics', {
    preHandler: [authenticate, requireRole('district_admin')],
  }, async (request) => {
    const user = getUser(request)


    const [messageCount, safetyEventCount, activeStudentCount, classrooms] = await Promise.all([
      ownerPrisma.message.count(),
      ownerPrisma.safetyEvent.count(),
      ownerPrisma.user.count({ where: { districtId: user.districtId, role: 'student' } }),
      ownerPrisma.classroom.findMany({
        where: { districtId: user.districtId },
        select: { id: true, name: true, gradeBand: true, createdAt: true },
      }),
    ])

    return {
      messageCount,
      safetyEventCount,
      activeStudents: activeStudentCount,
      classrooms,
    }
  })

  // GET /admin/tool-invocations — Tool invocation log
  server.get('/admin/tool-invocations', {
    preHandler: [authenticate, requireRole('district_admin')],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          appId: { type: 'string' },
          limit: { type: 'integer', default: 50 },
        },
      },
    },
  }, async (request) => {
    const user = getUser(request)
    const { appId, limit = 50 } = request.query as { appId?: string; limit?: number }

    const invocations = await withTenantContext(user.districtId, async (tx) => {
      return tx.toolInvocation.findMany({
        where: {
          ...(appId ? { appId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
    })

    return { invocations, total: invocations.length }
  })

  // GET /admin/queue-stats — Job queue monitoring
  server.get('/admin/queue-stats', {
    preHandler: [authenticate, requireRole('district_admin')],
  }, async () => {
    return getQueueStats()
  })

  // POST /admin/pre-warm — Pre-warm student sessions in a classroom
  server.post('/admin/pre-warm', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
  }, async (request) => {
    const { classroomId } = request.body as { classroomId: string }
    const user = getUser(request)
    const result = await preWarmClassroom(classroomId, user.districtId)
    return { classroomId, ...result }
  })
}
