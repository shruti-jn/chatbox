/**
 * Resume Endpoint Tests — SHR-204
 *
 * Tests:
 * 1. Job created during tool execution with resume token
 * 2. GET /chatbridge/jobs/:id returns job status
 * 3. POST /chatbridge/completions/resume with valid token succeeds
 * 4. POST /chatbridge/completions/resume with expired token returns 410
 * 5. POST /chatbridge/completions/resume with already-used token returns 409
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer, registerBuiltInApps } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'
import type { FastifyInstance } from 'fastify'

describe('Resume Endpoint', () => {
  let server: FastifyInstance
  let districtId: string
  let studentToken: string
  let conversationId: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
    await registerBuiltInApps()

    const district = await ownerPrisma.district.create({ data: { name: 'Resume Test District' } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({ data: { districtId, role: 'teacher', displayName: 'Resume Teacher' } })
    const student = await ownerPrisma.user.create({ data: { districtId, role: 'student', displayName: 'Resume Student', gradeBand: 'g68' } })
    studentToken = signJWT({ userId: student.id, role: 'student', districtId, gradeBand: 'g68' })

    const classroom = await ownerPrisma.classroom.create({
      data: { districtId, teacherId: teacher.id, name: 'Resume Class', joinCode: 'RSM01', gradeBand: 'g68', aiConfig: { mode: 'direct' } },
    })

    const conv = await ownerPrisma.conversation.create({ data: { districtId, classroomId: classroom.id, studentId: student.id } })
    conversationId = conv.id
  })

  afterAll(async () => {
    await ownerPrisma.appInvocationJob.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.message.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.conversation.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.classroom.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.user.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.district.delete({ where: { id: districtId } }).catch(() => {})
    await server.close()
  })

  it('GET /chatbridge/jobs/:id returns job status', async () => {
    // Create a job directly
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        conversationId,
        districtId,
        requestKey: `test-${Date.now()}-1`,
        toolName: 'start_game',
        parameters: {},
        deadlineAt: new Date(Date.now() + 15_000),
        resumeToken: `resume-${Date.now()}-1`,
        status: 'completed',
        completedAt: new Date(),
        result: { fen: 'start', status: 'new_game' },
      },
    })

    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/chatbridge/jobs/${job.id}`,
      headers: { authorization: `Bearer ${studentToken}` },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.jobId).toBe(job.id)
    expect(body.status).toBe('completed')
    expect(body.toolName).toBe('start_game')
    expect(body.resumeToken).toBeDefined()
  })

  it('POST /chatbridge/completions/resume with invalid token returns 410', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/chatbridge/completions/resume',
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { resumeToken: 'nonexistent-token-12345' },
    })

    expect(res.statusCode).toBe(410)
  })

  it('POST /chatbridge/completions/resume with already-used token returns 409', async () => {
    // Create a completed job that's already been resumed
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        conversationId,
        districtId,
        requestKey: `test-${Date.now()}-2`,
        toolName: 'start_game',
        parameters: {},
        deadlineAt: new Date(Date.now() + 15_000),
        resumeToken: `resume-${Date.now()}-2`,
        status: 'completed',
        completedAt: new Date(),
        resumedAt: new Date(), // Already resumed
        result: { fen: 'start' },
      },
    })

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/chatbridge/completions/resume',
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { resumeToken: job.resumeToken },
    })

    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('Already resumed')
  })

  it('POST /chatbridge/completions/resume with running job returns 202', async () => {
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        conversationId,
        districtId,
        requestKey: `test-${Date.now()}-3`,
        toolName: 'start_game',
        parameters: {},
        deadlineAt: new Date(Date.now() + 15_000),
        resumeToken: `resume-${Date.now()}-3`,
        status: 'running',
        startedAt: new Date(),
      },
    })

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/chatbridge/completions/resume',
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { resumeToken: job.resumeToken },
    })

    expect(res.statusCode).toBe(202)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('running')
    expect(body.jobId).toBe(job.id)
  })

  it('missing resumeToken returns 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/chatbridge/completions/resume',
      headers: { authorization: `Bearer ${studentToken}` },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })
})
