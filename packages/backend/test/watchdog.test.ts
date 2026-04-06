/**
 * Watchdog Tests — SHR-210
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ownerPrisma } from '../src/middleware/rls.js'
import { sweepStaleHeartbeats, sweepExpiredSessions, getDeadLetterCount } from '../src/workers/watchdog.js'
import { randomUUID } from 'crypto'

describe('Watchdog Sweepers', () => {
  let districtId: string
  let convId: string
  let appId: string

  beforeAll(async () => {
    const d = await ownerPrisma.district.create({ data: { name: 'Watchdog Test' } })
    districtId = d.id
    const t = await ownerPrisma.user.create({ data: { districtId, role: 'teacher', displayName: 'WT' } })
    const s = await ownerPrisma.user.create({ data: { districtId, role: 'student', displayName: 'WS', gradeBand: 'g68' } })
    const cls = await ownerPrisma.classroom.create({
      data: { districtId, teacherId: t.id, name: 'WC', joinCode: 'WDG01', gradeBand: 'g68', aiConfig: {} },
    })
    const conv = await ownerPrisma.conversation.create({ data: { districtId, classroomId: cls.id, studentId: s.id } })
    convId = conv.id
    const app = await ownerPrisma.app.findFirst({ where: { reviewStatus: 'approved' } })
    appId = app!.id
  })

  afterAll(async () => {
    await ownerPrisma.appInstance.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.appInvocationJob.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.conversation.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.classroom.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.user.deleteMany({ where: { districtId } }).catch(() => {})
    await ownerPrisma.district.delete({ where: { id: districtId } }).catch(() => {})
  })

  it('marks active instances with stale heartbeat as error', async () => {
    const instance = await ownerPrisma.appInstance.create({
      data: {
        appId, conversationId: convId, districtId,
        status: 'active',
        lastHeartbeatAt: new Date(Date.now() - 90_000), // 90s ago (> 60s threshold)
      },
    })

    const result = await sweepStaleHeartbeats()
    expect(result.unresponsive).toBeGreaterThanOrEqual(1)

    const updated = await ownerPrisma.appInstance.findUnique({ where: { id: instance.id } })
    expect(updated!.status).toBe('error')

    await ownerPrisma.appInstance.delete({ where: { id: instance.id } })
  })

  it('terminates error instances with very stale heartbeat', async () => {
    const instance = await ownerPrisma.appInstance.create({
      data: {
        appId, conversationId: convId, districtId,
        status: 'error',
        lastHeartbeatAt: new Date(Date.now() - 6 * 60_000), // 6 min ago (> 5 min threshold)
      },
    })

    const result = await sweepStaleHeartbeats()
    expect(result.terminated).toBeGreaterThanOrEqual(1)

    const updated = await ownerPrisma.appInstance.findUnique({ where: { id: instance.id } })
    expect(updated!.status).toBe('terminated')
    expect(updated!.terminatedAt).not.toBeNull()

    await ownerPrisma.appInstance.delete({ where: { id: instance.id } })
  })

  it('terminates active instances older than 8 hours', async () => {
    const instance = await ownerPrisma.appInstance.create({
      data: {
        appId, conversationId: convId, districtId,
        status: 'active',
      },
    })
    // Backdate updatedAt to 9 hours ago
    await ownerPrisma.$executeRawUnsafe(
      `UPDATE app_instances SET updated_at = NOW() - INTERVAL '9 hours' WHERE id = $1`,
      instance.id,
    )

    const result = await sweepExpiredSessions()
    expect(result.terminated).toBeGreaterThanOrEqual(1)

    const updated = await ownerPrisma.appInstance.findUnique({ where: { id: instance.id } })
    expect(updated!.status).toBe('terminated')

    await ownerPrisma.appInstance.delete({ where: { id: instance.id } })
  })

  it('does not terminate instances within TTL', async () => {
    const instance = await ownerPrisma.appInstance.create({
      data: {
        appId, conversationId: convId, districtId,
        status: 'active',
      },
    })

    const result = await sweepExpiredSessions()
    // This fresh instance should NOT be terminated
    const updated = await ownerPrisma.appInstance.findUnique({ where: { id: instance.id } })
    expect(updated!.status).toBe('active')

    await ownerPrisma.appInstance.delete({ where: { id: instance.id } })
  })

  it('dead-letter count returns non-retryable failed jobs', async () => {
    await ownerPrisma.appInvocationJob.create({
      data: {
        districtId, conversationId: convId, requestKey: randomUUID(),
        toolName: 'dead_tool', parameters: {},
        status: 'failed', retryable: false,
        deadlineAt: new Date(),
        errorCode: 'PERMANENT',
      },
    })

    const count = await getDeadLetterCount()
    expect(count).toBeGreaterThanOrEqual(1)
  })

  it('sweepers handle empty state gracefully', async () => {
    // Clean slate — no instances or jobs to sweep
    await ownerPrisma.appInstance.deleteMany({ where: { districtId } })
    await ownerPrisma.appInvocationJob.deleteMany({ where: { districtId } })

    const heartbeat = await sweepStaleHeartbeats()
    expect(heartbeat.unresponsive).toBe(0)
    expect(heartbeat.terminated).toBe(0)

    const session = await sweepExpiredSessions()
    expect(session.terminated).toBe(0)
  })
})
