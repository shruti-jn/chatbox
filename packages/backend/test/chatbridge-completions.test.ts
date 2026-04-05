import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { ownerPrisma } from '../src/middleware/rls.js'
import { ensureConversationForSession, listFallbackApps } from '../src/routes/chatbridge-completions.js'

describe('ChatBridge native completions fallback', () => {
  let districtId: string
  let studentId: string
  let classroomId: string

  beforeAll(async () => {
    const district = await ownerPrisma.district.create({
      data: { name: `ChatBridge Fallback ${Date.now()}` },
    })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'Fallback Teacher' },
    })

    const student = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Fallback Student', gradeBand: 'g68' },
    })
    studentId = student.id

    const classroom = await ownerPrisma.classroom.create({
      data: {
        districtId,
        teacherId: teacher.id,
        name: 'Fallback Classroom',
        joinCode: `FB${Date.now().toString().slice(-6)}`,
        gradeBand: 'g68',
        aiConfig: { mode: 'direct' },
      },
    })
    classroomId = classroom.id
  })

  afterAll(async () => {
    await ownerPrisma.$executeRawUnsafe(`DELETE FROM messages WHERE district_id = '${districtId}'`)
    await ownerPrisma.$executeRawUnsafe(`DELETE FROM app_instances WHERE district_id = '${districtId}'`)
    await ownerPrisma.$executeRawUnsafe(`DELETE FROM conversations WHERE district_id = '${districtId}'`)
    await ownerPrisma.$executeRawUnsafe(`DELETE FROM classrooms WHERE district_id = '${districtId}'`)
    await ownerPrisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id = '${districtId}'`)
    await ownerPrisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = '${districtId}'`)
  })

  it('creates a conversation row for a fresh local session id', async () => {
    const conversationId = crypto.randomUUID()

    const conversation = await ensureConversationForSession(conversationId, districtId, {
      userId: 'anonymous',
      role: 'student',
    })

    expect(conversation?.id).toBe(conversationId)
    expect(conversation?.districtId).toBe(districtId)
    expect(conversation?.classroomId).toBe(classroomId)
    expect(conversation?.studentId).toBe(studentId)
    expect(conversation?.title).toBe('Local Chat Session')
  })

  it('reuses the requested authenticated student when available', async () => {
    const conversationId = crypto.randomUUID()

    const conversation = await ensureConversationForSession(conversationId, districtId, {
      userId: studentId,
      role: 'student',
    })

    expect(conversation?.id).toBe(conversationId)
    expect(conversation?.studentId).toBe(studentId)
  })

  it('limits fallback app resolution to built-in approved apps', async () => {
    const apps = await listFallbackApps()
    const appIds = apps.map(app => app.appId)

    expect(appIds).toContain('00000000-0000-4000-e000-000000000001')
    expect(appIds).toContain('00000000-0000-4000-e000-000000000002')
    expect(appIds).toContain('00000000-0000-4000-e000-000000000003')
    expect(apps.every(app => app.app.reviewStatus === 'approved')).toBe(true)
  })
})
