/**
 * Consent Routes Tests — SHR-116 (TASK-CONSENT-001)
 *
 * Tests:
 * 1. Under-13 student blocked without consent (403 + consentUrl)
 * 2. Over-13 student not blocked
 * 3. POST /consent/request creates token + queues email
 * 4. GET /consent/verify with valid token grants consent
 * 5. GET /consent/verify with expired token returns 410
 * 6. POST /consent/delete-request creates record with 30-day deadline
 * 7. Under-13 student WITH consent can access chat
 * 8. Verify URL contains no PII (tokenized link only)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'
import type { FastifyInstance } from 'fastify'

describe('Consent Routes', () => {
  let server: FastifyInstance
  let districtId: string
  let teacherId: string
  let under13StudentId: string
  let over13StudentId: string
  let classroomId: string
  let conversationId: string
  let teacherToken: string
  let under13Token: string
  let over13Token: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    const district = await ownerPrisma.district.create({ data: { name: 'Consent Test District' } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'Consent Teacher' },
    })
    teacherId = teacher.id
    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })

    const under13 = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Young Student', gradeBand: 'k2' },
    })
    under13StudentId = under13.id
    under13Token = signJWT({ userId: under13.id, role: 'student', districtId, gradeBand: 'k2' })

    const over13 = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Older Student', gradeBand: 'g68' },
    })
    over13StudentId = over13.id
    over13Token = signJWT({ userId: over13.id, role: 'student', districtId, gradeBand: 'g68' })

    const classroom = await ownerPrisma.classroom.create({
      data: {
        districtId, teacherId, name: 'Consent Test Class',
        joinCode: 'CONS01', gradeBand: 'g68', aiConfig: { mode: 'direct' },
      },
    })
    classroomId = classroom.id

    const conversation = await ownerPrisma.conversation.create({
      data: { districtId, classroomId, studentId: under13StudentId },
    })
    conversationId = conversation.id
  })

  afterAll(async () => {
    try {
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM email_outbox WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM data_deletion_requests WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM parental_consents WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM messages WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM conversations WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM classrooms WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = '${districtId}'`)
    } catch { /* Best effort cleanup */ }
    await server.close()
  })

  // A1: Under-13 gate
  it('under-13 student blocked without consent (403)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${under13Token}` },
      payload: { text: 'Hello' },
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('parental_consent_required')
    expect(body.consentUrl).toContain('/api/v1/consent/request')
  })

  // Over-13 not blocked
  it('over-13 student not blocked by COPPA gate', async () => {
    // Create a conversation for the over-13 student
    const conv = await ownerPrisma.conversation.create({
      data: { districtId, classroomId, studentId: over13StudentId },
    })

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${over13Token}` },
      payload: { text: 'Hello' },
    })
    // Should not be 403 — over-13 bypasses COPPA
    expect(res.statusCode).not.toBe(403)
  })

  // A2: POST /consent/request
  let consentToken: string

  it('POST /consent/request creates token and queues email', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/consent/request',
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { studentId: under13StudentId, parentEmail: 'parent@example.com' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('consent_request_sent')

    // Verify token created in DB
    const consent = await ownerPrisma.parentalConsent.findUnique({
      where: { studentId: under13StudentId },
    })
    expect(consent).not.toBeNull()
    expect(consent!.consentToken).toBeDefined()
    expect(consent!.tokenExpiresAt).toBeDefined()
    expect(consent!.consentStatus).toBe('pending')

    // Token expires within 48h
    const expiresIn = consent!.tokenExpiresAt!.getTime() - Date.now()
    expect(expiresIn).toBeGreaterThan(0)
    expect(expiresIn).toBeLessThanOrEqual(48 * 60 * 60 * 1000 + 5000) // 48h + 5s tolerance

    consentToken = consent!.consentToken!

    // Verify email queued in outbox
    const outbox = await ownerPrisma.emailOutbox.findFirst({
      where: { districtId, templateId: 'coppa_consent_request' },
    })
    expect(outbox).not.toBeNull()
    expect(outbox!.recipientHash).toBeDefined()
    expect(outbox!.recipientHash).not.toContain('@') // No PII — hash only
    const payload = outbox!.payload as Record<string, unknown>
    expect(payload.verifyUrl).toContain('/consent/verify?token=')
    expect(payload.verifyUrl).not.toContain(under13StudentId)
    expect(payload.studentId).toBeUndefined()
  })

  // A2 supplement: verify URL contains no PII
  it('consent verification URL contains no PII (tokenized only)', async () => {
    const consent = await ownerPrisma.parentalConsent.findUnique({
      where: { studentId: under13StudentId },
    })
    const outbox = await ownerPrisma.emailOutbox.findFirst({
      where: { districtId, templateId: 'coppa_consent_request' },
    })
    const payload = outbox!.payload as Record<string, unknown>
    const verifyUrl = payload.verifyUrl as string

    // URL must not contain email, student name, or district name
    expect(verifyUrl).not.toContain('parent@example.com')
    expect(verifyUrl).not.toContain('Young Student')
    // URL must contain the token (UUID format)
    expect(verifyUrl).toContain(consent!.consentToken!)
  })

  // A3: GET /consent/verify — valid token
  it('GET /consent/verify with valid token grants consent', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/consent/verify?token=${consentToken}`,
    })

    if (res.statusCode !== 200) {
      console.error('Verify failed:', res.statusCode, res.body, 'token:', consentToken)
    }
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('consent_granted')
    expect(body.studentId).toBe(under13StudentId)

    // Verify DB updated
    const consent = await ownerPrisma.parentalConsent.findUnique({
      where: { studentId: under13StudentId },
    })
    const student = await ownerPrisma.user.findUnique({
      where: { id: under13StudentId },
    })
    expect(consent!.consentStatus).toBe('granted')
    expect(consent!.consentDate).not.toBeNull()
    expect(consent!.consentToken).toBeNull() // Token cleared after use
    expect(student!.consentStatus).toBe('granted')
  })

  // A3: expired token
  it('GET /consent/verify with expired token returns 410', async () => {
    // Create a consent with an already-expired token
    const expiredStudent = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Expired Student', gradeBand: 'k2' },
    })
    await ownerPrisma.parentalConsent.create({
      data: {
        studentId: expiredStudent.id,
        districtId,
        parentEmailHash: 'abc123',
        consentStatus: 'pending',
        consentToken: '00000000-0000-0000-0000-000000000099',
        tokenExpiresAt: new Date(Date.now() - 1000), // Already expired
      },
    })

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/consent/verify?token=00000000-0000-0000-0000-000000000099',
    })

    expect(res.statusCode).toBe(410)
  })

  // A1 continued: under-13 WITH consent can access chat
  it('under-13 student WITH consent can access chat', async () => {
    // Consent was granted in the previous test
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${under13Token}` },
      payload: { text: 'Now I have consent' },
    })

    // Should not be 403 anymore
    expect(res.statusCode).not.toBe(403)
  })

  // A4: POST /consent/delete-request
  it('POST /consent/delete-request creates record with 30-day deadline', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/consent/delete-request',
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { studentId: under13StudentId, reason: 'parent_request' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('deletion_request_accepted')
    expect(body.deleteRequestId).toBeDefined()
    expect(body.scheduledDate).toBeDefined()

    // Verify scheduled date is within 30 days
    const scheduled = new Date(body.scheduledDate)
    const daysUntil = (scheduled.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    expect(daysUntil).toBeGreaterThan(29)
    expect(daysUntil).toBeLessThanOrEqual(31)

    // Verify DB record
    const req = await ownerPrisma.dataDeletionRequest.findFirst({
      where: { studentId: under13StudentId },
    })
    const student = await ownerPrisma.user.findUnique({
      where: { id: under13StudentId },
    })
    expect(req).not.toBeNull()
    expect(req!.status).toBe('pending')
    expect(req!.scheduledDeleteBy).not.toBeNull()
    expect(req!.reason).toBe('parent_request')
    expect(student!.deletionScheduledAt).not.toBeNull()
  })
})
