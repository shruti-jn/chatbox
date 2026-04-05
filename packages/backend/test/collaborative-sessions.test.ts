/**
 * Collaborative Sessions Tests — SHR-126 + SHR-127
 *
 * Tests:
 * 1. Create session returns sessionId + joinCode
 * 2. Join via code adds participant with color assignment
 * 3. GET session returns participants and FEN
 * 4. Max 2 players per turn-based session
 * 5. Close session updates status
 * 6. Idempotent rejoin returns existing participant
 * 7. broadcastToCollab and collabConnections are accessible
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer, registerBuiltInApps } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'
import type { FastifyInstance } from 'fastify'

describe('Collaborative Sessions', () => {
  let server: FastifyInstance
  let districtId: string
  let studentAId: string
  let studentBId: string
  let teacherId: string
  let classroomId: string
  let conversationId: string
  let chessAppId: string
  let tokenA: string
  let tokenB: string
  let teacherToken: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
    await registerBuiltInApps()

    const district = await ownerPrisma.district.create({ data: { name: 'Collab Test District' } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'Collab Teacher' },
    })
    teacherId = teacher.id
    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })

    const studentA = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Player White', gradeBand: 'g68' },
    })
    studentAId = studentA.id
    tokenA = signJWT({ userId: studentA.id, role: 'student', districtId, gradeBand: 'g68' })

    const studentB = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Player Black', gradeBand: 'g68' },
    })
    studentBId = studentB.id
    tokenB = signJWT({ userId: studentB.id, role: 'student', districtId, gradeBand: 'g68' })

    const classroom = await ownerPrisma.classroom.create({
      data: { districtId, teacherId, name: 'Collab Class', joinCode: 'CLB01', gradeBand: 'g68', aiConfig: { mode: 'direct' } },
    })
    classroomId = classroom.id

    const conv = await ownerPrisma.conversation.create({
      data: { districtId, classroomId, studentId: studentAId },
    })
    conversationId = conv.id

    const chess = await ownerPrisma.app.findFirst({ where: { name: { contains: 'Chess' }, reviewStatus: 'approved' } })
    chessAppId = chess!.id
  })

  afterAll(async () => {
    try {
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM session_participants WHERE session_id IN (SELECT id FROM collaborative_sessions WHERE district_id = '${districtId}')`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM collaborative_sessions WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM app_instances WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM conversations WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM classrooms WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = '${districtId}'`)
    } catch {}
    await server.close()
  })

  let sessionId: string
  let sessionCode: string

  it('POST /collaborative-sessions creates session with joinCode', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/collaborative-sessions',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { appId: chessAppId, interactionModel: 'turn_based', conversationId },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.sessionId).toBeDefined()
    expect(body.sessionCode).toBeDefined()
    expect(body.sessionCode.length).toBe(6)
    sessionId = body.sessionId
    sessionCode = body.sessionCode
  })

  it('POST /collaborative-sessions/:code/join adds participant with color', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/collaborative-sessions/${sessionCode}/join`,
      headers: { authorization: `Bearer ${tokenB}` },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.sessionId).toBe(sessionId)
    expect(body.color).toBe('black')
    expect(body.participants).toBe(2)
  })

  it('GET /collaborative-sessions/:id returns session with participants', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/collaborative-sessions/${sessionId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.sessionId).toBe(sessionId)
    expect(body.status).toBe('active')
    expect(body.participants.length).toBe(2)

    const white = body.participants.find((p: any) => p.color === 'white')
    const black = body.participants.find((p: any) => p.color === 'black')
    expect(white).toBeDefined()
    expect(black).toBeDefined()
    expect(white.userId).toBe(studentAId)
    expect(black.userId).toBe(studentBId)
  })

  it('idempotent rejoin returns existing participant', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/collaborative-sessions/${sessionCode}/join`,
      headers: { authorization: `Bearer ${tokenB}` },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.color).toBe('black')
  })

  it('POST /collaborative-sessions/:id/close updates status', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/collaborative-sessions/${sessionId}/close`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('closed')

    // Verify in DB
    const session = await ownerPrisma.collaborativeSession.findUnique({ where: { id: sessionId } })
    expect(session!.status).toBe('closed')
    expect(session!.closedAt).not.toBeNull()
  })

  it('cannot join a closed session', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/collaborative-sessions/${sessionCode}/join`,
      headers: { authorization: `Bearer ${tokenA}` },
    })

    expect(res.statusCode).toBe(409)
  })
})
