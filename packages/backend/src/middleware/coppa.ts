/**
 * COPPA consent gate middleware (F3)
 *
 * Under-13 students (grade bands k2 and g35) MUST have parental consent
 * with status "granted" before accessing AI/chat/app routes.
 *
 * Teachers, admins, and students g68+ are not affected.
 */
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { JWTPayload } from '@chatbridge/shared'
import { withTenantContext } from './rls.js'

/** Grade bands that require parental consent (under-13) */
const COPPA_GRADE_BANDS = new Set(['k2', 'g35'])

/**
 * Fastify preHandler: enforce COPPA parental consent for under-13 students.
 * Must run AFTER `authenticate` (needs request.user).
 */
export async function requireCoppaConsent(request: FastifyRequest, reply: FastifyReply) {
  const user = (request as any).user as JWTPayload | undefined
  if (!user) {
    return reply.status(401).send({ error: 'Authentication required' })
  }

  // Only students in under-13 grade bands need consent
  if (user.role !== 'student') return
  if (!user.gradeBand || !COPPA_GRADE_BANDS.has(user.gradeBand)) return

  // Use withTenantContext to ensure RLS policy (district_id = app.tenant_id) is satisfied
  // within a single transaction — avoids connection-pool races with setTenantContext
  const consent = await withTenantContext(user.districtId, async (tx) => {
    return tx.parentalConsent.findUnique({
      where: { studentId: user.userId },
    })
  })

  if (!consent || consent.consentStatus !== 'granted') {
    const proto = (request.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() ?? request.protocol
    const host = String(request.headers.host ?? 'localhost:3001')
    const baseUrl = process.env.BASE_URL ?? `${proto}://${host}`
    return reply.status(403).send({
      error: 'parental_consent_required',
      message: 'Parental consent required for students under 13',
      consentUrl: `${baseUrl}/api/v1/consent/request`,
    })
  }
}
