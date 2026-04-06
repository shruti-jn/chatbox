import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'

import { authenticate, getUser, requireRole } from '../middleware/auth.js'
import { ownerPrisma, withTenantContext } from '../middleware/rls.js'

export async function consentRoutes(server: FastifyInstance) {
  server.post('/consent/request', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
    schema: {
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['studentId', 'parentEmail'],
        properties: {
          studentId: { type: 'string' },
          parentEmail: { type: 'string', format: 'email' },
        },
      },
    },
  }, async (request, reply) => {
    const { studentId, parentEmail } = request.body as { studentId: string; parentEmail: string }
    const user = getUser(request)
    const parentEmailHash = crypto.createHash('sha256').update(parentEmail.toLowerCase()).digest('hex')
    const token = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000)
    const proto = (request.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() ?? request.protocol
    const host = String(request.headers.host ?? 'localhost:3001')
    const baseUrl = process.env.BASE_URL ?? `${proto}://${host}`
    const verifyUrl = `${baseUrl}/api/v1/consent/verify?token=${token}`

    await withTenantContext(user.districtId, async (tx) => {
      await tx.parentalConsent.upsert({
        where: { studentId },
        update: {
          parentEmailHash,
          consentStatus: 'pending',
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

      await tx.user.update({
        where: { id: studentId },
        data: { consentStatus: 'pending' },
      })

      await tx.emailOutbox.create({
        data: {
          districtId: user.districtId,
          recipientHash: parentEmailHash,
          templateId: 'coppa_consent_request',
          payload: {
            verifyUrl,
            expiresAt: expiresAt.toISOString(),
          },
        },
      })
    })

    request.log.info({
      consentVerifyUrl: verifyUrl,
      expiresAt: expiresAt.toISOString(),
      studentId,
    }, 'COPPA consent email queued')

    return { status: 'consent_request_sent', studentId }
  })

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

    const consent = await ownerPrisma.parentalConsent.findFirst({
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

    await ownerPrisma.$transaction(async (tx) => {
      await tx.parentalConsent.update({
        where: { id: consent.id },
        data: {
          consentStatus: 'granted',
          consentDate: new Date(),
          consentToken: null,
          tokenExpiresAt: null,
        },
      })

      await tx.user.update({
        where: { id: consent.studentId },
        data: { consentStatus: 'granted' },
      })
    })

    return { status: 'consent_granted', studentId: consent.studentId }
  })

  server.post('/consent/delete-request', {
    preHandler: [authenticate, requireRole('teacher', 'district_admin')],
    schema: {
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['studentId', 'reason'],
        properties: {
          studentId: { type: 'string' },
          reason: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  }, async (request) => {
    const { studentId, reason } = request.body as { studentId: string; reason: string }
    const user = getUser(request)
    const scheduledDeleteBy = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    const deleteRequest = await withTenantContext(user.districtId, async (tx) => {
      const created = await tx.dataDeletionRequest.create({
        data: {
          studentId,
          districtId: user.districtId,
          requestedBy: user.role === 'district_admin' ? 'district_admin' : 'parent',
          reason,
          scheduledDeleteBy,
        },
      })

      await tx.user.update({
        where: { id: studentId },
        data: { deletionScheduledAt: scheduledDeleteBy },
      })

      return created
    })

    return {
      status: 'deletion_request_accepted',
      deleteRequestId: deleteRequest.id,
      scheduledDate: scheduledDeleteBy.toISOString(),
      message: 'Data will be deleted within 30 days',
    }
  })
}
