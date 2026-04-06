/**
 * AppInvocationJob Tests — SHR-203
 *
 * Tests:
 * 1. Job created with correct fields
 * 2. Job result stored as JSONB
 * 3. Failed job records error code
 * 4. Timed-out job records synthesized failure
 * 5. Request key uniqueness enforced
 * 6. Priority and status indexes work
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ownerPrisma } from '../src/middleware/rls.js'
import { randomUUID } from 'crypto'

describe('AppInvocationJob Model', () => {
  let districtId: string
  let convId: string
  const jobIds: string[] = []

  beforeAll(async () => {
    const district = await ownerPrisma.district.create({ data: { name: 'Job Test District' } })
    districtId = district.id
    const teacher = await ownerPrisma.user.create({ data: { districtId, role: 'teacher', displayName: 'Job Teacher' } })
    const student = await ownerPrisma.user.create({ data: { districtId, role: 'student', displayName: 'Job Student', gradeBand: 'g68' } })
    const classroom = await ownerPrisma.classroom.create({
      data: { districtId, teacherId: teacher.id, name: 'Job Class', joinCode: 'JOB01', gradeBand: 'g68', aiConfig: { mode: 'direct' } },
    })
    const conv = await ownerPrisma.conversation.create({ data: { districtId, classroomId: classroom.id, studentId: student.id } })
    convId = conv.id
  })

  afterAll(async () => {
    for (const id of jobIds) {
      await ownerPrisma.appInvocationJob.delete({ where: { id } }).catch(() => {})
    }
    await ownerPrisma.conversation.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.classroom.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.user.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.district.delete({ where: { id: districtId } }).catch(() => {})
  })

  it('creates a job with correct fields', async () => {
    const requestKey = randomUUID()
    const deadline = new Date(Date.now() + 15_000)

    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId: convId,
        requestKey,
        toolName: 'start_game',
        parameters: { mode: 'student_vs_computer' },
        priority: 0,
        deadlineAt: deadline,
        resumeToken: randomUUID(),
      },
    })
    jobIds.push(job.id)

    expect(job.status).toBe('queued')
    expect(job.toolName).toBe('start_game')
    expect(job.requestKey).toBe(requestKey)
    expect(job.priority).toBe(0)
    expect(job.attemptCount).toBe(0)
    expect(job.maxAttempts).toBe(3)
    expect(job.retryable).toBe(true)
    expect(job.deadlineAt.getTime()).toBeCloseTo(deadline.getTime(), -2)
  })

  it('stores result as JSONB after completion', async () => {
    const requestKey = randomUUID()
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId: convId,
        requestKey,
        toolName: 'start_game',
        parameters: {},
        deadlineAt: new Date(Date.now() + 15_000),
      },
    })
    jobIds.push(job.id)

    await ownerPrisma.appInvocationJob.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        startedAt: new Date(Date.now() - 2000),
        completedAt: new Date(),
        attemptCount: 1,
        result: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', status: 'new_game' },
      },
    })

    const updated = await ownerPrisma.appInvocationJob.findUnique({ where: { id: job.id } })
    expect(updated!.status).toBe('completed')
    expect(updated!.completedAt).not.toBeNull()
    expect(updated!.attemptCount).toBe(1)
    const result = updated!.result as Record<string, unknown>
    expect(result.fen).toContain('rnbqkbnr')
    expect(result.status).toBe('new_game')
  })

  it('records error on failed job', async () => {
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId: convId,
        requestKey: randomUUID(),
        toolName: 'get_weather',
        parameters: { location: 'Mars' },
        deadlineAt: new Date(Date.now() + 15_000),
      },
    })
    jobIds.push(job.id)

    await ownerPrisma.appInvocationJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        errorCode: 'ECONNREFUSED',
        retryable: true,
        completedAt: new Date(),
        result: { error: true, message: 'Weather service unavailable' },
      },
    })

    const updated = await ownerPrisma.appInvocationJob.findUnique({ where: { id: job.id } })
    expect(updated!.status).toBe('failed')
    expect(updated!.errorCode).toBe('ECONNREFUSED')
    expect(updated!.retryable).toBe(true)
  })

  it('records timed_out with synthesized failure', async () => {
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId: convId,
        requestKey: randomUUID(),
        toolName: 'search_tracks',
        parameters: { query: 'study music' },
        deadlineAt: new Date(Date.now() - 1000), // Already past deadline
      },
    })
    jobIds.push(job.id)

    await ownerPrisma.appInvocationJob.update({
      where: { id: job.id },
      data: {
        status: 'timed_out',
        completedAt: new Date(),
        result: { error: true, message: 'The app did not respond in time.' },
      },
    })

    const updated = await ownerPrisma.appInvocationJob.findUnique({ where: { id: job.id } })
    expect(updated!.status).toBe('timed_out')
    const result = updated!.result as Record<string, unknown>
    expect(result.message).toContain('did not respond')
  })

  it('enforces unique request key', async () => {
    const requestKey = randomUUID()
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId: convId,
        requestKey,
        toolName: 'start_game',
        parameters: {},
        deadlineAt: new Date(Date.now() + 15_000),
      },
    })
    jobIds.push(job.id)

    await expect(
      ownerPrisma.appInvocationJob.create({
        data: {
          districtId,
          conversationId: convId,
          requestKey, // Same key — should fail with unique constraint violation
          toolName: 'start_game',
          parameters: {},
          deadlineAt: new Date(Date.now() + 15_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('queries by status + priority + queuedAt (index coverage)', async () => {
    // Create jobs with different priorities
    for (const priority of [2, 0, 1]) {
      const job = await ownerPrisma.appInvocationJob.create({
        data: {
          districtId,
          conversationId: convId,
          requestKey: randomUUID(),
          toolName: 'test_tool',
          parameters: {},
          priority,
          deadlineAt: new Date(Date.now() + 15_000),
        },
      })
      jobIds.push(job.id)
    }

    // Query: queued jobs sorted by priority ASC, then queuedAt ASC
    const queued = await ownerPrisma.appInvocationJob.findMany({
      where: { status: 'queued', districtId },
      orderBy: [{ priority: 'asc' }, { queuedAt: 'asc' }],
    })

    // P0 should come first
    const priorities = queued.map(j => j.priority)
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i]).toBeGreaterThanOrEqual(priorities[i - 1])
    }
  })
})
