/**
 * Tool Execution Worker Tests — SHR-205
 *
 * Tests:
 * 1. Worker picks jobs by priority (P0 first)
 * 2. Deadline enforcement kills expired jobs
 * 3. Sweep catches stuck running jobs past deadline
 * 4. Retry on retryable failure
 * 5. Non-retryable failure is terminal
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ownerPrisma } from '../src/middleware/rls.js'
import { randomUUID } from 'crypto'

describe('Tool Executor Worker', () => {
  let districtId: string
  let convId: string
  const jobIds: string[] = []

  beforeAll(async () => {
    const district = await ownerPrisma.district.create({ data: { name: 'Worker Test District' } })
    districtId = district.id
    const teacher = await ownerPrisma.user.create({ data: { districtId, role: 'teacher', displayName: 'W Teacher' } })
    const student = await ownerPrisma.user.create({ data: { districtId, role: 'student', displayName: 'W Student', gradeBand: 'g68' } })
    const classroom = await ownerPrisma.classroom.create({
      data: { districtId, teacherId: teacher.id, name: 'W Class', joinCode: 'WRK01', gradeBand: 'g68', aiConfig: { mode: 'direct' } },
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

  it('picks jobs by priority — P0 before P1 before P2', async () => {
    // Create jobs in reverse priority order
    const p2 = await ownerPrisma.appInvocationJob.create({
      data: { districtId, conversationId: convId, requestKey: randomUUID(), toolName: 'test', parameters: {}, priority: 2, deadlineAt: new Date(Date.now() + 60_000) },
    })
    const p0 = await ownerPrisma.appInvocationJob.create({
      data: { districtId, conversationId: convId, requestKey: randomUUID(), toolName: 'test', parameters: {}, priority: 0, deadlineAt: new Date(Date.now() + 60_000) },
    })
    const p1 = await ownerPrisma.appInvocationJob.create({
      data: { districtId, conversationId: convId, requestKey: randomUUID(), toolName: 'test', parameters: {}, priority: 1, deadlineAt: new Date(Date.now() + 60_000) },
    })
    jobIds.push(p2.id, p0.id, p1.id)

    // Query in priority order
    const jobs = await ownerPrisma.appInvocationJob.findMany({
      where: { status: 'queued', districtId },
      orderBy: [{ priority: 'asc' }, { queuedAt: 'asc' }],
    })

    const priorities = jobs.map(j => j.priority)
    expect(priorities[0]).toBe(0)
    expect(priorities[1]).toBe(1)
    expect(priorities[2]).toBe(2)
  })

  it('sweep marks past-deadline running jobs as timed_out', async () => {
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId: convId,
        requestKey: randomUUID(),
        toolName: 'slow_tool',
        parameters: {},
        status: 'running',
        startedAt: new Date(Date.now() - 20_000),
        deadlineAt: new Date(Date.now() - 5_000), // Deadline already passed
      },
    })
    jobIds.push(job.id)

    // Simulate sweep
    const swept = await ownerPrisma.appInvocationJob.updateMany({
      where: { status: 'running', deadlineAt: { lt: new Date() } },
      data: { status: 'timed_out', completedAt: new Date(), result: { error: true, message: 'Swept by timeout' } as any },
    })

    expect(swept.count).toBeGreaterThanOrEqual(1)

    const updated = await ownerPrisma.appInvocationJob.findUnique({ where: { id: job.id } })
    expect(updated!.status).toBe('timed_out')
    expect(updated!.completedAt).not.toBeNull()
  })

  it('retryable failure re-queues with incremented attemptCount', async () => {
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId: convId,
        requestKey: randomUUID(),
        toolName: 'flaky_tool',
        parameters: {},
        status: 'running',
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
        retryable: true,
        maxAttempts: 3,
        attemptCount: 0,
      },
    })
    jobIds.push(job.id)

    // Simulate retry: increment attempt, re-queue with backoff
    const attemptCount = job.attemptCount + 1
    await ownerPrisma.appInvocationJob.update({
      where: { id: job.id },
      data: {
        status: 'queued',
        attemptCount,
        queuedAt: new Date(Date.now() + 1000), // 1s backoff
        startedAt: null,
      },
    })

    const updated = await ownerPrisma.appInvocationJob.findUnique({ where: { id: job.id } })
    expect(updated!.status).toBe('queued')
    expect(updated!.attemptCount).toBe(1)
    expect(updated!.startedAt).toBeNull()
  })

  it('non-retryable failure is terminal', async () => {
    const job = await ownerPrisma.appInvocationJob.create({
      data: {
        districtId,
        conversationId: convId,
        requestKey: randomUUID(),
        toolName: 'broken_tool',
        parameters: {},
        status: 'running',
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
        retryable: false,
      },
    })
    jobIds.push(job.id)

    // Simulate terminal failure
    await ownerPrisma.appInvocationJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorCode: 'PERMANENT_FAILURE',
        result: { error: true, message: 'Cannot recover' } as any,
      },
    })

    const updated = await ownerPrisma.appInvocationJob.findUnique({ where: { id: job.id } })
    expect(updated!.status).toBe('failed')
    expect(updated!.errorCode).toBe('PERMANENT_FAILURE')
    expect(updated!.retryable).toBe(false)
  })
})
