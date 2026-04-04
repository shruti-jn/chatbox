import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole, getUser } from '../middleware/auth.js'
import { prisma, withTenantContext } from '../middleware/rls.js'

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

  // POST /consent/request — Parental consent request
  server.post('/consent/request', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
  }, async (request, reply) => {
    const { studentId, parentEmail } = request.body as { studentId: string; parentEmail: string }
    const user = getUser(request)

    const crypto = await import('crypto')
    const parentEmailHash = crypto.createHash('sha256').update(parentEmail.toLowerCase()).digest('hex')

    // Generate consent verification token (UUID) with 48h expiration
    const token = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000) // 48 hours

    await withTenantContext(user.districtId, async (tx) => {
      await tx.parentalConsent.upsert({
        where: { studentId },
        update: {
          parentEmailHash,
          consentToken: token,
          tokenExpiresAt: expiresAt,
        },
        create: {
          studentId,
          districtId: user.districtId,
          parentEmailHash,
          consentStatus: 'pending',
          consentToken: token,
          tokenExpiresAt: expiresAt,
        },
      })
    })

    // STUB: Email sending would go here.
    // In production, send an email to the parent with a link containing the token:
    //   `${BASE_URL}/consent/verify?token=${token}`
    // This is an external API call (e.g. SendGrid, SES) — stubbed per L-079.

    // COPPA: Do NOT return token in response — it must only travel via parent's email
    return { status: 'consent_request_sent', studentId }
  })

  // GET /consent/verify — Verify parental consent via token
  server.get('/consent/verify', {
    schema: {
      querystring: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { token } = request.query as { token: string }

    // Find consent record by token (no auth required — parent clicks email link)
    const consent = await prisma.parentalConsent.findFirst({
      where: { consentToken: token },
    })

    if (!consent) {
      return reply.status(404).send({ error: 'Invalid or expired consent token' })
    }

    if (consent.tokenExpiresAt && consent.tokenExpiresAt < new Date()) {
      return reply.status(410).send({ error: 'Consent token has expired. Please request a new one.' })
    }

    if (consent.consentStatus === 'granted') {
      return { status: 'already_granted', studentId: consent.studentId }
    }

    // Grant consent
    await prisma.parentalConsent.update({
      where: { id: consent.id },
      data: {
        consentStatus: 'granted',
        consentDate: new Date(),
        consentToken: null,
        tokenExpiresAt: null,
      },
    })

    return { status: 'consent_granted', studentId: consent.studentId }
  })

  // POST /consent/delete-request — Data deletion request
  server.post('/consent/delete-request', {
    preHandler: [authenticate],
  }, async (request) => {
    const { studentId } = request.body as { studentId: string }
    const user = getUser(request)

    await withTenantContext(user.districtId, async (tx) => {
      await tx.dataDeletionRequest.create({
        data: {
          studentId,
          districtId: user.districtId,
          requestedBy: user.role === 'district_admin' ? 'district_admin' : 'parent',
        },
      })
    })

    return { status: 'deletion_request_accepted', message: 'Data will be deleted within 30 days' }
  })
}
