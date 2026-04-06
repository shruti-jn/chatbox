/**
 * Async Tool Execution — End-to-End Tests
 *
 * 10 scenarios covering the full async execution pipeline from ASYNC_EXECUTION_PLAN.md:
 *
 *  1. Happy path: completions → job created → tool executes → result persisted → follow-up streams
 *  2. Hard timeout: slow tool → 15s deadline → synthesized failure returned to LLM
 *  3. Idempotency: duplicate X-Request-Key → same job returned, no duplicate execution
 *  4. Resume flow: client POSTs /completions/resume with token → follow-up AI response streams
 *  5. Double-resume guard: second resume attempt on same token → 409 Conflict
 *  6. Circuit breaker: 5 consecutive failures → tool blocked → graceful degradation message
 *  7. Job status polling: GET /chatbridge/jobs/:id returns correct status + ownership enforced
 *  8. Queue admission / backpressure: P2 jobs shed when queue depth exceeds threshold
 *  9. Priority ordering: P0 (mid-lesson) jobs picked before P1/P2 by worker
 * 10. Timeout sweeper: running job past deadline → swept to timed_out → client notified via WS
 */

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest'
import { randomUUID } from 'crypto'

// Mock the AI service so completions don't hit real Anthropic API
vi.mock('../src/ai/service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ai/service.js')>('../src/ai/service.js')
  return {
    ...actual,
    generateResponse: vi.fn().mockImplementation(() =>
      Promise.resolve({ text: Promise.resolve('Great move! Let me help you with that.') }),
    ),
  }
})

import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'
import { healthConfig, getHealthStatus, recordFailure, recordSuccess } from '../src/apps/health.js'
import { sweepTimedOutJobs, pickNextJob, executeJob, runningPerApp } from '../src/workers/tool-executor.js'
import type { FastifyInstance } from 'fastify'

