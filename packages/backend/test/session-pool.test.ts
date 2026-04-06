/**
 * Warm Session Pool Tests — SHR-208
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer, registerBuiltInApps } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'
import { getCachedContext, preWarmClassroom, isCacheHit } from '../src/lib/session-pool.js'
import type { FastifyInstance } from 'fastify'

describe('Warm Session Pool', () => {
  let server: FastifyInstance
  let districtId: string
  let teacherToken: string
  let classroomId: string
  let convId: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    const district = await ownerPrisma.district.create({ data: { name: 'Pool Test' } })
    districtId = district.id
    const teacher = await ownerPrisma.user.create({ data: { districtId, role: 'teacher', displayName: 'Pool Teacher' } })
    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })
    const student = await ownerPrisma.user.create({ data: { districtId, role: 'student', displayName: 'Pool Student', gradeBand: 'g68' } })
    const cls = await ownerPrisma.classroom.create({
      data: { districtId, teacherId: teacher.id, name: 'Pool Class', joinCode: 'POL01', gradeBand: 'g68', aiConfig: { mode: 'direct' } },
    })
    classroomId = cls.id
    await ownerPrisma.classroomMembership.create({ data: { classroomId, studentId: student.id, districtId } })
    const conv = await ownerPrisma.conversation.create({ data: { districtId, classroomId, studentId: student.id } })
    convId = conv.id
    await ownerPrisma.message.create({
      data: { conversationId: convId, districtId, authorRole: 'student', contentParts: [{ type: 'text', text: 'Hello' }] },
    })
  })

  afterAll(async () => {
    await ownerPrisma.message.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.classroomMembership.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.conversation.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.classroom.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.user.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.district.delete({ where: { id: districtId } }).catch(() => {})
    await server.close()
  })

  it('pre-warm populates Redis cache for classroom', async () => {
    const result = await preWarmClassroom(classroomId, districtId)
    expect(result.warmed).toBeGreaterThanOrEqual(1)
    expect(result.errors).toBe(0)
  })

  it('getCachedContext returns cached data after pre-warm', async () => {
    const cached = await getCachedContext(convId)
    expect(cached).not.toBeNull()
    expect(cached!.recentMessages.length).toBeGreaterThanOrEqual(1)
    expect(cached!.cachedAt).toBeDefined()
  })

  it('isCacheHit returns true for warmed conversation', async () => {
    const hit = await isCacheHit(convId)
    expect(hit).toBe(true)
  })

  it('isCacheHit returns false for non-warmed conversation', async () => {
    const hit = await isCacheHit('nonexistent-conv-id')
    expect(hit).toBe(false)
  })

  it('POST /admin/pre-warm returns warmed count', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/pre-warm',
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { classroomId },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.warmed).toBeGreaterThanOrEqual(1)
    expect(body.classroomId).toBe(classroomId)
  })
})
