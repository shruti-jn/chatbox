import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole, getUser } from '../middleware/auth.js'
import { withTenantContext } from '../middleware/rls.js'

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
}