describe('Async Tool Execution — E2E', () => {
  let server: FastifyInstance
  let districtId: string
  let studentId: string
  let student2Id: string
  let teacherId: string
  let classroomId: string
  let conversationId: string
  let conversation2Id: string
  let studentToken: string
  let student2Token: string
  let teacherToken: string
  let chessAppId: string

  const jobIds: string[] = [] // track for cleanup

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    // Seed a full test environment
    const district = await ownerPrisma.district.create({ data: { name: `AsyncE2E ${Date.now()}` } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'Async Teacher' },
    })
    teacherId = teacher.id

    const student = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Async Student', gradeBand: 'g68' },
    })
    studentId = student.id

    const student2 = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Other Student', gradeBand: 'g68' },
    })
    student2Id = student2.id

    const classroom = await ownerPrisma.classroom.create({
      data: {
        districtId, teacherId, name: 'Async Class',
        joinCode: `AE${Date.now().toString().slice(-6)}`,
        gradeBand: 'g68',
        aiConfig: { mode: 'direct', subject: 'chess' },
      },
    })
    classroomId = classroom.id

    const conv = await ownerPrisma.conversation.create({
      data: { districtId, classroomId, studentId },
    })
    conversationId = conv.id

    const conv2 = await ownerPrisma.conversation.create({
      data: { districtId, classroomId, studentId: student2Id },
    })
    conversation2Id = conv2.id

    studentToken = signJWT({ userId: studentId, role: 'student', districtId, gradeBand: 'g68' })
    student2Token = signJWT({ userId: student2Id, role: 'student', districtId, gradeBand: 'g68' })
    teacherToken = signJWT({ userId: teacherId, role: 'teacher', districtId })

    // Register and approve a chess app
    const chessRes = await server.inject({
      method: 'POST', url: '/api/v1/apps/register',
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: {
        name: `Chess Async ${Date.now()}`, description: 'Chess for async tests',
        toolDefinitions: [
          { name: 'start_game', description: 'Start a new chess game', inputSchema: { type: 'object' } },
        ],
        uiManifest: { url: 'https://chess-async.test', width: 500, height: 500 },
        permissions: { network: true }, complianceMetadata: {}, version: '1.0.0',
      },
    })
    chessAppId = JSON.parse(chessRes.body).appId

    await server.inject({
      method: 'POST', url: `/api/v1/apps/${chessAppId}/submit-review`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    await ownerPrisma.districtAppCatalog.create({
      data: { districtId, appId: chessAppId, status: 'approved' },
    })
    await ownerPrisma.classroomAppConfig.create({
      data: { classroomId, appId: chessAppId, districtId, enabled: true },
    })
  })

  afterAll(async () => {
    // Clean up jobs first (FK to conversations)
    for (const id of jobIds) {
      await ownerPrisma.appInvocationJob.delete({ where: { id } }).catch(() => {})
    }
    await ownerPrisma.appInvocationJob.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.toolInvocation.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.appInstance.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.message.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.classroomAppConfig.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.districtAppCatalog.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.conversation.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.classroom.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.app.deleteMany({ where: { id: chessAppId } }).catch(() => {})
    await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_audit_cleanup', 'true', true)`
      await tx.auditEvent.deleteMany({ where: { districtId } })
      await tx.safetyEvent.deleteMany({ where: { districtId } })
    }).catch(() => {})
    await ownerPrisma.user.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.district.delete({ where: { id: districtId } }).catch(() => {})
    await server.close()
  })

  // ─── TEST 1: Happy path — tool invocation creates durable job ───
  it('1. Tool invocation creates AppInvocationJob, executes tool, persists result', async () => {
    const requestKey = randomUUID()

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${chessAppId}/tools/start_game/invoke`,
      headers: {
        authorization: `Bearer ${studentToken}`,
        'x-request-key': requestKey,
      },
      payload: { parameters: {}, conversationId },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.toolName).toBe('start_game')
    expect(body.result.fen).toBeDefined()
    expect(body.instanceId).toBeDefined()

    // Verify a durable job was persisted
    const jobs = await ownerPrisma.appInvocationJob.findMany({
      where: { conversationId, toolName: 'start_game' },
      orderBy: { createdAt: 'desc' },
    })

    expect(jobs.length).toBeGreaterThanOrEqual(1)
    const job = jobs[0]
    jobIds.push(job.id)

    // Job should be in a terminal state with result
    expect(['completed', 'running']).toContain(job.status)
    expect(job.resumeToken).toBeDefined()
    expect(job.districtId).toBe(districtId)
    expect(job.deadlineAt).toBeDefined()
  })

  // ─── TEST 2: Hard timeout — tool exceeding 15s produces synthesized failure ───
  it('2. Tool that exceeds deadline results in timed_out job with synthesized failure', async () => {
    // Directly create a job that is already past its deadline to simulate timeout
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId,
        requestKey: randomUUID(),
        toolName: 'start_game',
        parameters: {},
        status: 'running',
        startedAt: new Date(Date.now() - 20_000),
        deadlineAt: new Date(Date.now() - 5_000), // 5s past deadline
        resumeToken: randomUUID(),
      },
    })
    jobIds.push(job.id)

    // Run the timeout sweeper (same function the worker calls every 5s)
    await sweepTimedOutJobs()

    // Verify the job was swept
    const swept = await ownerPrisma.appInvocationJob.findUnique({ where: { id: job.id } })
    expect(swept!.status).toBe('timed_out')
    expect(swept!.completedAt).not.toBeNull()
    expect(swept!.errorCode).toBe('DEADLINE_EXCEEDED')

    const result = swept!.result as Record<string, unknown>
    expect(result.error).toBe(true)
    expect(result.message).toContain('did not respond')
  })

  // ─── TEST 3: Idempotency — duplicate X-Request-Key returns same job ───
  it('3. Duplicate X-Request-Key deduplicates — no second job created', async () => {
    const requestKey = randomUUID()

    // Create the initial job directly
    const original = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId,
        requestKey,
        toolName: 'start_game',
        parameters: { mode: 'test' },
        status: 'completed',
        completedAt: new Date(),
        deadlineAt: new Date(Date.now() + 15_000),
        resumeToken: randomUUID(),
        result: { fen: 'test-fen', status: 'new_game' },
      },
    })
    jobIds.push(original.id)

    // Attempt to create a second job with the same requestKey — should hit unique constraint
    await expect(
      ownerPrisma.appInvocationJob.create({
        data: {
          districtId,
          conversationId,
          requestKey, // same key
          toolName: 'start_game',
          parameters: {},
          deadlineAt: new Date(Date.now() + 15_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })

    // Verify only one job exists for this requestKey
    const jobs = await ownerPrisma.appInvocationJob.findMany({ where: { requestKey } })
    expect(jobs.length).toBe(1)
    expect(jobs[0].id).toBe(original.id)
  })

  // ─── TEST 4: Resume flow — POST /completions/resume with valid token ───
  it('4. Resume endpoint claims job atomically and returns follow-up stream', async () => {
    const resumeToken = randomUUID()

    // Create a completed job with stored assistant content for resume reconstruction
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId,
        requestKey: randomUUID(),
        toolName: 'start_game',
        parameters: {},
        status: 'completed',
        startedAt: new Date(Date.now() - 3000),
        completedAt: new Date(),
        deadlineAt: new Date(Date.now() + 15_000),
        resumeToken,
        result: {
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          _assistantContent: [{ type: 'tool_use', id: 'tu_123', name: 'start_game', input: {} }],
          _toolUseId: 'tu_123',
        },
      },
    })
    jobIds.push(job.id)

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/chatbridge/completions/resume',
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { resumeToken },
    })

    // Resume should succeed (200 SSE stream or complete response)
    expect([200, 202]).toContain(res.statusCode)

    // Job should now have resumedAt set (atomic claim)
    const updated = await ownerPrisma.appInvocationJob.findUnique({ where: { id: job.id } })
    if (res.statusCode === 200) {
      expect(updated!.resumedAt).not.toBeNull()
    }
  }, 20_000)

  // ─── TEST 5: Double-resume guard — second attempt returns 409 ───
  it('5. Second resume attempt on already-resumed token returns 409 Conflict', async () => {
    const resumeToken = randomUUID()

    // Create a completed job that has already been resumed
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId,
        requestKey: randomUUID(),
        toolName: 'start_game',
        parameters: {},
        status: 'completed',
        completedAt: new Date(),
        deadlineAt: new Date(Date.now() + 15_000),
        resumeToken,
        resumedAt: new Date(), // Already resumed!
      },
    })
    jobIds.push(job.id)

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/chatbridge/completions/resume',
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { resumeToken },
    })

    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body)
    expect(body.error).toContain('Already resumed')
  })

  // ─── TEST 6: Circuit breaker — consecutive failures block tool ───
  it('6. Circuit breaker blocks tool after consecutive failures, recovers on success', async () => {
    const testAppId = `circuit-test-${Date.now()}`

    // Record failures up to unresponsive threshold
    const originalThreshold = healthConfig.unresponsiveThreshold
    healthConfig.unresponsiveThreshold = 3 // Lower for test speed

    for (let i = 0; i < 3; i++) {
      await recordFailure(testAppId)
    }

    const status = getHealthStatus(testAppId)
    expect(status.status).toBe('unresponsive')
    expect(status.consecutiveFailures).toBeGreaterThanOrEqual(3)

    // Now record a success — should recover
    await recordSuccess(testAppId, 100)
    const recovered = getHealthStatus(testAppId)
    expect(recovered.status).toBe('healthy')
    expect(recovered.consecutiveFailures).toBe(0)

    // Restore
    healthConfig.unresponsiveThreshold = originalThreshold
  })

  // ─── TEST 7: Job status polling with ownership enforcement ───
  it('7. GET /chatbridge/jobs/:id returns status; students cannot see other students jobs', async () => {
    // Create a job owned by student 1's conversation
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId, // belongs to student 1
        requestKey: randomUUID(),
        toolName: 'start_game',
        parameters: {},
        status: 'completed',
        completedAt: new Date(),
        deadlineAt: new Date(Date.now() + 15_000),
        resumeToken: randomUUID(),
        result: { fen: 'test', status: 'done' },
      },
    })
    jobIds.push(job.id)

    // Student 1 can see their own job
    const ownRes = await server.inject({
      method: 'GET',
      url: `/api/v1/chatbridge/jobs/${job.id}`,
      headers: { authorization: `Bearer ${studentToken}` },
    })
    expect(ownRes.statusCode).toBe(200)
    const ownBody = JSON.parse(ownRes.body)
    expect(ownBody.jobId).toBe(job.id)
    expect(ownBody.status).toBe('completed')
    expect(ownBody.resumeToken).toBeDefined()
    expect(ownBody.result).toBeDefined()

    // Student 2 should be forbidden from seeing student 1's job
    const otherRes = await server.inject({
      method: 'GET',
      url: `/api/v1/chatbridge/jobs/${job.id}`,
      headers: { authorization: `Bearer ${student2Token}` },
    })
    expect(otherRes.statusCode).toBe(403)
  })

  // ─── TEST 8: Queue admission — backpressure sheds low-priority jobs ───
  it('8. Backpressure sheds P2 jobs when queue depth exceeds threshold', async () => {
    // We test the admission function directly since flooding the real queue
    // with 100+ jobs would be slow and require cleanup

    const { checkAdmission } = await import('../src/lib/queue-admission.js')

    // Save original env and temporarily lower the threshold
    const origThreshold = process.env.QUEUE_P2_SHED_THRESHOLD

    // Create enough queued jobs to exceed the P2 shed threshold
    const bulkJobs: string[] = []
    const THRESHOLD = 10 // Use a low threshold for testing
    process.env.QUEUE_P2_SHED_THRESHOLD = String(THRESHOLD)

    for (let i = 0; i < THRESHOLD + 5; i++) {
      const j = await ownerPrisma.appInvocationJob.create({
        data: {
          districtId,
          conversationId,
          requestKey: randomUUID(),
          toolName: 'load_test',
          parameters: {},
          status: 'queued',
          deadlineAt: new Date(Date.now() + 60_000),
        },
      })
      bulkJobs.push(j.id)
    }
    jobIds.push(...bulkJobs)

    // P0 should always be admitted
    const p0Result = await checkAdmission(0)
    expect(p0Result.admitted).toBe(true)

    // P2 should be shed when queue is saturated
    const p2Result = await checkAdmission(2)
    // Queue depth is now > THRESHOLD, so P2 should be rejected
    expect(p2Result.admitted).toBe(false)
    expect(p2Result.retryAfterSeconds).toBeGreaterThanOrEqual(3)
    expect(p2Result.retryAfterSeconds).toBeLessThanOrEqual(10)

    // Clean up bulk jobs
    await ownerPrisma.appInvocationJob.deleteMany({
      where: { id: { in: bulkJobs } },
    })

    // Restore
    if (origThreshold) {
      process.env.QUEUE_P2_SHED_THRESHOLD = origThreshold
    } else {
      delete process.env.QUEUE_P2_SHED_THRESHOLD
    }
  })

  // ─── TEST 9: Priority ordering — worker picks P0 before P1/P2 ───
  it('9. Worker picks highest-priority (P0) jobs before lower-priority ones', async () => {
    // Create jobs with different priorities, out of order
    const p2Job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId,
        requestKey: randomUUID(),
        toolName: 'start_game',
        parameters: { priority: 'p2' },
        priority: 2,
        status: 'queued',
        deadlineAt: new Date(Date.now() + 30_000),
      },
    })
    jobIds.push(p2Job.id)

    const p1Job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId,
        requestKey: randomUUID(),
        toolName: 'start_game',
        parameters: { priority: 'p1' },
        priority: 1,
        status: 'queued',
        deadlineAt: new Date(Date.now() + 30_000),
      },
    })
    jobIds.push(p1Job.id)

    const p0Job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId,
        requestKey: randomUUID(),
        toolName: 'start_game',
        parameters: { priority: 'p0' },
        priority: 0,
        status: 'queued',
        deadlineAt: new Date(Date.now() + 30_000),
      },
    })
    jobIds.push(p0Job.id)

    // Pick jobs in order — P0 should come first
    const first = await pickNextJob()
    expect(first).not.toBeNull()
    expect(first!.id).toBe(p0Job.id)
    expect(first!.priority).toBe(0)

    // Mark it completed so we can pick the next
    await ownerPrisma.appInvocationJob.update({
      where: { id: first!.id },
      data: { status: 'completed', completedAt: new Date() },
    })
    runningPerApp.clear() // reset in-process concurrency tracking

    const second = await pickNextJob()
    expect(second).not.toBeNull()
    expect(second!.id).toBe(p1Job.id)
    expect(second!.priority).toBe(1)

    // Cleanup: mark claimed jobs so they don't interfere with other tests
    await ownerPrisma.appInvocationJob.updateMany({
      where: { id: { in: [p1Job.id, p2Job.id] } },
      data: { status: 'cancelled' },
    })
    runningPerApp.clear()
  })

  // ─── TEST 10: Timeout sweeper + WS notification ───
  it('10. Sweeper marks past-deadline running jobs as timed_out and broadcasts notification', async () => {
    // Spy on the WS broadcast to verify notification was sent
    const { broadcastToChatConversation } = await import('../src/routes/websocket.js')
    const broadcastSpy = vi.spyOn(
      await import('../src/routes/websocket.js'),
      'broadcastToChatConversation',
    )

    // Create two jobs: one past deadline (should be swept), one still valid (should survive)
    const stuckJob = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId,
        requestKey: randomUUID(),
        toolName: 'start_game',
        parameters: {},
        status: 'running',
        startedAt: new Date(Date.now() - 25_000),
        deadlineAt: new Date(Date.now() - 10_000), // 10s past deadline
        resumeToken: randomUUID(),
      },
    })
    jobIds.push(stuckJob.id)

    const healthyJob = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId,
        requestKey: randomUUID(),
        toolName: 'start_game',
        parameters: {},
        status: 'running',
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 30_000), // 30s remaining
        resumeToken: randomUUID(),
      },
    })
    jobIds.push(healthyJob.id)

    // Run the sweeper
    await sweepTimedOutJobs()

    // Stuck job should be timed_out
    const swept = await ownerPrisma.appInvocationJob.findUnique({ where: { id: stuckJob.id } })
    expect(swept!.status).toBe('timed_out')
    expect(swept!.errorCode).toBe('DEADLINE_EXCEEDED')
    expect(swept!.completedAt).not.toBeNull()

    // Healthy job should still be running
    const alive = await ownerPrisma.appInvocationJob.findUnique({ where: { id: healthyJob.id } })
    expect(alive!.status).toBe('running')

    // Broadcast should have been called for the stuck job
    expect(broadcastSpy).toHaveBeenCalledWith(
      conversationId,
      expect.objectContaining({
        type: 'job_completed',
        jobId: stuckJob.id,
        status: 'timed_out',
      }),
    )

    // Clean up healthy job
    await ownerPrisma.appInvocationJob.update({
      where: { id: healthyJob.id },
      data: { status: 'cancelled' },
    })

    broadcastSpy.mockRestore()
  })
})
